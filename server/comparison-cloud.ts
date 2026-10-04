import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import {
  VoiceActivityDetector,
  concatPcm,
  rms,
  StreamingResampler,
  floatToPcm16,
} from '../src/audio/dsp.js';
import { transcriptionSession, openRealtime } from './realtime.js';
import type { ComparisonEvent, ComparisonResult } from '../shared/comparison.js';
import type { LocalMeasurement } from '../shared/local-test.js';
import { wordErrorRate } from './comparison.js';

export type CloudEngineId = 'openai' | 'elevenlabs';
export const cloudModels = {
  openai: 'gpt-live-transcribe',
  elevenlabs: 'scribe_v2_realtime',
} as const;
export type CloudConnect = (id: CloudEngineId, key: string, language: string) => WebSocket;
const connect: CloudConnect = (id, key, language) => {
  if (id === 'openai') return openRealtime(key);
  const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  url.search = new URLSearchParams({
    model_id: cloudModels.elevenlabs,
    audio_format: 'pcm_16000',
    language_code: language,
    commit_strategy: 'manual',
  }).toString();
  return new WebSocket(url, {
    headers: { 'xi-api-key': key },
    handshakeTimeout: 15000,
    maxPayload: 1_000_000,
  });
};
interface Turn {
  id: string;
  start: number;
  speech: number;
  committed?: number;
  first?: number;
  text: string;
  final: boolean;
  samples: number;
}
const median = (xs: number[]) => {
  const a = [...xs].sort((a, b) => a - b);
  return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : null;
};

