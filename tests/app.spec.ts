import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function startDemo(page: Page) {
  await page.getByRole('button', { name: 'Demo ausprobieren', exact: true }).click();
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
  await expect(page.getByRole('button', { name: 'Demo ausprobieren', exact: true })).toBeEnabled();
});

test.afterEach(async ({ page }) => {
  expect(
    await page.evaluate(
      () => (window as typeof window & { __captureRequests: number }).__captureRequests,
    ),
  ).toBe(0);
});

test('demo produces a transcript and answers typed questions and F8 without a key', async ({
  page,
}) => {
  await startDemo(page);
  const question = 'Welche konkrete Rückfrage sollte ich jetzt stellen?';
  await page.getByLabel('Eigene Frage', { exact: true }).fill(question);
  const manualRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/answer') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Frage senden', exact: true }).click();
  const payload = (await manualRequest).postDataJSON();
  expect(payload).toMatchObject({ question, mode: 'manual', demo: true });
  expect(payload.transcript.length).toBeGreaterThan(1);
  await expect(page.getByTestId('suggestion').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Antwort vorschlagen/ })).toBeEnabled();

  const keyboardRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/answer') && request.method() === 'POST',
  );
  await page.keyboard.press('F8');
  expect((await keyboardRequest).postDataJSON()).toMatchObject({ mode: 'manual', demo: true });
  await expect(page.getByText('1 frühere Vorschläge', { exact: true })).toBeVisible();
});

test('automatic mode requests a contextual demo suggestion', async ({ page }) => {
  await page.getByLabel('Automatische Hinweise', { exact: true }).check();
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
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'System-Prompt', exact: true })
    .fill('Antworte kurz und stelle eine Rückfrage, wenn Fakten fehlen.');
  await page
    .getByRole('textbox', { name: 'Gesprächskontext', exact: true })
    .fill('Wir planen einen zweiwöchigen Test mit genau drei Teilnehmern.');
  expect(await page.evaluate(() => localStorage.getItem('callside.settings.v1'))).toBeNull();
  await page.getByRole('button', { name: 'Gespräch', exact: true }).click();
  await startDemo(page);
  const answerRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/answer') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: /^Antwort vorschlagen/ }).click();
  expect((await answerRequest).postDataJSON().settings).toMatchObject({
    systemPrompt: 'Antworte kurz und stelle eine Rückfrage, wenn Fakten fehlen.',
    context: 'Wir planen einen zweiwöchigen Test mit genau drei Teilnehmern.',
  });
  const bootstrap = await page.request.get('/api/bootstrap');
  expect(await bootstrap.json()).toMatchObject({ hasApiKey: false });
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const activeSession = page.getByRole('region', { name: 'Aktive Sitzung', exact: true });
  await expect(activeSession).toBeVisible();
  await expect(
    activeSession.getByRole('button', { name: 'Demo beenden', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText(/^Die Audioeinstellungen sind während der Sitzung gesperrt\./),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Mikrofon transkribieren', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Vorlage speichern', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Gesprächskontext', exact: true })).toHaveValue(
    'Wir planen einen zweiwöchigen Test mit genau drei Teilnehmern.',
  );
  await page.getByRole('button', { name: 'Zurücksetzen', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Gesprächskontext', exact: true })).toHaveValue(
    '',
  );
  expect(await page.evaluate(() => localStorage.getItem('callside.settings.v1'))).toBeNull();
});

test('exports contain the demo transcript and a new session clears it', async ({ page }) => {
  await startDemo(page);
  await page.getByLabel('Sitzung exportieren', { exact: true }).click();
  const downloadJson = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Sitzung als JSON', exact: true }).click();
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
  await page.getByRole('button', { name: 'Transkript als Markdown', exact: true }).click();
  const markdownFile = await downloadMarkdown;
  expect(markdownFile.suggestedFilename()).toMatch(/\.md$/);
  const markdownPath = await markdownFile.path();
  const markdown = await readFile(markdownPath!, 'utf8');
  expect(markdown).toContain(session.transcript[0].text);

  await page.getByRole('button', { name: 'Demo beenden', exact: true }).click();
  await page.getByRole('button', { name: 'Neue Sitzung', exact: true }).click();
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
            delta: 'Synthetischer ',
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id,
            transcript: 'Synthetischer Audiotest.',
          }),
        );
      }
    });
  });

  // Install WebSocket interception before the page loads its application modules.
  await page.reload();
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();

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
            entry.final && entry.text === 'Synthetischer Audiotest.',
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
