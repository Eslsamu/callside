import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';
import {
  replayComparisonEngine,
  wordErrorRate,
  type ComparisonEngines,
} from '../server/comparison.js';
import type { ComparisonEvent, ComparisonReport } from '../shared/comparison.js';
import { encodeWav } from '../src/audio/dsp.js';

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const speech = (seconds = 0.2) => new Int16Array(16000 * seconds).fill(3000);
const audioPayload = (samples = speech()) => ({
  audio: Buffer.from(encodeWav(samples, 16000)).toString('base64'),
  language: 'de',
  reference: 'Guten Tag zusammen',
});
const events = (text: string): ComparisonEvent[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
function report(output: ComparisonEvent[]): ComparisonReport {
  const complete = output.find((event) => event.type === 'complete');
  if (!complete || complete.type !== 'complete') throw new Error('Missing completed report');
  return complete.report;
}

async function running(engines?: ComparisonEngines) {
  const providerFactory = vi.fn(() => {
    throw new Error('Local comparisons must not construct a cloud provider');
  });
  const server = await startServer({
    port: 0,
    apiOnly: true,
    apiKey: '',
    comparisonEngines: engines,
    providerFactory,
  });
  servers.push(server);
  const bootstrap = await fetch(`${server.url}/api/bootstrap`).then((response) => response.json());
  const headers = { 'Content-Type': 'application/json', 'X-Callside-Token': bootstrap.token };
  return {
    ...server,
    headers,
    providerFactory,
    post: (body: unknown, extra: RequestInit = {}) =>
      fetch(`${server.url}/api/comparison/run`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...extra,
      }),
  };
}
const quickEngines = (): ComparisonEngines => ({
  whisper: {
    model: 'whisper-test',
    transcribe: vi.fn(async () => ({ text: 'Guten Tag zusammen.', processingMs: 12 })),
  },
  cohere: {
    model: 'cohere-test',
    transcribe: vi.fn(async () => ({ text: 'Guten Morgen zusammen.', processingMs: 8 })),
  },
});

