import type { CaptureCallbacks, Settings, Source, TranscriptEntry } from '../../shared/types.js';
import { concatPcm, encodeWav, pcmBytes, rms } from './dsp.js';
import { TranscriptAssembler } from './transcript.js';

export interface AudioSink {
  beginTurn(timestamp: number): void;
  append(samples: Int16Array, timestamp: number): void;
  commit(): void;
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
  let stopPromise: Promise<void> | undefined;
  let onProgress: (() => void) | undefined;
  let incompleteReported = false;
  const reportIncomplete = (message: string) => {
    if (!incompleteReported && transcript.pending) {
      incompleteReported = true;
      callbacks.onError(message);
    }
  };

  callbacks.onStatus(source, 'Transkription verbindet …');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => die('Die Transkription hat nach 20 Sekunden nicht geantwortet.'),
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
          prompt: settings.context.slice(0, 2000),
        }),
      );
    socket.onmessage = (message) => {
      if (failed) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(String(message.data)) as Record<string, unknown>;
      } catch {
        die('Ungültige Antwort der Transkriptionsverbindung.');
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
            (typeof event.message === 'string'
              ? event.message
              : 'Die Transkription wurde unterbrochen.'),
        );
        return;
      }
      transcript.accept(event as { type: string });
      onProgress?.();
    };
    socket.onerror = () =>
      die('Die Transkriptionsverbindung ist fehlgeschlagen. Prüfe Netzwerk und API-Schlüssel.');
    socket.onclose = () => {
      clearTimeout(timeout);
      if (closing)
        reportIncomplete(
          'Die Verbindung wurde vor dem letzten Transkriptabschluss geschlossen. Der letzte Abschnitt ist unvollständig.',
        );
      onProgress?.();
      if (!closing && !failed)
        die('Die Transkriptionsverbindung wurde geschlossen. Starte die Aufnahme erneut.');
    };
  });

  const send = (event: object) => {
    if (failed) return;
    if (socket.readyState !== WebSocket.OPEN) {
      fail('Die Audioverbindung ist nicht mehr verfügbar.');
      return;
    }
    // 4 seconds of PCM plus framing is already a visible interruption. Stop instead of dropping audio.
    if (socket.bufferedAmount > 256_000) {
      fail('Die Audioübertragung kommt nicht nach. Die Aufnahme wird beendet.');
      return;
    }
    socket.send(JSON.stringify(event));
  };
  const commit = () => {
    if (samplesInTurn < 2400) return;
    send({ type: 'input_audio_buffer.commit' });
    samplesInTurn = 0;
  };
  return {
    beginTurn(timestamp) {
      transcript.beginTurn(timestamp);
    },
    append(samples) {
      if (closing || !samples.length) return;
      samplesInTurn += samples.length;
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
              'Die Aufnahme ist beendet. Ein letzter Transkriptabschnitt konnte nicht rechtzeitig abgeschlossen werden.',
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
        `Sprecher werden erkannt${queue.length ? ` · ${queue.length} Blöcke warten` : ' …'}`,
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
              : `Sprechererkennung fehlgeschlagen (${response.status}).`,
          );
        if (!cancelled)
          for (const entry of result.entries) {
            const sourceLabel = source === 'mic' ? settings.micLabel : settings.systemLabel;
            const speakerLabel = entry.speaker.split(':').at(-1) || '?';
            callbacks.onTranscript({
              ...entry,
              speaker: `${sourceLabel} · Sprecher ${speakerLabel} · Block ${job.sequence}`,
            });
          }
      } catch (error) {
        if (!cancelled) {
          cancelled = true;
          queue.length = 0;
          fail(
            error instanceof Error && error.name !== 'AbortError'
              ? error.message
              : 'Die Sprechererkennung hat nicht rechtzeitig geantwortet.',
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    active = false;
    abort = undefined;
    if (!stopped && !cancelled) callbacks.onStatus(source, 'Hört zu · Sprecher je Block');
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
        'Die Sprechererkennung kommt nicht nach. Die Aufnahme wird beendet; erhöhe die Blocklänge oder nutze Live-Transkription.',
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
  callbacks.onStatus(source, 'Hört zu · Sprecher je Block');
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
              'Die Aufnahme ist beendet. Die letzten Blöcke konnten nicht rechtzeitig transkribiert werden.',
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
