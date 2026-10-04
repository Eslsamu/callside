import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { encodeWav } from '../src/audio/dsp';

test('local transcription is the default and runs without an API key or cloud audio', async ({
  page,
}) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({ json: { token: 'test', hasApiKey: false, models: [] } }),
  );
  await page.route('**/api/local/prepare', (route) =>
    route.fulfill({ json: { ready: true, model: 'fixture' } }),
  );
  await page.route('**/api/local/transcribe', (route) =>
    route.fulfill({ json: { text: 'A locally transcribed sentence.', processingMs: 12 } }),
  );
  await page.route('**/api/local-speakers/start', (route) =>
    route.fulfill({ json: { session: 'fixture' } }),
  );
  let speakerBatches = 0;
  await page.route('**/api/local-speakers/audio', (route) => {
    speakerBatches++;
    return route.fulfill({
      json: { from: 0, through: 60, segments: [{ start: 0, end: 60, speaker: 0 }] },
    });
  });
  const cloudAudio: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(realtime|diarize)/.test(request.url())) cloudAudio.push(request.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem('callside.settings.v1', JSON.stringify({ captureMic: false }));
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const c = new AudioContext(),
          o = c.createOscillator(),
          g = c.createGain(),
          d = c.createMediaStreamDestination();
        g.gain.value = 0.2;
        o.connect(g).connect(d);
        o.start();
        await c.resume();
        return d.stream;
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Transcription processing')).toHaveValue('local');
  await expect(page.getByLabel('Speaker labeling')).toHaveValue('local');
  await expect(
    page.getByLabel('Speaker labeling').locator('option[value="openai"]'),
  ).toHaveAttribute('disabled', '');
  await page.getByRole('button', { name: 'Use local audio + ChatGPT subscription' }).click();

  await page.getByLabel('Transcription processing').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/local-settings-qa.png' });
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.getByLabel('Everyone knows about transcription.').check();
  await page.getByRole('button', { name: 'Start call', exact: true }).click();
  await expect(page.getByTestId('transcript-entry').first()).toContainText(
    'A locally transcribed sentence.',
  );
  expect(cloudAudio).toEqual([]);
  await expect.poll(() => speakerBatches).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'End call', exact: true }).click();
});

test('comparison uploads once, renders both local models, and exports the report', async ({
  page,
}) => {
  await page.route('**/api/comparison/status', (route) =>
    route.fulfill({
      json: {
        ready: true,
        engines: [
          { id: 'whisper', model: 'test-whisper' },
          { id: 'cohere', model: 'test-cohere' },
        ],
      },
    }),
  );
  const metrics = {
    audioMs: 1000,
    wallMs: 1300,
    processingMs: 300,
    processingToAudioRatio: 0.3,
    firstTextMs: 900,
    medianFinalDelayMs: 600,
    p95FinalDelayMs: 600,
    maxQueueMs: 0,
    drainMs: 300,
    requests: 1,
    finalTurns: 1,
    wer: 0,
    wordErrors: 0,
    referenceWords: 2,
  };
  const report = {
    version: 1,
    createdAt: '2026-10-02T00:00:00.000Z',
    language: 'en',
    audioSha256: 'fixture',
    audioMs: 1000,
    reference: 'Test phrase',
    protocol: 'Synthetic browser test',
    hardware: {},
    results: ['whisper', 'cohere'].map((engine) => ({
      engine,
      model: `test-${engine}`,
      transcript: 'Test phrase',
      metrics,
      measurements: [],
    })),
  };
  let payload: Record<string, any> | undefined;
  await page.route('**/api/comparison/run', (route) => {
    payload = route.request().postDataJSON();
    const events = ['whisper', 'cohere'].flatMap((engine) => [
      { type: 'start', engine, model: `test-${engine}` },
      { type: 'turn', engine, id: 'turn-1', text: 'Test phrase', final: true },
      { type: 'done', engine, metrics },
    ]);
    return route.fulfill({
      contentType: 'text/event-stream',
      body: [...events, { type: 'complete', report }]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });
  await page.goto('/local-compare');
  await expect(page.getByRole('button', { name: 'Run comparison', exact: true })).toBeDisabled();
  await page.getByLabel('Upload WAV file').setInputFiles({
    name: 'test.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from(encodeWav(new Int16Array(16000), 16000)),
  });
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
  await page.getByLabel('Expected transcript', { exact: false }).fill('Test phrase');
  await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Comparison complete');
  await expect(page.getByRole('log')).toHaveCount(2);
  await expect(page.getByRole('log', { name: 'Cohere transcript', exact: true })).toContainText(
    'Test phrase',
  );
  await expect(page.getByRole('log', { name: 'Whisper transcript', exact: true })).toContainText(
    'Test phrase',
  );
  expect(payload?.language).toBe('en');
  expect(payload?.reference).toBe('Test phrase');
  expect(Buffer.from(payload?.audio, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download report', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('callside-transcription-benchmark-2026-10-02.json');
  expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(report);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.route('**/api/comparison/run', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"type":"start","engine":"whisper","model":"test-whisper"}\n\n',
    }),
  );
  await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('connection was interrupted');
  await expect(page.getByRole('button', { name: 'Download report', exact: true })).toBeDisabled();
});

test('comparison allows cancelling a pending microphone permission without retaining a late stream', async ({
  page,
}) => {
  await page.route('**/api/comparison/status', (route) =>
    route.fulfill({ json: { ready: true, engines: [] } }),
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () =>
        new Promise<MediaStream>((resolve) => {
          (window as any).__grantComparisonMic = () => {
            const context = new AudioContext();
            const destination = context.createMediaStreamDestination();
            (window as any).__comparisonStream = destination.stream;
            resolve(destination.stream);
            void context.close();
          };
        }),
    });
  });
  await page.goto('/local-compare');
  await page.getByRole('button', { name: 'Record audio', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel microphone', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel microphone', exact: true }).click();
  await page.evaluate(() => (window as any).__grantComparisonMic());
  await expect
    .poll(() => page.evaluate(() => (window as any).__comparisonStream.getTracks()[0].readyState))
    .toBe('ended');
  await expect(page.getByRole('status')).toContainText('Cancelled. Microphone is off.');
});

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
    localStorage.setItem(
      'callside.settings.v1',
      JSON.stringify({
        transcriptionProvider: 'openai',
        backgroundSpeakers: false,
        diarizationProvider: 'off',
      }),
    );
    (window as unknown as { __echoGains: GainNode[] }).__echoGains = gains;
    const syntheticStream = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator(),
        gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = 0;
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
  // Start both sources together after capture setup, independent of device startup time.
  await page.evaluate(() => {
    for (const gain of (window as unknown as { __echoGains: GainNode[] }).__echoGains)
      gain.gain.value = 0.25;
  });
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

