import { afterEach, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../server/index';
import { SpeakerAttributionOverlay } from '../src/audio/attribution';
import { createLocalSpeakerSink } from '../src/audio/local-speakers';
import type { CaptureCallbacks, SpeakerAttribution, TranscriptEntry } from '../shared/types';
let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllGlobals();
});

it('runs a local speaker session without credentials and closes the worker', async () => {
  const close = vi.fn();
  server = await startServer({
    port: 0,
    apiOnly: true,
    apiKey: '',
    providerFactory: () => {
      throw Error('Cloud forbidden');
    },
    localSpeakerFactory: async () => ({
      close,
      request: async () => ({ from: 0, through: 4, segments: [{ start: 0, end: 3, speaker: 0 }] }),
    }),
  });
  const { token } = await fetch(server.url + '/api/bootstrap').then((r) => r.json());
  const post = (path: string, body: object) =>
    fetch(server!.url + '/api/local-speakers/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
      body: JSON.stringify(body),
    });
  const { session } = await (await post('start', {})).json();
  expect((await post('start', {})).status).toBe(409);
  expect((await post('audio', { session, audio: 'AQ==' })).status).toBe(400);
  const response = await post('audio', { session, audio: Buffer.alloc(192000).toString('base64') });
  expect((await response.json()).segments[0].speaker).toBe(0);
  expect((await post('audio', { session, final: true })).status).toBe(200);
  expect(close).toHaveBeenCalledOnce();
  expect((await post('audio', { session, final: true })).status).toBe(409);
});

it('streams continuous silent PCM locally and overlays labels without emitting transcript text', async () => {
  const urls: string[] = [],
    bodies: any[] = [],
    updates: SpeakerAttribution[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    urls.push(url);
    bodies.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      json: async () =>
        url.endsWith('/start')
          ? { session: 'fixture' }
          : { from: 0, through: 4, segments: [{ start: 0, end: 3.5, speaker: 0 }] },
    };
  });
  const transcript = vi.fn();
  const sink = await createLocalSpeakerSink('token', {
    onTranscript: transcript,
    onAttribution: (r) => updates.push(r),
    onAttributionStatus: vi.fn(),
    onLevel: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
    onEnded: vi.fn(),
  } satisfies CaptureCallbacks);
  sink.append(new Int16Array(96000), 1000);
  await sink.stop();
  expect(urls.every((url) => url.startsWith('/api/local-speakers/'))).toBe(true);
  expect(Buffer.from(bodies[1].audio, 'base64').length).toBe(192000);
  expect(bodies.at(-1).final).toBe(true);
  expect(transcript).not.toHaveBeenCalled();
  expect(updates[0].segments[0].timestamp).toBe(1000);
});

it('labels dominant local voices, preserves text, and keeps mixed turns ambiguous', () => {
  const overlay = new SpeakerAttributionOverlay();
  const entry: TranscriptEntry = {
    id: 'turn',
    source: 'system',
    speaker: 'Other',
    text: 'The original words.',
    timestamp: 1000,
    endTimestamp: 5000,
    final: true,
  };
  const batch: SpeakerAttribution = {
    chunkId: 'one',
    timestamp: 1000,
    endTimestamp: 6000,
    receivedAt: 1,
    segments: [
      {
        timestamp: 1000,
        endTimestamp: 5000,
        speaker: 'Speaker 1 · local',
        speakerId: 'one',
        attribution: 'local',
        text: '',
      },
    ],
  };
  expect(overlay.apply(entry)[0].speaker).toBe('Other');
  overlay.accept(batch);
  expect(overlay.apply(entry)[0]).toMatchObject({
    text: entry.text,
    speaker: 'Speaker 1 · local',
    attribution: 'local',
  });
  overlay.accept({
    ...batch,
    receivedAt: 2,
    segments: [
      { ...batch.segments[0], endTimestamp: 3000 },
      { ...batch.segments[0], timestamp: 3000, speakerId: 'two', speaker: 'Speaker 2 · local' },
    ],
  });
  expect(overlay.apply(entry)[0].speaker).toBe('Multiple speakers · local');
  expect(overlay.apply(entry)[0].text).toBe(entry.text);
});
