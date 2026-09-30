import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('local test keeps Stop available if input enumeration fails after capture starts', async ({
  page,
}) => {
  await page.route('**/api/local-test/status', (route) =>
    route.fulfill({ json: { ready: true, model: 'synthetic-test' } }),
  );
  await page.route('**/api/local-test/transcribe', (route) =>
    route.fulfill({ json: { text: 'Synthetic audio fixture', processingMs: 1 } }),
  );
  await page.addInitScript(() => {
    let acquired = false;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        acquired = true;
        (window as unknown as { __localStream: MediaStream }).__localStream = destination.stream;
        return destination.stream;
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: async () => {
        if (acquired) throw new Error('Synthetic device-list failure');
        return [];
      },
    });
  });
  await page.goto('/local-test');
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __localStream: MediaStream }).__localStream.getTracks()[0]
          .readyState,
    ),
  ).toBe('live');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Test complete. Microphone is off.', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as { __localStream: MediaStream }).__localStream
        .getTracks()
        .every((track) => track.readyState === 'ended'),
    ),
  ).toBe(true);
});

async function startDemo(page: Page) {
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await expect(page.getByTestId('transcript-entry').first()).toBeVisible();
  await expect.poll(() => page.getByTestId('transcript-entry').count()).toBeGreaterThan(1);
}

test.beforeEach(async ({ page }) => {
  // A regression from fixture playback into device capture must fail visibly.
  await page.addInitScript(() => {
    const counters = window as typeof window & { __captureRequests: number };
    counters.__captureRequests = 0;
    for (const method of ['getUserMedia', 'getDisplayMedia'] as const) {
      Object.defineProperty(navigator.mediaDevices, method, {
        configurable: true,
        value: async () => {
          counters.__captureRequests += 1;
          throw new Error('Real capture is forbidden in demo browser tests.');
        },
      });
    }
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Try demo', exact: true })).toBeEnabled();
});

test.afterEach(async ({ page }) => {
  expect(
    await page.evaluate(
      () => (window as typeof window & { __captureRequests: number }).__captureRequests,
    ),
  ).toBe(0);
});

test('remembered API key controls save, reload without exposing the key, and remove', async ({
  page,
}) => {
  let saved = false;
  let active = false;
  const requests: Array<{ apiKey: string; remember: boolean }> = [];
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        hasApiKey: active,
        keyStorage: { canRemember: true, saved },
      },
    });
  });
  await page.route('**/api/key', async (route) => {
    const payload = route.request().postDataJSON();
    requests.push(payload);
    active = Boolean(payload.apiKey);
    saved = active && payload.remember;
    await route.fulfill({ json: { hasApiKey: active, keyStorage: { canRemember: true, saved } } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Remember API key on this device')).toBeChecked();
  await page.getByLabel('OpenAI API key', { exact: true }).fill('sk-synthetic-ui-test-key');
  await page.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect(page.getByText('API key saved on this device', { exact: true })).toBeVisible();
  expect(requests[0]).toEqual({ apiKey: 'sk-synthetic-ui-test-key', remember: true });
  await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('sk-synthetic');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('API key saved on this device', { exact: true })).toBeVisible();
  await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Remove API key', exact: true }).click();
  await expect(page.getByText('No API key added', { exact: true })).toBeVisible();
  expect(requests[1]).toEqual({ apiKey: '', remember: false });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('No API key added', { exact: true })).toBeVisible();
});