test('background attribution updates live turns and answer context without duplicate automatic hints', async ({
  page,
}) => {
  const text = 'The launch is next week. What will the first test cost?';
  let releaseLabels: (() => void) | undefined;
  const labelGate = new Promise<void>((resolve) => {
    releaseLabels = resolve;
  });
  const answers: Array<Record<string, any>> = [];
  let batches = 0;
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), hasApiKey: true } });
  });
  await page.route('**/api/answer', async (route) => {
    answers.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"type":"delta","text":"Synthetic suggestion"}\n\ndata: {"type":"done"}\n\n',
    });
  });
  await page.route('**/api/diarize', async (route) => {
    const body = route.request().postDataJSON();
    batches++;
    if (batches !== 1) {
      await route.fulfill({ json: { entries: [] } });
      return;
    }
    await labelGate;
    await route.fulfill({
      json: {
        entries: [
          {
            speaker: 'A',
            text: 'The launch is next week.',
            timestamp: body.timestamp,
            endTimestamp: body.timestamp + 2000,
          },
          {
            speaker: 'B',
            text: 'What will the first test cost?',
            timestamp: body.timestamp + 2000,
            endTimestamp: body.timestamp + 4000,
          },
        ],
      },
    });
  });
  await page.routeWebSocket(/\/api\/realtime\?/, (socket) => {
    let partialSent = false;
    socket.onMessage((message) => {
      const event = JSON.parse(message.toString());
      if (event.type === 'configure') socket.send(JSON.stringify({ type: 'ready' }));
      if (event.type === 'input_audio_buffer.append' && !partialSent) {
        partialSent = true;
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: 'live-turn',
            delta: text,
          }),
        );
      }
      if (event.type === 'input_audio_buffer.commit') {
        socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'live-turn' }));
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'live-turn',
            transcript: text,
          }),
        );
      }
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'callside.settings.v1',
      JSON.stringify({
        captureMic: false,
        transcriptionProvider: 'openai',
        backgroundSpeakers: true,
        diarizationChunkSeconds: 4,
        autoCooldownMs: 3000,
      }),
    );
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator(),
          gain = context.createGain();
        const destination = context.createMediaStreamDestination();
        gain.gain.value = 0.25;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        await context.resume();
        (window as unknown as { __speakerGain: GainNode }).__speakerGain = gain;
        return destination.stream;
      },
    });
  });
  await page.reload();
  await page.getByLabel('Automatic hints', { exact: true }).check();
  await page.getByLabel('Everyone knows about transcription.').check();
  await page.getByRole('button', { name: 'Start call', exact: true }).click();
  await expect(page.getByTestId('transcript-entry')).toHaveCount(1);
  await expect(page.getByTestId('transcript-entry')).toContainText('Other speaker');
  await page.keyboard.press('F8');
  await expect.poll(() => answers.length).toBe(1);
  expect(answers[0].transcript[0].speaker).toBe('Other speaker');
  await expect.poll(() => batches, { timeout: 10000 }).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { __speakerGain: GainNode }).__speakerGain.gain.value = 0;
  });
  await expect.poll(() => answers.filter((answer) => answer.mode === 'auto').length).toBe(1);
  releaseLabels!();
  await expect(page.getByTestId('transcript-entry')).toHaveCount(2);
  await expect(page.getByTestId('transcript-entry').nth(0)).toContainText('Speaker 1');
  await expect(page.getByTestId('transcript-entry').nth(1)).toContainText('Speaker 2');
  await expect(page.getByTestId('speaker-attribution-status')).toContainText(
    'Speaker labels updated',
  );
  await page.waitForTimeout(1000); // More than the automatic trigger delay after a label revision.
  expect(answers.filter((answer) => answer.mode === 'auto')).toHaveLength(1);
  await page.keyboard.press('F8');
  await expect.poll(() => answers.length).toBe(3);
  expect(answers[2].transcript.map((entry: any) => entry.speaker)).toEqual([
    'Speaker 1',
    'Speaker 2',
  ]);
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start call', exact: true })).toBeEnabled();
  await page.getByLabel('Export session', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Session as JSON', exact: true }).click();
  const exported = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(exported.transcript.map((entry: any) => entry.text).join(' ')).toBe(text);
  expect(new Set(exported.transcript.map((entry: any) => entry.turnId))).toEqual(
    new Set(['system:live-turn']),
  );
  expect(exported.speakerAttribution.enabled).toBe(true);
  expect(JSON.stringify(exported)).not.toMatch(/knownSpeakers|data:audio|"audio"/);
});

