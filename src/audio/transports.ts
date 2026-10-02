import type { CaptureCallbacks, Settings, Source, TranscriptEntry } from '../../shared/types.js';
import { concatPcm, encodeWav, pcmBytes, rms } from './dsp.js';
import { TranscriptAssembler } from './transcript.js';

export interface AudioSink {
  beginTurn(timestamp: number): void;
  append(samples: Int16Array, timestamp: number): void;
  commit(timestamp?: number): void;
  stop(): Promise<void>;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export async function createRealtimeSink(
  settings: Settings,
  token: string,
  source: Source,
  callbacks: CaptureCallbacks,
  fail: (message: string) => void,
): Promise<AudioSink> {
  const url = new URL('/api/realtime', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('source', source);
  const socket = new WebSocket(url);
  const transcript = new TranscriptAssembler(
    source,
    source === 'mic' ? settings.micLabel : settings.systemLabel,
    callbacks.onTranscript,
  );
  let closing = false;
  let ready = false;
  let failed = false;
  let samplesInTurn = 0;
  let latestAudioEnd = 0;
  let stopPromise: Promise<void> | undefined;
  let onProgress: (() => void) | undefined;
  let incompleteReported = false;
  const reportIncomplete = (message: string) => {
    if (!incompleteReported && transcript.pending) {
      incompleteReported = true;
      callbacks.onError(message);
    }
  };

  callbacks.onStatus(source, 'Connecting transcription …');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => die('Transcription did not respond within 20 seconds.'),
      20_000,
    );
    const die = (message: string) => {
      if (failed) return;
      failed = true;
      clearTimeout(timeout);
      if (closing) reportIncomplete(message);
      socket.close();
      if (!ready) reject(new Error(message));
      else if (!closing) fail(message);
      onProgress?.();
    };
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: 'configure',
          model: settings.transcriptionModel,
          language: settings.language,
        }),
      );
    socket.onmessage = (message) => {
      if (failed) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(String(message.data)) as Record<string, unknown>;
      } catch {
        die('Invalid response from the transcription connection.');
        return;
      }
      if (event.type === 'ready') {
        ready = true;
        clearTimeout(timeout);
        callbacks.onStatus(source, 'Live');
        resolve();
        return;
      }
      if (
        event.type === 'error' ||
        event.type === 'conversation.item.input_audio_transcription.failed'
      ) {
        const detail = event.error as { message?: string } | undefined;
        die(
          detail?.message ||
            (typeof event.message === 'string' ? event.message : 'Transcription was interrupted.'),
        );
        return;
      }
      transcript.accept(event as { type: string });
      onProgress?.();
    };
    socket.onerror = () =>
      die('The transcription connection failed. Check your network and API key.');
    socket.onclose = () => {
      clearTimeout(timeout);
      if (closing)
        reportIncomplete(
          'The connection closed before the final transcript was complete. The last segment is incomplete.',
        );
      onProgress?.();
      if (!closing && !failed) die('The transcription connection closed. Restart recording.');
    };
  });

  const send = (event: object) => {
    if (failed) return;
    if (socket.readyState !== WebSocket.OPEN) {
      fail('The audio connection is no longer available.');
      return;
    }
    // 4 seconds of PCM plus framing is already a visible interruption. Stop instead of dropping audio.
    if (socket.bufferedAmount > 256_000) {
      fail('Audio transmission cannot keep up. Recording is stopping.');
      return;
    }
    socket.send(JSON.stringify(event));
  };
  const commit = (timestamp = latestAudioEnd) => {
    if (samplesInTurn < 2400) return;
    transcript.endTurn(timestamp);
    send({ type: 'input_audio_buffer.commit' });
    samplesInTurn = 0;
  };
  return {
    beginTurn(timestamp) {
      transcript.beginTurn(timestamp);
    },
    append(samples, timestamp) {
      if (closing || !samples.length) return;
      samplesInTurn += samples.length;
      latestAudioEnd = timestamp + samples.length / 24;
      send({ type: 'input_audio_buffer.append', audio: bytesToBase64(pcmBytes(samples)) });
    },
    commit,
    stop() {
      if (stopPromise) return stopPromise;
      commit();
      closing = true;
      stopPromise = new Promise<void>((resolve) => {
        let finished = false;
        const finish = (timedOut = false) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          onProgress = undefined;
          if (timedOut)
            reportIncomplete(
              'Recording has ended. The final transcript segment could not finish in time.',
            );
          socket.close();
          resolve();
        };
        const timeout = setTimeout(() => finish(true), 8000);
        onProgress = () => {
          if (transcript.pending === 0 || socket.readyState === WebSocket.CLOSED) finish();
        };
        onProgress();
      });
      return stopPromise;
    },
  };
}