test('live two-channel capture filters microphone echoes in the transcript and exported JSON', async ({
  page,
}) => {
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), hasApiKey: true } });
  });
  await page.routeWebSocket(/\/api\/realtime\?/, (socket) => {
    socket.onMessage((message) => {
      const event = JSON.parse(message.toString());
      if (event.type === 'configure') socket.send(JSON.stringify({ type: 'ready' }));
      if (event.type === 'input_audio_buffer.commit') {
        socket.send(
          JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'synthetic-echo' }),
        );
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'synthetic-echo',
            transcript: 'The delivery time is two weeks.',
          }),
        );
      }
    });
  });
  await page.addInitScript(() => {
    const gains: GainNode[] = [];
    (window as unknown as { __echoGains: GainNode[] }).__echoGains = gains;
    const syntheticStream = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator(),
        gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = 0.25;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await context.resume();
      gains.push(gain);
      return destination.stream;
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: syntheticStream,
    });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: syntheticStream,
    });
  });
  await page.reload();
  await page.getByLabel('Everyone knows about transcription.').check();
  await page.getByRole('button', { name: 'Start call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'End call', exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      page.getByRole('meter', { name: 'Microphone level' }).getAttribute('aria-valuenow'),
    )
    .not.toBe('0');
  await expect
    .poll(async () => page.getByRole('meter', { name: 'Call level' }).getAttribute('aria-valuenow'))
    .not.toBe('0');
  await page.evaluate(() => {
    for (const gain of (window as unknown as { __echoGains: GainNode[] }).__echoGains)
      gain.gain.value = 0;
  });
  await expect(page.getByText(/^Matching microphone echo was filtered/)).toBeVisible();
  await expect(page.getByTestId('transcript-entry')).toHaveCount(1);
  await expect(page.getByTestId('transcript-entry')).toContainText('Other speaker');
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await page.getByLabel('Export session', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Session as JSON', exact: true }).click();
  const path = await (await download).path();
  const exported = JSON.parse(await readFile(path!, 'utf8'));
  expect(exported.transcript).toHaveLength(1);
  expect(exported.transcript[0]).toMatchObject({ source: 'system', speaker: 'Other speaker' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Filter microphone echo duplicates').uncheck();
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.getByTestId('transcript-entry')).toHaveCount(2);
});

test('demo produces a transcript and answers typed questions and F8 without a key', async ({
  page,
}) => {
  await startDemo(page);
  const question = 'What specific follow-up question should I ask now?';
  await page.getByLabel('Your question', { exact: true }).fill(question);
  const manualRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/answer') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  const payload = (await manualRequest).postDataJSON();
  expect(payload).toMatchObject({ question, mode: 'manual', demo: true });
  expect(payload.transcript.length).toBeGreaterThan(1);
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Suggest answer/ })).toBeEnabled();

  const keyboardRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/answer') && request.method() === 'POST',
  );
  await page.keyboard.press('F8');
  expect((await keyboardRequest).postDataJSON()).toMatchObject({ mode: 'manual', demo: true });
  await expect(page.getByText('1 previous suggestions', { exact: true })).toBeVisible();
});

test('automatic mode requests a contextual demo suggestion', async ({ page }) => {
  await page.getByLabel('Automatic hints', { exact: true }).check();
  const automaticRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/answer') &&
      request.method() === 'POST' &&
      request.postDataJSON().mode === 'auto',
  );
  await startDemo(page);
  const payload = (await automaticRequest).postDataJSON();
  expect(payload).toMatchObject({ mode: 'auto', demo: true });
  expect(payload.transcript.length).toBeGreaterThan(0);
  await expect(page.getByTestId('suggestion').first()).toBeVisible({ timeout: 12_000 });
});

test('edited prompts are used in answers and saved only when requested', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'System prompt', exact: true })
    .fill('Answer briefly and ask a follow-up question when facts are missing.');
  await page
    .getByRole('textbox', { name: 'Conversation context', exact: true })
    .fill('We are planning a two-week test with exactly three participants.');
  expect(await page.evaluate(() => localStorage.getItem('callside.settings.v1'))).toBeNull();
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await startDemo(page);
  const answerRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/answer') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: /^Suggest answer/ }).click();
  expect((await answerRequest).postDataJSON().settings).toMatchObject({
    systemPrompt: 'Answer briefly and ask a follow-up question when facts are missing.',
    context: 'We are planning a two-week test with exactly three participants.',
  });
  const bootstrap = await page.request.get('/api/bootstrap');
  expect(await bootstrap.json()).toMatchObject({ hasApiKey: false });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const activeSession = page.getByRole('region', { name: 'Active session', exact: true });
  await expect(activeSession).toBeVisible();
  await expect(activeSession.getByRole('button', { name: 'End demo', exact: true })).toBeEnabled();
  await expect(page.getByText(/^Audio settings are locked during a session\./)).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Transcribe microphone', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Conversation context', exact: true }),
  ).toHaveValue('We are planning a two-week test with exactly three participants.');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Conversation context', exact: true }),
  ).toHaveValue('');
  expect(await page.evaluate(() => localStorage.getItem('callside.settings.v1'))).toBeNull();
});