test('demo produces a transcript and answers typed questions and F8 without a key', async ({
  page,
}) => {
  await startDemo(page);
  const question = 'What specific follow-up question should I ask now?';
  await expect(page.getByLabel('Command', { exact: true })).not.toBeVisible();
  await page.getByText('Specific command (optional)', { exact: true }).click();
  await page.getByLabel('Command', { exact: true }).fill(question);
  const manualRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/answer') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  const payload = (await manualRequest).postDataJSON();
  expect(payload).toMatchObject({ question, mode: 'manual', demo: true });
  expect(payload.transcript.length).toBeGreaterThan(1);
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Help now/ })).toBeEnabled();

  const keyboardRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/answer') && request.method() === 'POST',
  );
  await page.keyboard.press('F8');
  expect((await keyboardRequest).postDataJSON()).toMatchObject({ mode: 'manual', demo: true });
  await expect(page.getByText('1 previous results', { exact: true })).toBeVisible();
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
    .getByRole('textbox', { name: 'Task instructions', exact: true })
    .fill('Answer briefly and ask a follow-up question when facts are missing.');
  await page
    .getByRole('textbox', { name: 'Reference material', exact: true })
    .fill('We are planning a two-week test with exactly three participants.');
  expect(await page.evaluate(() => localStorage.getItem('callside.settings.v1'))).toBeNull();
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await startDemo(page);
  const answerRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/answer') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: /^Help now/ }).click();
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
  await expect(page.getByTestId('template-feedback')).toContainText('Template saved.');
  await expect(page.getByTestId('template-feedback')).toBeInViewport();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reference material', exact: true })).toHaveValue(
    'We are planning a two-week test with exactly three participants.',
  );
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reference material', exact: true })).toHaveValue(
    '',
  );
  expect(await page.evaluate(() => localStorage.getItem('callside.settings.v1'))).toBeNull();
  await expect(page.getByTestId('template-feedback')).toContainText('saved template removed');
});

test('a failed template save keeps edits and reports the problem beside the button', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Reference material', { exact: true }).fill('Keep these course notes.');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    };
  });
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByTestId('template-feedback')).toContainText('Could not save');
  await expect(page.getByTestId('template-feedback')).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('template-feedback')).toBeInViewport();
  await expect(page.getByLabel('Reference material', { exact: true })).toHaveValue(
    'Keep these course notes.',
  );
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
      {
        ...DEFAULT_SETTINGS,
        transcriptionProvider: 'openai',
        backgroundSpeakers: false,
        captureMic: true,
        captureSystem: false,
      },
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
  const model = page.getByRole('combobox', { name: 'Task model', exact: true });
  await expect(model.locator('option')).toHaveText([
    'GPT-6 Luna',
    'GPT-6 Sol',
    'GPT-6.1 Sol',
    'GPT-6 Astra',
  ]);
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
  await model.selectOption('gpt-6.1-sol');
  await expect(reasoning).toHaveValue('low');
  await expect(reasoning.locator('option[value="none"]')).toHaveCount(0);
  await reasoning.selectOption('high');
  await page.getByLabel('Fast mode', { exact: true }).check();
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await page.reload();
  await startDemo(page);
  const request = page.waitForRequest(
    (r) => r.url().endsWith('/api/answer') && r.method() === 'POST',
  );
  await page.getByRole('button', { name: /^Help now/ }).click();
  expect((await request).postDataJSON().settings).toMatchObject({
    model: 'gpt-6.1-sol',
    reasoningEffort: 'high',
    fastMode: true,
  });
});