/** One native streaming session, local VAD/manual commits shared with the local baseline. */
export async function replayCloudEngine(
  engine: CloudEngineId,
  key: string,
  samples: Int16Array,
  language: string,
  reference: string,
  signal: AbortSignal,
  emit: (event: ComparisonEvent) => void,
  factory: CloudConnect = connect,
): Promise<ComparisonResult> {
  const setupStarted = performance.now();
  const socket = factory(engine, key, language);
  const turns: Turn[] = [];
  const items = new Map<string, Turn>();
  const measurements: LocalMeasurement[] = [];
  let current: Turn | undefined;
  let ready = false,
    failure = '',
    started = 0,
    replayEnded = 0;
  const fail = (message: string) => {
    failure ||= message;
  };
  const send = (message: unknown) => {
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1_000_000)
      throw new Error('Cloud audio connection closed or too slow.');
    socket.send(JSON.stringify(message));
  };
  const cancel = () => socket.terminate();
  signal.addEventListener('abort', cancel, { once: true });
  socket.on('error', () =>
    fail('Connection failed. Check the API key, network, and model access.'),
  );
  socket.on('unexpected-response', (_request, response) => {
    response.resume();
    fail(
      `Connection rejected (HTTP ${response.statusCode}). Check the API key, balance, and model access.`,
    );
  });
  socket.on('close', () => fail('Cloud transcription connection closed before completion.'));
  socket.on('open', () => {
    if (engine === 'openai')
      send(transcriptionSession({ type: 'configure', model: cloudModels.openai, language }));
  });
  socket.on('message', (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      const type = event.type ?? event.message_type;
      if (type === 'session.updated' || type === 'session_started') {
        ready = true;
        return;
      }
      if (
        type === 'error' ||
        String(type).endsWith('_error') ||
        String(type).endsWith('.failed') ||
        [
          'commit_throttled',
          'quota_exceeded',
          'unaccepted_terms',
          'rate_limited',
          'queue_overflow',
          'resource_exhausted',
          'session_time_limit_exceeded',
          'invalid_request',
          'chunk_size_exceeded',
          'insufficient_audio_activity',
        ].includes(type)
      ) {
        const code = String(event.error?.code ?? type)
          .replace(/[^a-zA-Z0-9_.-]/g, '')
          .slice(0, 80);
        const rawDetail = typeof event.error === 'string' ? event.error : event.error?.message;
        const detail =
          typeof rawDetail === 'string'
            ? rawDetail
                .split(key)
                .join('[redacted]')
                .replace(/sk[-_][a-zA-Z0-9_-]+/g, '[redacted]')
                .replace(/[\r\n\t]+/g, ' ')
                .slice(0, 600)
            : '';
        const hint =
          engine === 'elevenlabs' && type === 'auth_error'
            ? 'In ElevenLabs → Developers → API Keys, enable Speech to Text access for this key and check its individual credit limit. Use the full secret key from the same workspace you funded.'
            : 'Check the provider API key permissions, usage limits and model access.';
        fail(
          `${engine === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'} transcription failed (${code}). ${detail ? `${detail} ` : ''}${hint}`,
        );
        return;
      }
      if (type === 'input_audio_buffer.committed') {
        const turn = turns.find(
          (t) => t.committed !== undefined && ![...items.values()].includes(t),
        );
        if (turn) items.set(event.item_id, turn);
        return;
      }
      const final =
        type === 'conversation.item.input_audio_transcription.completed' ||
        type === 'committed_transcript';
      const partial =
        type === 'conversation.item.input_audio_transcription.delta' ||
        type === 'partial_transcript';
      if (!final && !partial) return;
      const turn = engine === 'openai' ? items.get(event.item_id) : turns.find((t) => !t.final);
      if (!turn) return;
      turn.text =
        engine === 'openai'
          ? final
            ? (event.transcript ?? '')
            : turn.text + (event.delta ?? '')
          : (event.text ?? '');
      turn.final = final;
      const now = performance.now();
      if (turn.text.trim()) turn.first ??= now - started - turn.start;
      let measurement: LocalMeasurement | undefined;
      if (turn.text.trim()) {
        measurement = {
          turnId: turn.id,
          final,
          audioMs: turn.samples / 16,
          processingMs: 0,
          requestMs: 0,
          queueMs: 0,
          speechToTextMs: now - started - turn.speech,
          firstTextMs: turn.first!,
        };
        measurements.push(measurement);
      }
      emit({ type: 'turn', engine, id: turn.id, text: turn.text, final, measurement });
    } catch {
      fail('Invalid cloud transcription response.');
    }
  });
  async function until(predicate: () => boolean, timeoutMs: number) {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
      signal.throwIfAborted();
      if (failure) throw new Error(failure);
      if (performance.now() > deadline) throw new Error('Cloud transcription timed out.');
      await delay(10, undefined, { signal });
    }
  }
  let error: string | undefined;
  let setupMs = 0;
  try {
    await until(() => ready, 25000);
    setupMs = performance.now() - setupStarted;
    started = performance.now();
    const vad = new VoiceActivityDetector({ sampleRate: 16000, silenceMs: 500, maxTurnMs: 12000 });
    const resampler = new StreamingResampler(16000, 24000);
    const audio = (pcm: Int16Array, commit: boolean) => {
      if (engine === 'openai') {
        if (pcm.length) {
          const output = floatToPcm16(resampler.process(Float32Array.from(pcm, (x) => x / 32768)));
          send({
            type: 'input_audio_buffer.append',
            audio: Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString(
              'base64',
            ),
          });
        }
        if (commit) send({ type: 'input_audio_buffer.commit' });
      } else
        send({
          message_type: 'input_audio_chunk',
          audio_base_64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
          sample_rate: 16000,
          commit,
        });
    };
    for (let offset = 0; offset < samples.length; offset += 800) {
      signal.throwIfAborted();
      if (failure) throw new Error(failure);
      const end = Math.min(offset + 800, samples.length);
      const wait = started + end / 16 - performance.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      const frame = samples.subarray(offset, end);
      const activity = vad.feed(frame);
      if (activity.startedAtSample !== undefined) {
        current = {
          id: `turn-${turns.length + 1}`,
          start: activity.startedAtSample / 16,
          speech: end / 16,
          text: '',
          final: false,
          samples: 0,
        };
        turns.push(current);
      }
      if (!current) continue;
      if (rms(frame) >= 0.008) current.speech = end / 16;
      const pcm = concatPcm(activity.audio);
      current.samples += pcm.length;
      if (activity.commit) current.committed = performance.now();
      audio(pcm, activity.commit);
      if (activity.commit) current = undefined;
    }
    if (vad.flush() && current) {
      current.committed = performance.now();
      audio(new Int16Array(), true);
    }
    replayEnded = performance.now();
    await until(() => turns.every((t) => t.final), 30000);
  } catch (e) {
    signal.throwIfAborted();
    error = e instanceof Error ? e.message : 'Cloud comparison failed.';
  } finally {
    signal.removeEventListener('abort', cancel);
    socket.terminate();
  }
  const ended = performance.now();
  const finals = measurements
    .filter((m) => m.final)
    .map((m) => m.speechToTextMs)
    .sort((a, b) => a - b);
  const transcript = turns
    .filter((t) => t.final)
    .map((t) => t.text)
    .join(' ')
    .trim();
  return {
    engine,
    model: cloudModels[engine],
    transcript,
    measurements,
    ...(error ? { error } : {}),
    details: {
      transport: 'native WebSocket streaming',
      setupMs,
      sampleRate: engine === 'openai' ? 24000 : 16000,
      processingMetricsAvailable: false,
      estimatedAudioCostUsd:
        turns.reduce((sum, t) => sum + t.samples / 16000 / 3600, 0) *
        (engine === 'openai' ? 1.02 : 0.39),
    },
    metrics: {
      audioMs: samples.length / 16,
      wallMs: started ? ended - started : 0,
      processingMs: 0,
      processingToAudioRatio: 0,
      firstTextMs: median(turns.flatMap((t) => (t.first === undefined ? [] : [t.first]))),
      medianFinalDelayMs: median(finals),
      p95FinalDelayMs: finals.length ? finals[Math.ceil(finals.length * 0.95) - 1] : null,
      maxQueueMs: 0,
      drainMs: replayEnded ? ended - replayEnded : 0,
      requests: turns.length,
      finalTurns: turns.filter((t) => t.final).length,
      ...wordErrorRate(reference, transcript),
    },
  };
}