test('exports contain the demo transcript and a new session clears it', async ({ page }) => {
  await startDemo(page);
  await page.getByLabel('Export session', { exact: true }).click();
  const downloadJson = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Session as JSON', exact: true }).click();
  const jsonFile = await downloadJson;
  expect(jsonFile.suggestedFilename()).toMatch(/\.json$/);
  const jsonPath = await jsonFile.path();
  expect(jsonPath).not.toBeNull();
  const serialized = await readFile(jsonPath!, 'utf8');
  const session = JSON.parse(serialized);
  expect(session.transcript.length).toBeGreaterThan(1);
  expect(session.transcript[0]).toMatchObject({
    text: expect.any(String),
    speaker: expect.any(String),
  });
  expect(serialized).not.toContain('apiKey');

  const downloadMarkdown = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Transcript as Markdown', exact: true }).click();
  const markdownFile = await downloadMarkdown;
  expect(markdownFile.suggestedFilename()).toMatch(/\.md$/);
  const markdownPath = await markdownFile.path();
  const markdown = await readFile(markdownPath!, 'utf8');
  expect(markdown).toContain(session.transcript[0].text);

  await page.getByRole('button', { name: 'End demo', exact: true }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await expect(page.getByTestId('transcript-entry')).toHaveCount(0);
  await expect(page.getByTestId('suggestion')).toHaveCount(0);
});

test('synthetic audio passes through the actual worklet and stopping releases the track', async ({
  page,
}) => {
  let audioPackets = 0;
  let commits = 0;
  await page.routeWebSocket(/\/api\/realtime\?/, (socket) => {
    socket.onMessage((message) => {
      const event = JSON.parse(message.toString());
      if (event.type === 'configure') socket.send(JSON.stringify({ type: 'ready' }));
      if (event.type === 'input_audio_buffer.append') {
        expect(Buffer.from(event.audio, 'base64').length).toBeGreaterThan(0);
        audioPackets++;
      }
      if (event.type === 'input_audio_buffer.commit') {
        const item_id = `synthetic-${++commits}`;
        socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id }));
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id,
            delta: 'Synthetic ',
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id,
            transcript: 'Synthetic audio test.',
          }),
        );
      }
    });
  });

  // Install WebSocket interception before the page loads its application modules.
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  await page.evaluate(async () => {
    // Exercise production audio modules with a browser-generated MediaStream.
    // No permission prompt, hardware, or provider connection is involved.
    const state = window as typeof window & {
      __audioTest: {
        entries: Array<{ text: string; final: boolean }>;
        errors: string[];
        track: MediaStreamTrack;
        ended: boolean;
        silence: () => void;
        stop: () => Promise<void>;
      };
    };
    const oscillatorContext = new AudioContext();
    const oscillator = oscillatorContext.createOscillator();
    const gain = oscillatorContext.createGain();
    const destination = oscillatorContext.createMediaStreamDestination();
    gain.gain.value = 0.25;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await oscillatorContext.resume();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => destination.stream,
    });
    const capturePath = '/src/audio/capture.ts';
    const defaultsPath = '/shared/defaults.ts';
    const { startCapture } = await import(capturePath);
    const { DEFAULT_SETTINGS } = await import(defaultsPath);
    const bootstrap = await (await fetch('/api/bootstrap')).json();
    const entries: Array<{ text: string; final: boolean }> = [];
    const errors: string[] = [];
    let ended = false;
    const handle = await startCapture(
      { ...DEFAULT_SETTINGS, captureMic: true, captureSystem: false },
      bootstrap.token,
      {
        onTranscript: (entry: { text: string; final: boolean }) => entries.push(entry),
        onLevel: () => undefined,
        onStatus: () => undefined,
        onError: (message: string) => errors.push(message),
        onEnded: () => {
          ended = true;
          if (state.__audioTest) state.__audioTest.ended = true;
        },
      },
    );
    state.__audioTest = {
      entries,
      errors,
      track: destination.stream.getAudioTracks()[0],
      ended,
      silence: () => {
        gain.gain.value = 0;
      },
      stop: async () => {
        await handle.stop();
        oscillator.stop();
        await oscillatorContext.close();
      },
    };
  });
  await expect.poll(() => audioPackets).toBeGreaterThan(3);
  await page.evaluate(() => (window as any).__audioTest.silence());
  await expect.poll(() => commits).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__audioTest.entries.some(
          (entry: { final: boolean; text: string }) =>
            entry.final && entry.text === 'Synthetic audio test.',
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).__audioTest.stop());
  const result = await page.evaluate(() => ({
    state: (window as any).__audioTest.track.readyState,
    ended: (window as any).__audioTest.ended,
    errors: (window as any).__audioTest.errors,
  }));
  expect(result).toEqual({ state: 'ended', ended: true, errors: [] });
});

test('GPT-6 controls restrict models, normalize Astra reasoning, and persist API settings', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const model = page.getByRole('combobox', { name: 'Answer model', exact: true });
  await expect(model.locator('option')).toHaveText(['GPT-6 Luna', 'GPT-6 Sol', 'GPT-6 Astra']);
  await model.selectOption('gpt-6-astra');
  const reasoning = page.getByRole('combobox', { name: 'Reasoning strength', exact: true });
  await expect(reasoning).toHaveValue('low');
  await expect(reasoning.locator('option')).toHaveText([
    'Low',
    'Medium',
    'High',
    'Extra high',
    'Maximum',
  ]);
  await reasoning.selectOption('high');
  await page.getByLabel('Fast mode', { exact: true }).check();
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await page.reload();
  await startDemo(page);
  const request = page.waitForRequest(
    (r) => r.url().endsWith('/api/answer') && r.method() === 'POST',
  );
  await page.getByRole('button', { name: /^Suggest answer/ }).click();
  expect((await request).postDataJSON().settings).toMatchObject({
    model: 'gpt-6-astra',
    reasoningEffort: 'high',
    fastMode: true,
  });
});