test('Workshop preserves long references, runs before speech, and exports cache usage', async ({
  page,
}) => {
  const reference = '[Exercise 7]\n' + 'Explain the feedback loop. '.repeat(1500);
  const usage = {
    inputTokens: 10500,
    outputTokens: 130,
    cachedInputTokens: 10000,
    cacheWriteTokens: 0,
    reasoningTokens: 100,
  };
  await page.route('**/api/answer', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'delta', text: 'Start by identifying the feedback loop. [Exercise 7]' })}\n\ndata: ${JSON.stringify({ type: 'done', usage })}\n\n`,
    }),
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Reference material', { exact: true }).fill(reference);
  await page.getByRole('button', { name: 'Workshop', exact: true }).click();
  await expect(page.getByLabel('Reference material', { exact: true })).toHaveValue(reference);
  await expect(
    page.getByRole('combobox', { name: 'Automatic trigger source', exact: true }),
  ).toHaveValue('either');
  await page.getByRole('combobox', { name: 'Task model', exact: true }).selectOption('gpt-6.1-sol');
  await page
    .getByRole('combobox', { name: 'Output token limit', exact: true })
    .selectOption('model');
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: /^Help now/ })).toBeEnabled();
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/answer') && r.method() === 'POST');
  await expect(page.getByLabel('Command', { exact: true })).not.toBeVisible();
  await page.keyboard.press('F8');
  expect((await sent).postDataJSON()).toMatchObject({
    transcript: [],
    question: '',
    mode: 'manual',
    settings: {
      context: reference,
      model: 'gpt-6.1-sol',
      reasoningEffort: 'low',
      maxOutputTokens: null,
      autoTriggerSource: 'either',
    },
  });
  await expect(page.getByTestId('suggestion')).toContainText('[Exercise 7]');
  await page.getByLabel('Export session', { exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Session as JSON', exact: true }).click();
  const session = JSON.parse(await readFile((await (await downloaded).path())!, 'utf8'));
  expect(session.requestUsage).toEqual([
    expect.objectContaining({ model: 'gpt-6.1-sol', skipped: false, usage }),
  ]);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Reference material', { exact: true })).toHaveValue(reference);
  await expect(page.getByLabel('Task instructions', { exact: true })).toHaveValue(
    /Participants may move between topics/,
  );
});

test('oversized pasted references are retained and block task requests with a clear message', async ({
  page,
}) => {
  const reference = 'x'.repeat(100001);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Reference material', { exact: true }).fill(reference);
  await expect(page.getByLabel('Reference material', { exact: true })).toHaveValue(reference);
  await expect(page.getByRole('alert')).toContainText('Your pasted text has been kept in full');
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Help now/ })).toBeDisabled();
  await page.keyboard.press('F8');
  await expect(page.getByRole('alert')).toContainText(
    'Reference material exceeds 100,000 characters',
  );
});

test('automatic microphone trigger waits for a microphone segment', async ({ page }) => {
  const requests: any[] = [];
  await page.route('**/api/answer', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"skip"}\n\n' });
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Automatic trigger source', exact: true })
    .selectOption('mic');
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.getByRole('switch', { name: 'Automatic hints', exact: true }).check();
  await startDemo(page);
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  expect(requests[0]).toMatchObject({ mode: 'auto', settings: { autoTriggerSource: 'mic' } });
  expect(requests[0].transcript.some((entry: any) => entry.source === 'mic' && entry.final)).toBe(
    true,
  );
  expect(requests[0].transcript.length).toBeGreaterThan(1);
});

test('ChatGPT sign-in selects plan billing, loads models, and preserves it in templates', async ({
  page,
}) => {
  let status = {
    available: true,
    connected: false,
    pending: false,
    error: '',
    activeId: 'test-account',
    accounts: [] as Array<{ id: string; label: string; connected: boolean }>,
    models: [] as Array<{ id: string; name: string }>,
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: { token: 'test-token', hasApiKey: false, models: ['gpt-6-luna'], chatgpt: status },
    }),
  );
  await page.route('**/api/chatgpt/**', (route) => {
    const action = route.request().url().split('/').at(-1);
    if (action === 'connect')
      status = {
        ...status,
        connected: true,
        accounts: [{ id: 'test-account', label: 'Test account', connected: true }],
      };
    if (action === 'models')
      status = { ...status, models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] };
    if (action === 'disconnect') status = { ...status, connected: false, models: [] };
    return route.fulfill({ json: status });
  });
  let payload: Record<string, any> | undefined;
  await page.route('**/api/answer', (route) => {
    payload = route.request().postDataJSON();
    return route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"type":"delta","text":"Subscription test suggestion"}\n\ndata: {"type":"done"}\n\n',
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await expect(page.getByLabel('Pay for suggestions with')).toHaveValue('chatgpt');
  await expect(page.getByRole('combobox', { name: 'Task model', exact: true })).toHaveValue(
    'gpt-6.1-sol',
  );
  await expect(page.getByLabel('Fast mode', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('combobox', { name: 'Output token limit', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Reference material', { exact: true }).fill('Explain this course topic.');
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Pay for suggestions with')).toHaveValue('chatgpt');
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.getByRole('button', { name: /^Help now/ }).click();
  await expect(page.getByTestId('suggestion')).toContainText('Subscription test suggestion');
  expect(payload?.settings.answerBilling).toBe('chatgpt');
  expect(payload?.demo).toBe(false);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of ChatGPT', exact: true }).click();
  await expect(page.getByLabel('Pay for suggestions with')).toHaveValue('chatgpt');
});

test('cloud comparison requires keys and sends only explicitly selected providers', async ({
  page,
}) => {
  await page.route('**/api/comparison/status', (route) =>
    route.fulfill({
      json: { ready: true, engines: [], cloudKeys: { openai: false, elevenlabs: false } },
    }),
  );
  let payload: any;
  await page.route('**/api/comparison/run', (route) => {
    payload = route.request().postDataJSON();
    return route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"type":"error","message":"Fixture stopped before provider connection"}\n\n',
    });
  });
  await page.goto('/local-compare');
  await page.getByLabel('Upload WAV file').setInputFiles({
    name: 'test.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from(encodeWav(new Int16Array(16000), 16000)),
  });
  await page.getByRole('checkbox', { name: 'OpenAI Cloud API' }).check();
  await page.getByRole('checkbox', { name: 'ElevenLabs Cloud API' }).check();
  await expect(page.getByRole('button', { name: 'Run comparison', exact: true })).toBeDisabled();
  await page.getByLabel('OpenAI API key', { exact: true }).fill('fixture-openai-secret');
  await page.getByLabel('ElevenLabs API key', { exact: true }).fill('fixture-eleven-secret');
  await expect(page.getByLabel('ElevenLabs API key', { exact: true })).toHaveAttribute(
    'type',
    'password',
  );
  await expect(page.getByText('Running sends this recording', { exact: false })).toBeVisible();
  await page.screenshot({ path: '/tmp/callside-benchmark-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/callside-benchmark-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Fixture stopped');
  expect(payload.engines).toEqual(['whisper', 'cohere', 'openai', 'elevenlabs']);
  expect(payload.openaiKey).toBe('fixture-openai-secret');
  expect(payload.elevenlabsKey).toBe('fixture-eleven-secret');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('fixture-');
});

test('desktop setup shows model progress without recording and prepares both runtimes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'callsideDesktop', {
      value: {
        platform: 'darwin',
        onAnswer: () => () => {},
        getShortcutStatus: async () => [],
        setSessionActive: async () => {},
        loadTemplate: async () => null,
        updates: async () => ({
          phase: 'current',
          version: '0.6.0',
          message: 'You have the latest available version.',
        }),
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: () => {
        throw Error('Setup must not record audio');
      },
    });
  });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/local/prepare', async (route) => {
    await wait;
    await route.fulfill({ json: { ready: true } });
  });
  await page.route('**/api/local/status', (route) =>
    route.fulfill({
      json: { phase: 'downloading', percent: 37, message: 'Downloading Whisper model' },
    }),
  );
  await page.route('**/api/local-speakers/start', (route) =>
    route.fulfill({ json: { session: 'setup-session' } }),
  );
  let finalized = false;
  await page.route('**/api/local-speakers/audio', (route) => {
    finalized = route.request().postDataJSON().final === true;
    return route.fulfill({ json: { from: 0, through: 0, segments: [] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Download and prepare models', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Model preparation' })).toHaveAttribute(
    'value',
    '37',
  );
  await page
    .getByRole('region', { name: 'Local audio setup' })
    .screenshot({ path: '.local/installer-setup-progress.png' });
  release();
  await expect(page.getByRole('button', { name: 'Models ready', exact: true })).toBeDisabled();
  expect(finalized).toBe(true);
  await expect(page.getByRole('region', { name: 'Application updates' })).toContainText(
    'Callside 0.6.0',
  );
});

// Native calls are mocked at the bridge boundary. The browser still runs the
// production capture/worklet/VAD/reconciliation and guided-test state machines.
async function windowsDesktop(page: Page, initialState: any = null) {
  const { DEFAULT_SETTINGS } = await import('../shared/defaults');
  const priorTemplate = {
    ...DEFAULT_SETTINGS,
    language: 'en',
    context: 'PRIVATE-SAVED-CONTEXT',
    systemPrompt: 'Keep my prior instructions.',
  };
  let savedState: any = initialState,
    template: any = structuredClone(priorTemplate),
    session = 1;
  const active: boolean[] = [];
  let saves = 0,
    relaunches = 0;
  await page.exposeFunction('__windowsNative', async (method: string, value: any) => {
    if (method === 'load') return structuredClone(savedState);
    if (method === 'save') {
      savedState = structuredClone(value);
      saves++;
      return;
    }
    if (method === 'template-load') return structuredClone(template);
    if (method === 'template-save') {
      template = structuredClone(value);
      return;
    }
    if (method === 'template-remove') {
      template = null;
      return;
    }
    if (method === 'active') {
      active.push(value);
      return;
    }
    if (method === 'restart') {
      expect(active.at(-1)).toBe(false);
      expect(savedState.restartCheckpoint).toBeTruthy();
      session++;
      relaunches++;
      return;
    }
    if (method === 'diagnostics')
      return {
        platform: 'win32',
        arch: 'x64',
        cpu: 'Synthetic CPU',
        ramGB: 32,
        preview: true,
        appVersion: '0.6.0',
        buildId: 'browser-fixture',
        sessionId: `native-session-${session}`,
        secureStorage: true,
        secureStorageRestart: session > 1,
        apiKey: 'sk-PRIVATE-DIAGNOSTIC',
        username: 'PRIVATE-USER',
        deviceId: 'PRIVATE-DEVICE',
        shortcuts: [{ accelerator: 'F8', registered: true }],
      };
    throw Error(`Unexpected native action: ${method}`);
  });
  await page.addInitScript(() => {
    const native = (method: string, value?: unknown) =>
      (window as any).__windowsNative(method, value);
    let shortcut: () => void = () => {};
    Object.defineProperty(window, 'callsideDesktop', {
      value: {
        platform: 'win32',
        onAnswer: (callback: () => void) => {
          shortcut = callback;
          return () => {
            shortcut = () => {};
          };
        },
        setSessionActive: (value: boolean) => native('active', value),
        getTestDiagnostics: () => native('diagnostics'),
        loadTestState: () => native('load'),
        saveTestState: (value: unknown) => native('save', value),
        loadTemplate: () => native('template-load'),
        saveTemplate: (value: unknown) => native('template-save', value),
        removeTemplate: () => native('template-remove'),
        relaunchTest: async () => {
          await native('restart');
          setTimeout(() => location.reload(), 40);
        },
      },
    });
    (window as any).__testShortcut = (outside = true) => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => !outside });
      shortcut();
    };
    (window as any).__captureCounts = { mic: 0, system: 0, stopped: 0 };
    const makeStream = async (source: 'mic' | 'system') => {
      (window as any).__captureCounts[source]++;
      if (source === 'mic' && (window as any).__denyMic)
        throw new DOMException('Fixture permission denied', 'NotAllowedError');
      const context = new AudioContext(),
        output = context.createMediaStreamDestination();
      // The two sources share one initial phrase (speaker echo). Each then gets
      // a distinct phrase. Frequency lets the mocked ASR distinguish real PCM.
      const tones = source === 'mic' ? [440, 660] : [880, 1100];
      for (const [index, hz] of tones.entries()) {
        const oscillator = context.createOscillator(),
          gain = context.createGain();
        oscillator.frequency.value = hz;
        gain.gain.value = 0.2;
        oscillator.connect(gain).connect(output);
        oscillator.start(context.currentTime + index * 3);
        oscillator.stop(context.currentTime + index * 3 + 2);
      }
      await context.resume();
      for (const track of output.stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          (window as any).__captureCounts.stopped++;
          stop();
          void context.close();
        };
      }
      return output.stream;
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () => makeStream('mic'),
    });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: () => makeStream('system'),
    });
    const NativeAudio = window.Audio;
    (window as any).Audio = function (src: string) {
      const element = new NativeAudio(src);
      element.playbackRate = src.includes('speakers') ? 10 : 4;
      return element;
    };
  });
  return {
    priorTemplate,
    active,
    get state() {
      return savedState;
    },
    get template() {
      return template;
    },
    get saves() {
      return saves;
    },
    get relaunches() {
      return relaunches;
    },
  };
}

async function windowsAPI(page: Page) {
  let chatgpt = {
    available: true,
    connected: false,
    pending: false,
    error: '',
    activeId: 'PRIVATE-ACCOUNT-ID',
    accounts: [{ id: 'PRIVATE-ACCOUNT-ID', label: 'private@example.test', connected: false }],
    models: [] as Array<{ id: string; name: string }>,
  };
  const answerRequests: any[] = [],
    speechRequests: any[] = [],
    speakerRequests: any[] = [],
    unexpected: string[] = [];
  let connectFailure = false,
    audioFailure = false,
    receivedSamples = 0,
    session = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postData() ? route.request().postDataJSON() : undefined;
    if (path === '/api/bootstrap')
      return route.fulfill({
        json: { token: 'PRIVATE-CSRF-TOKEN', hasApiKey: false, models: [], chatgpt },
      });
    if (path === '/api/local/prepare') return route.fulfill({ json: { ready: true } });
    if (path === '/api/local/status' || path === '/api/local-speakers/status')
      return route.fulfill({ json: { phase: 'ready', message: 'Included fixture model ready' } });
    if (path === '/api/local/transcribe') {
      speechRequests.push(body);
      if (audioFailure)
        return route.fulfill({ status: 503, json: { error: 'Local inference unavailable.' } });
      const wav = Buffer.from(body.audio, 'base64');
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.readUInt32LE(24)).toBe(16000);
      let signs = 0,
        crossings = 0,
        previous = 0;
      for (let i = 44; i + 1 < wav.length; i += 2) {
        const value = wav.readInt16LE(i),
          sign = Math.abs(value) > 100 ? Math.sign(value) : 0;
        if (!sign) continue;
        signs++;
        if (previous && previous !== sign) crossings++;
        previous = sign;
      }
      const frequency = (crossings / Math.max(1, signs)) * 8000;
      const text =
        frequency < 550 || (frequency >= 750 && frequency < 1000)
          ? 'The first speaker asks about euros and pounds.'
          : frequency < 750
            ? 'Ich habe die Stimmen gehört.'
            : 'The second speaker asks about taking notes.';
      return route.fulfill({ json: { text, processingMs: 10 } });
    }
    if (path === '/api/local-speakers/start') {
      receivedSamples = 0;
      session++;
      return route.fulfill({
        json: { session: `speaker-session-${session}`, model: 'fixture', maxSpeakers: 4 },
      });
    }
    if (path === '/api/local-speakers/audio') {
      speakerRequests.push(body);
      receivedSamples += body.audio ? Buffer.from(body.audio, 'base64').length / 2 : 0;
      const through = receivedSamples / 24000;
      return route.fulfill({
        json: {
          from: 0,
          through,
          segments: [
            { start: 0, end: 2.7, speaker: 0 },
            { start: 2.8, end: 5.6, speaker: 1 },
            { start: 5.7, end: 6, speaker: 2 },
          ].filter((segment) => segment.end <= through),
        },
      });
    }
    if (path === '/api/chatgpt/connect') {
      if (connectFailure)
        return route.fulfill({
          status: 503,
          json: {
            error:
              'Sign-in failed for private@example.test at C:\\Users\\Private\\auth with Bearer PRIVATE_AUTH_TOKEN',
          },
        });
      chatgpt = { ...chatgpt, pending: true };
      return route.fulfill({ json: chatgpt });
    }
    if (path === '/api/chatgpt') {
      chatgpt = { ...chatgpt, pending: false, connected: true };
      return route.fulfill({ json: chatgpt });
    }
    if (path === '/api/chatgpt/models') {
      chatgpt = {
        ...chatgpt,
        models: [
          { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
          { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
          { id: 'gpt-4.1-mini', name: 'Unsupported old model' },
        ],
      };
      return route.fulfill({ json: chatgpt });
    }
    if (path === '/api/chatgpt/cancel') {
      chatgpt = { ...chatgpt, pending: false };
      return route.fulfill({ json: chatgpt });
    }
    if (path === '/api/answer') {
      answerRequests.push(body);
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"type":"delta","text":"Ich fasse die wichtigsten Punkte kurz zusammen."}\n\ndata: {"type":"done"}\n\n',
      });
    }
    unexpected.push(path);
    return route.fulfill({ status: 500, json: { error: `Unexpected test endpoint: ${path}` } });
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4318)/, (route) => {
    unexpected.push(route.request().url());
    return route.abort();
  });
  return {
    answerRequests,
    speechRequests,
    speakerRequests,
    unexpected,
    failConnect() {
      connectFailure = true;
    },
    failAudio() {
      audioFailure = true;
    },
  };
}

async function windowsReport(page: Page) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download test report', exact: true }).click();
  const contents = await readFile((await (await downloading).path())!, 'utf8');
  expect(contents).not.toMatch(
    /PRIVATE-|private@example|PRIVATE_AUTH_TOKEN|data:audio|"audio"\s*:|"token"\s*:|"apiKey"\s*:|restartCheckpoint|previousTemplate/,
  );
  const report = JSON.parse(contents);
  expect(report.schemaVersion).toBe(2);
  expect(report.test).toBe('windows-comprehensive-preview');
  return report;
}

async function prepareWindows(page: Page) {
  await page.goto('/windows-check');
  await page.getByRole('button', { name: 'Prepare test', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Model ready', exact: true })).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: 'I am ready to capture my microphone and computer audio for this test.',
    })
    .check();
}

test('Windows quick check captures each source and exports diagnostics without credentials', async ({
  page,
}) => {
  test.setTimeout(45000);
  const native = await windowsDesktop(page),
    api = await windowsAPI(page);
  await prepareWindows(page);
  await page.getByRole('button', { name: 'Test microphone', exact: true }).click();
  await expect(page.getByTestId('check-transcript-mic')).toContainText('euros and pounds');
  await page
    .getByRole('button', { name: 'Text is correct', exact: true })
    .first()
    .click({ timeout: 18000 });
  await page.getByRole('button', { name: 'Test computer audio', exact: true }).click();
  await expect(page.getByTestId('check-transcript-system')).toContainText('euros and pounds');
  await page
    .locator('.audio-check')
    .filter({ has: page.getByRole('heading', { name: 'Computer audio', exact: true }) })
    .getByRole('button', { name: 'Text is correct', exact: true })
    .click({ timeout: 15000 });
  const report = await windowsReport(page);
  expect(report.checks.mic.state).toBe('pass');
  expect(report.checks.system.state).toBe('pass');
  expect(report.checks.conversation.state).toBe('not-run');
  expect(report.environment.ramGB).toBe(32);
  expect(api.speechRequests.length).toBeGreaterThan(2);
  expect(api.answerRequests).toEqual([]);
  expect(api.unexpected).toEqual([]);
  expect(await page.evaluate(() => (window as any).__captureCounts)).toEqual({
    mic: 1,
    system: 1,
    stopped: 2,
  });
  expect(native.active.at(-1)).toBe(false);
});

test('Windows complete session reconciles simultaneous sources, labels final audio, signs in, triggers one subscription answer and restores settings after restart', async ({
  page,
}) => {
  test.setTimeout(70000);
  const native = await windowsDesktop(page),
    api = await windowsAPI(page);
  await prepareWindows(page);
  await page.getByRole('button', { name: 'Test conversation', exact: true }).click();
  await expect(page.getByTestId('check-transcript-conversation')).toContainText(
    'Ich habe die Stimmen gehört',
    { timeout: 10000 },
  );
  await expect(page.getByTestId('check-transcript-conversation')).toContainText(
    'Speaker 1 · local',
    { timeout: 10000 },
  );
  const conversation = page.getByRole('region', { name: '3. Conversation and speaker labels' });
  await conversation
    .getByRole('button', { name: 'Text is correct', exact: true })
    .click({ timeout: 22000 });
  await conversation.getByRole('button', { name: 'Sources are correct', exact: true }).click();
  await conversation
    .getByRole('button', { name: 'Speaker labels are correct', exact: true })
    .click();
  expect(api.speakerRequests.at(-1).final).toBe(true);
  expect(api.speechRequests.every((request) => request.language === 'auto')).toBe(true);
  await page.getByRole('button', { name: 'Skip real call', exact: true }).click();
  await page.getByRole('button', { name: 'Connect to ChatGPT', exact: true }).click();
  await expect(
    page.getByText('Finish signing in in your browser, then return here.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('ChatGPT connected.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Answer model', exact: true }).locator('option'),
  ).toHaveCount(2);
  await page
    .getByRole('combobox', { name: 'Answer model', exact: true })
    .selectOption('gpt-6.1-sol');
  await page.getByRole('button', { name: 'Use shortcut for one answer', exact: true }).click();
  await page.evaluate(() => (window as any).__testShortcut(true));
  await expect(
    page.getByText('Ich fasse die wichtigsten Punkte kurz zusammen.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Useful and fast enough', exact: true }).click();
  await page.evaluate(() => (window as any).__testShortcut(true));
  await expect.poll(() => api.answerRequests.length).toBe(1);
  expect(api.answerRequests[0]).toMatchObject({
    mode: 'manual',
    question: '',
    settings: {
      answerBilling: 'chatgpt',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'low',
      maxOutputTokens: null,
    },
  });
  expect(api.answerRequests[0].transcript.some((entry: any) => entry.source === 'mic')).toBe(true);
  expect(api.answerRequests[0].transcript.some((entry: any) => entry.attribution === 'local')).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Save progress and restart', exact: true }).click();
  await expect(
    page.getByText(
      'The app restarted. Saved settings and encrypted storage survived. Previous settings were restored.',
    ),
  ).toBeVisible({ timeout: 10000 });
  expect(native.relaunches).toBe(1);
  expect(native.template).toEqual(native.priorTemplate);
  const report = await windowsReport(page);
  expect(report.checks.conversation.state).toBe('pass');
  expect(report.checks.conversation.echoCount).toBeGreaterThan(0);
  expect(report.checks.conversation.speakerCount).toBe(3);
  expect(
    report.checks.conversation.entries.filter((entry: any) =>
      entry.text.includes('euros and pounds'),
    ),
  ).toHaveLength(1);
  expect(report.checks.shortcut).toMatchObject({ state: 'pass', outsideApp: true });
  expect(report.checks.chatgpt).toMatchObject({
    state: 'pass',
    requestCount: 1,
    model: 'gpt-6.1-sol',
  });
  expect(report.checks.restart).toMatchObject({
    state: 'pass',
    settingsMatch: true,
    chatgptPersisted: true,
    secureStoragePersisted: true,
  });
  expect(report.checks.call.state).toBe('skipped');
  expect(api.unexpected).toEqual([]);
});

test('Windows failed audio and sign-in remain reportable, skipped steps are not passes, and interrupted progress survives reload', async ({
  page,
}) => {
  test.setTimeout(25000);
  const native = await windowsDesktop(page, {
    schemaVersion: 2,
    savedAt: new Date().toISOString(),
    checks: { conversation: { state: 'running', message: 'Recording' } },
    preferences: { output: 'headphones', model: '' },
    notes: 'Keep this note.',
  });
  const api = await windowsAPI(page);
  api.failConnect();
  await prepareWindows(page);
  await expect(
    page.getByText('The app closed during this step. Retry it or continue with the other checks.'),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).__captureCounts)).toEqual({
    mic: 0,
    system: 0,
    stopped: 0,
  });
  await page.evaluate(() => {
    (window as any).__denyMic = true;
  });
  await page.getByRole('button', { name: 'Test microphone', exact: true }).click();
  await expect(
    page
      .getByText(
        'Audio access was denied. Allow microphone and system audio in system settings and restart recording.',
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Connect to ChatGPT', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('[email]');
  await expect(page.getByRole('alert')).not.toContainText('PRIVATE_AUTH_TOKEN');
  for (const name of ['Skip computer audio', 'Skip real call', 'Skip shortcut', 'Skip restart'])
    await page.getByRole('button', { name, exact: true }).click();
  await expect.poll(() => native.state?.checks.restart?.state).toBe('skipped');
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Anything else that did not work? (optional)' }),
  ).toHaveValue('Keep this note.');
  const report = await windowsReport(page);
  expect(report.notes).toBe('Keep this note.');
  expect(report.output).toBe('headphones');
  expect(report.checks.mic.state).toBe('fail');
  expect(report.checks.conversation.state).toBe('stopped');
  expect(report.checks.chatgpt.state).toBe('fail');
  for (const check of ['system', 'call', 'shortcut', 'restart'])
    expect(report.checks[check].state).toBe('skipped');
  expect(api.answerRequests).toEqual([]);
  expect(api.speakerRequests).toEqual([]);
  expect(api.unexpected).toEqual([]);
  expect(native.template).toEqual(native.priorTemplate);
});

test('Windows native report save handles cancel and failure before a successful retry without losing results', async ({
  page,
}) => {
  const native = await windowsDesktop(page),
    api = await windowsAPI(page);
  let attempt = 0;
  const reports: any[] = [];
  await page.exposeFunction('__saveWindowsReport', async (value: any) => {
    reports.push(value);
    attempt++;
    if (attempt === 1) return { saved: false };
    if (attempt === 2) throw Error('Disk write failed at /Users/PRIVATE-USER/report.json');
    return { saved: true };
  });
  await page.goto('/windows-check');
  await page.evaluate(() => {
    (window.callsideDesktop as any).saveTestReport = (window as any).__saveWindowsReport;
  });
  await page
    .getByRole('textbox', { name: 'Anything else that did not work? (optional)' })
    .fill('The report must survive a cancelled save.');
  await page.getByRole('button', { name: 'Skip real call', exact: true }).click();
  await page.getByRole('button', { name: 'Download test report', exact: true }).click();
  await expect(
    page.getByText('Save cancelled. Your results are still here.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Download test report', exact: true }).click();
  await expect(page.getByText(/Could not save the report:/)).toContainText('[local path]');
  await page.getByRole('button', { name: 'Download test report', exact: true }).click();
  await expect(
    page.getByText('Report saved. Send the JSON file back.', { exact: true }),
  ).toBeVisible();
  expect(reports).toHaveLength(3);
  for (const report of reports) {
    expect(report.schemaVersion).toBe(2);
    expect(report.notes).toBe('The report must survive a cancelled save.');
    expect(report.checks.call.state).toBe('skipped');
    expect(JSON.stringify(report)).not.toMatch(
      /PRIVATE-|apiKey|previousTemplate|restartCheckpoint/,
    );
  }
  expect(api.unexpected).toEqual([]);
  expect(api.answerRequests).toEqual([]);
  expect(native.template).toEqual(native.priorTemplate);
});