describe('local comparison API', () => {
  it('replays the same WAV through both local engines, alternates order, and exports measured results', async () => {
    const engines = quickEngines();
    const server = await running(engines);
    const payload = audioPayload();
    const response = await server.post(payload);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const output = events(await response.text());
    expect(output.filter((event) => event.type === 'start').map((event) => event.engine)).toEqual([
      'whisper',
      'cohere',
    ]);
    const completed = report(output);
    expect(output.at(-1)?.type).toBe('complete');
    expect(completed.audioSha256).toBe(
      createHash('sha256').update(Buffer.from(payload.audio, 'base64')).digest('hex'),
    );
    expect(completed.audioMs).toBe(200);
    expect(completed.language).toBe('de');
    expect(completed.reference).toBe(payload.reference);
    expect(completed.results).toHaveLength(2);
    for (const id of ['whisper', 'cohere'] as const) {
      expect(engines[id].transcribe).toHaveBeenCalledExactlyOnceWith(
        new Uint8Array(Buffer.from(payload.audio, 'base64')),
        'de',
        expect.any(AbortSignal),
      );
      const result = completed.results.find((entry) => entry.engine === id)!;
      expect(result.error).toBeUndefined();
      expect(result.metrics).toMatchObject({
        audioMs: 200,
        requests: 1,
        finalTurns: 1,
        wordErrors: id === 'whisper' ? 0 : 1,
        referenceWords: 3,
        wer: id === 'whisper' ? 0 : 1 / 3,
      });
      expect(result.measurements).toHaveLength(1);
      expect(result.metrics.wallMs).toBeGreaterThanOrEqual(180);
      expect(result.metrics.firstTextMs).toBeGreaterThanOrEqual(180);
    }
    const repeated = events(await (await server.post(payload)).text());
    expect(repeated.filter((event) => event.type === 'start').map((event) => event.engine)).toEqual(
      ['cohere', 'whisper'],
    );
    expect(server.providerFactory).not.toHaveBeenCalled();
  });

  it('requires the local session and rejects malformed or oversized audio before inference', async () => {
    const engines = quickEngines();
    const server = await running(engines);
    const payload = audioPayload();
    expect((await fetch(`${server.url}/api/comparison/status`)).status).toBe(403);
    expect(
      (
        await server.post(payload, {
          headers: { ...server.headers, Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await server.post(payload, { headers: { ...server.headers, 'X-Callside-Token': 'wrong' } }))
        .status,
    ).toBe(403);
    expect(
      (await server.post(payload, { headers: { ...server.headers, 'Content-Type': 'text/plain' } }))
        .status,
    ).toBe(415);
    const malformed = [
      { ...payload, audio: 'A'.repeat(60) },
      { ...payload, audio: payload.audio + '\n' },
      { ...payload, audio: Buffer.from(encodeWav(speech(), 24000)).toString('base64') },
      audioPayload(speech(60.001)),
      { ...payload, reference: 'x'.repeat(20001) },
      { ...payload, language: 'invalid' },
    ];
    for (const input of malformed) expect((await server.post(input)).status).toBe(400);
    expect(engines.whisper.transcribe).not.toHaveBeenCalled();
    expect(engines.cohere.transcribe).not.toHaveBeenCalled();
    expect(server.providerFactory).not.toHaveBeenCalled();
  });

  it('reports an unavailable local setup instead of falling back to a paid provider', async () => {
    const server = await running();
    const status = await fetch(`${server.url}/api/comparison/status`, {
      headers: server.headers,
    }).then((response) => response.json());
    expect(status.ready).toBe(false);
    expect((await server.post(audioPayload())).status).toBe(503);
    expect(server.providerFactory).not.toHaveBeenCalled();
  });

  it('rejects concurrent comparisons, cancels native work, and releases its slot', async () => {
    const engines = quickEngines();
    let nativeSignal: AbortSignal | undefined;
    engines.whisper.transcribe = vi
      .fn()
      .mockImplementationOnce(async (_audio, _language, signal) => {
        nativeSignal = signal;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
        throw new Error('Canceled native work must never complete');
      })
      .mockResolvedValue({ text: 'Guten Tag zusammen', processingMs: 1 });
    const server = await running(engines);
    const abort = new AbortController();
    const response = await server.post(audioPayload(), { signal: abort.signal });
    const reader = response.body!.getReader();
    const firstEvent = new TextDecoder().decode((await reader.read()).value);
    expect(firstEvent).toContain('"type":"start"');
    await vi.waitFor(() => expect(nativeSignal).toBeDefined());
    expect((await server.post(audioPayload())).status).toBe(429);
    abort.abort();
    await vi.waitFor(() => expect(nativeSignal?.aborted).toBe(true));
    const next = await server.post(audioPayload());
    expect(next.status).toBe(200);
    expect(report(events(await next.text())).results).toHaveLength(2);
    expect(server.providerFactory).not.toHaveBeenCalled();
  });

  it('marks an engine timeout as a failure in both streamed results and the final report', async () => {
    const engines = quickEngines();
    engines.whisper.transcribe = vi.fn(async () => {
      throw new Error('Local inference timed out');
    });
    const server = await running(engines);
    const output = events(await (await server.post(audioPayload())).text());
    expect(
      output.find((event) => event.type === 'done' && event.engine === 'whisper'),
    ).toMatchObject({
      error: 'Local inference timed out',
    });
    expect(report(output).results.find((entry) => entry.engine === 'whisper')).toMatchObject({
      error: 'Local inference timed out',
      transcript: '',
      metrics: { finalTurns: 0 },
    });
  });
});

describe('comparison measurements', () => {
  it('paces live drafts and measures buffering in first-text latency', async () => {
    const engine = quickEngines().whisper;
    const output: ComparisonEvent[] = [];
    const result = await replayComparisonEngine(
      'whisper',
      engine,
      speech(1.3),
      'de',
      '',
      new AbortController().signal,
      (event) => output.push(event),
    );
    expect(output.some((event) => event.type === 'turn' && !event.final)).toBe(true);
    expect(output.some((event) => event.type === 'turn' && event.final)).toBe(true);
    expect(result.metrics.firstTextMs).toBeGreaterThanOrEqual(1100);
    expect(result.metrics.wallMs).toBeGreaterThanOrEqual(1250);
    expect(result.metrics.wer).toBeNull();
    expect(result.metrics.referenceWords).toBe(0);
  });

  it('aborts a replay before starting model inference', async () => {
    const engine = quickEngines().whisper;
    const abort = new AbortController();
    const canceled = replayComparisonEngine(
      'whisper',
      engine,
      speech(),
      'de',
      '',
      abort.signal,
      () => {},
    );
    await delay(10);
    abort.abort();
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.transcribe).not.toHaveBeenCalled();
  });

  it('counts substitutions, insertions and deletions while ignoring case and punctuation', () => {
    expect(wordErrorRate('Hello, WÖRLD!', 'hello wörld')).toEqual({
      wer: 0,
      wordErrors: 0,
      referenceWords: 2,
    });
    expect(wordErrorRate('one two three', 'one four three extra')).toEqual({
      wer: 2 / 3,
      wordErrors: 2,
      referenceWords: 3,
    });
    expect(wordErrorRate('one two three', 'one three')).toEqual({
      wer: 1 / 3,
      wordErrors: 1,
      referenceWords: 3,
    });
    expect(wordErrorRate('one', 'one two three')).toEqual({
      wer: 2,
      wordErrors: 2,
      referenceWords: 1,
    });
    expect(wordErrorRate(' ', 'no reference')).toEqual({
      wer: null,
      wordErrors: null,
      referenceWords: 0,
    });
  });
});