interface DiarizationJob {
  samples: Int16Array;
  timestamp: number;
  chunkId: string;
  sequence: number;
}

export function createDiarizedSink(
  settings: Settings,
  token: string,
  source: Source,
  callbacks: CaptureCallbacks,
  fail: (message: string) => void,
): AudioSink {
  const chunkSamples = Math.round(
    Math.max(3, Math.min(30, settings.diarizationChunkSeconds)) * 24_000,
  );
  let parts: Int16Array[] = [];
  let buffered = 0;
  let startedAt = 0;
  let active = false;
  let stopped = false;
  let cancelled = false;
  let abort: AbortController | undefined;
  let stopPromise: Promise<void> | undefined;
  let idle: (() => void) | undefined;
  let sequence = 0;
  const queue: DiarizationJob[] = [];

  const processQueue = async (): Promise<void> => {
    if (active || cancelled) return;
    active = true;
    while (queue.length && !cancelled) {
      const job = queue.shift()!;
      abort = new AbortController();
      const timeout = setTimeout(() => abort?.abort(), 30_000);
      callbacks.onStatus(
        source,
        `Identifying speakers${queue.length ? ` · ${queue.length} chunks waiting` : ' …'}`,
      );
      try {
        const response = await fetch('/api/diarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
          signal: abort.signal,
          body: JSON.stringify({
            audio: bytesToBase64(encodeWav(job.samples)),
            source,
            chunkId: job.chunkId,
            timestamp: job.timestamp,
            language: settings.language,
          }),
        });
        const result = (await response.json()) as { entries?: TranscriptEntry[]; error?: string };
        if (!response.ok || !Array.isArray(result.entries))
          throw new Error(
            typeof result.error === 'string'
              ? result.error
              : `Speaker identification failed (${response.status}).`,
          );
        if (!cancelled)
          for (const entry of result.entries) {
            const sourceLabel = source === 'mic' ? settings.micLabel : settings.systemLabel;
            const speakerLabel = entry.speaker.split(':').at(-1) || '?';
            callbacks.onTranscript({
              ...entry,
              speaker: `${sourceLabel} · Speaker ${speakerLabel} · Chunk ${job.sequence}`,
            });
          }
      } catch (error) {
        if (!cancelled) {
          cancelled = true;
          queue.length = 0;
          fail(
            error instanceof Error && error.name !== 'AbortError'
              ? error.message
              : 'Speaker identification timed out.',
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    active = false;
    abort = undefined;
    if (!stopped && !cancelled) callbacks.onStatus(source, 'Listening · speakers per chunk');
    idle?.();
  };

  const flush = () => {
    if (!buffered) return;
    const samples = concatPcm(parts);
    parts = [];
    buffered = 0;
    if (cancelled) return;
    // Do not bill for silence; retain the original block's timestamp for every audible block.
    if (samples.length < 2400 || rms(samples) < 0.003) return;
    if (queue.length >= 2) {
      cancelled = true;
      queue.length = 0;
      abort?.abort();
      fail(
        'Speaker identification cannot keep up. Recording is stopping; increase chunk length or use live transcription.',
      );
      return;
    }
    queue.push({
      samples,
      timestamp: startedAt,
      chunkId: crypto.randomUUID(),
      sequence: ++sequence,
    });
    void processQueue();
  };
  callbacks.onStatus(source, 'Listening · speakers per chunk');
  return {
    beginTurn() {},
    append(samples, timestamp) {
      if (stopped || cancelled) return;
      let offset = 0;
      while (offset < samples.length) {
        if (!buffered) startedAt = timestamp + offset / 24;
        const count = Math.min(chunkSamples - buffered, samples.length - offset);
        parts.push(samples.slice(offset, offset + count));
        buffered += count;
        offset += count;
        if (buffered >= chunkSamples) flush();
      }
    },
    commit() {},
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      flush();
      stopPromise = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (active || queue.length)
            callbacks.onError(
              'Recording has ended. The final chunks could not be transcribed in time.',
            );
          cancelled = true;
          queue.length = 0;
          abort?.abort();
          resolve();
        }, 20_000);
        idle = () => {
          if (!active && !queue.length) {
            clearTimeout(timer);
            idle = undefined;
            resolve();
          }
        };
        idle();
      });
      return stopPromise;
    },
  };
}
