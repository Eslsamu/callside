import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { Express } from 'express';
import { z } from 'zod';
import type { LocalEngine, LocalMeasurement } from '../shared/local-test.js';
import type {
  ComparisonEngineId,
  ComparisonEvent,
  ComparisonMetrics,
  ComparisonReport,
  ComparisonResult,
} from '../shared/comparison.js';
import { LocalSpeechPipeline, type LocalTurn } from '../src/audio/local.js';
import { encodeWav } from '../src/audio/dsp.js';
import { decodeLocalWav } from './local-test-routes.js';

export type ComparisonEngines = Record<ComparisonEngineId, LocalEngine>;
export const COMPARISON_PROTOCOL =
  'Same PCM16 mono 16 kHz recording; separate warmed, real-time paced replays in alternating order; 50 ms frames; energy VAD; first draft after 1.2 s, updates no sooner than 0.8 s; 0.5 s silence finalizes; 12 s maximum turn; stale drafts coalesced, finals retained; no diarization or postprocessing. Timing is approximate and includes buffering and queueing, but not physical microphone or browser paint latency. Model-specific adaptive draft coalescing can produce different intermediate snapshots.';
export function wordErrorRate(reference: string, hypothesis: string) {
  const words = (value: string) =>
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  const expected = words(reference),
    actual = words(hypothesis);
  if (!expected.length) return { wer: null, wordErrors: null, referenceWords: 0 };
  let previous = Array.from({ length: actual.length + 1 }, (_, i) => i);
  for (let i = 1; i <= expected.length; i++) {
    const row = [i];
    for (let j = 1; j <= actual.length; j++)
      row[j] = Math.min(
        row[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(expected[i - 1] !== actual[j - 1]),
      );
    previous = row;
  }
  const wordErrors = previous[actual.length];
  return { wer: wordErrors / expected.length, wordErrors, referenceWords: expected.length };
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
    : null;
};
export async function replayComparisonEngine(
  engineId: ComparisonEngineId,
  engine: LocalEngine,
  samples: Int16Array,
  language: string,
  reference: string,
  signal: AbortSignal,
  emit: (event: ComparisonEvent) => void,
): Promise<ComparisonResult> {
  const measurements: LocalMeasurement[] = [];
  const turns = new Map<string, LocalTurn>();
  let error: string | undefined;
  let processingMs = 0,
    requests = 0;
  const started = performance.now();
  const pipeline = new LocalSpeechPipeline(
    async (audio, abort) => {
      requests++;
      const inferenceStarted = performance.now();
      const result = await engine.transcribe(
        encodeWav(audio, 16000),
        language,
        AbortSignal.any([signal, abort]),
      );
      const elapsed = performance.now() - inferenceStarted;
      processingMs += elapsed;
      return { ...result, processingMs: elapsed };
    },
    {
      onTurn: (turn) => {
        turns.set(turn.id, turn);
        if (turn.measurement) measurements.push(turn.measurement);
        emit({ type: 'turn', engine: engineId, ...turn });
      },
      onLevel: () => {},
      onStatus: () => {},
      onError: (message) => {
        error = message;
      },
    },
  );
  const cancel = () => pipeline.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  let replayEnded = started;
  try {
    for (let offset = 0; offset < samples.length; offset += 800) {
      signal.throwIfAborted();
      if (error) break;
      const end = Math.min(offset + 800, samples.length);
      const wait = started + end / 16 - performance.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      pipeline.feed(samples.subarray(offset, end));
    }
    replayEnded = performance.now();
    await pipeline.finish();
    signal.throwIfAborted();
  } finally {
    pipeline.cancel();
    signal.removeEventListener('abort', cancel);
  }
  const ended = performance.now();
  const transcript = [...turns.values()]
    .filter((turn) => turn.final)
    .map((turn) => turn.text)
    .join(' ')
    .trim();
  const finals = measurements.filter((m) => m.final);
  const finalDelays = finals.map((m) => m.speechToTextMs).sort((a, b) => a - b);
  const firstByTurn = [...new Map(measurements.map((m) => [m.turnId, m.firstTextMs])).values()];
  const metrics: ComparisonMetrics = {
    audioMs: samples.length / 16,
    wallMs: ended - started,
    processingMs,
    processingToAudioRatio: processingMs / (samples.length / 16),
    firstTextMs: median(firstByTurn),
    medianFinalDelayMs: median(finalDelays),
    p95FinalDelayMs: finalDelays.length
      ? finalDelays[Math.ceil(finalDelays.length * 0.95) - 1]
      : null,
    maxQueueMs: Math.max(0, ...measurements.map((m) => m.queueMs)),
    drainMs: ended - replayEnded,
    requests,
    finalTurns: [...turns.values()].filter((t) => t.final).length,
    ...wordErrorRate(reference, transcript),
  };
  return {
    engine: engineId,
    model: engine.model,
    transcript,
    metrics,
    measurements,
    ...(error ? { error } : {}),
    ...(engine.details ? { details: engine.details } : {}),
  };
}

export function attachComparison(app: Express, engines?: ComparisonEngines) {
  let busy = false,
    sequence = 0;
  const pending = new Set<AbortController>();
  app.get('/api/comparison/status', (_req, res) =>
    res.json({
      ready: Boolean(engines),
      engines: engines
        ? Object.entries(engines).map(([id, e]) => ({ id, model: e.model, details: e.details }))
        : [],
      ...(!engines ? { error: 'Run npm run local:compare to load both local models.' } : {}),
    }),
  );
  app.post('/api/comparison/run', async (req, res) => {
    if (!engines) {
      res.status(503).json({ error: 'Run npm run local:compare first.' });
      return;
    }
    if (busy) {
      res.status(429).json({ error: 'A comparison is already running. Wait for it or cancel it.' });
      return;
    }
    const parsed = z
      .object({
        audio: z.string().min(60).max(2560060),
        language: z.enum(['en', 'de']),
        reference: z.string().max(20000).default(''),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Use up to 60 seconds of audio and English or German.' });
      return;
    }
    let audio: Buffer;
    try {
      audio = decodeLocalWav(parsed.data.audio, 60);
    } catch {
      res.status(400).json({ error: 'Expected PCM16 mono 16 kHz WAV between 0.1 and 60 seconds.' });
      return;
    }
    const samples = new Int16Array((audio.length - 44) / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = audio.readInt16LE(44 + i * 2);
    busy = true;
    const abort = new AbortController();
    pending.add(abort);
    const cancel = () => abort.abort();
    res.on('close', cancel);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      cancel();
    }, 10 * 60_000);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const emit = (event: ComparisonEvent) => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keepalive\n\n');
    }, 10000);
    const report: ComparisonReport = {
      version: 1,
      createdAt: new Date().toISOString(),
      language: parsed.data.language,
      audioSha256: createHash('sha256').update(audio).digest('hex'),
      audioMs: samples.length / 16,
      reference: parsed.data.reference,
      protocol: COMPARISON_PROTOCOL,
      hardware: {
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model ?? 'Unknown',
        memoryBytes: totalmem(),
        node: process.version,
      },
      results: [],
    };
    const order: ComparisonEngineId[] =
      sequence++ % 2 ? ['cohere', 'whisper'] : ['whisper', 'cohere'];
    try {
      for (const engine of order) {
        abort.signal.throwIfAborted();
        emit({ type: 'start', engine, model: engines[engine].model });
        const result = await replayComparisonEngine(
          engine,
          engines[engine],
          samples,
          parsed.data.language,
          parsed.data.reference,
          abort.signal,
          emit,
        );
        report.results.push(result);
        emit({
          type: 'done',
          engine,
          metrics: result.metrics,
          ...(result.error ? { error: result.error } : {}),
        });
      }
      emit({ type: 'complete', report });
    } catch (error) {
      if (timedOut)
        emit({
          type: 'error',
          message:
            'Comparison timed out before both models finished. No complete report is available.',
        });
      else if (!abort.signal.aborted)
        emit({
          type: 'error',
          message: error instanceof Error ? error.message : 'Comparison failed.',
        });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      res.off('close', cancel);
      pending.delete(abort);
      busy = false;
      res.end();
    }
  });
  return () => {
    for (const abort of pending) abort.abort();
  };
}
