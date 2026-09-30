import { z } from 'zod';
import type {
  CaptureCallbacks,
  Settings,
  SpeakerReference,
  SpeakerSegment,
} from '../../shared/types.js';
import { concatPcm, encodeWav, rms } from './dsp.js';
import { bytesToBase64, type AudioSink } from './transports.js';

const responseSchema = z.object({
  entries: z
    .array(
      z.object({
        speaker: z.string().max(200),
        text: z.string().max(12000),
        timestamp: z.number().finite(),
        endTimestamp: z.number().finite(),
      }),
    )
    .max(2000),
});
type Segment = z.infer<typeof responseSchema>['entries'][number];
interface Job {
  samples: Int16Array;
  timestamp: number;
  chunkId: string;
  sequence: number;
}

/** Voice clips only live in this capture's memory and are cleared on stop. */
class SpeakerReferences {
  readonly clips = new Map<string, SpeakerReference>();

  assign(job: Job, entries: Segment[]): SpeakerSegment[] {
    const assignments = new Map<
      string,
      { speaker: string; speakerId: string; attribution: 'reference' | 'chunk' }
    >();
    const label = (entry: Segment) => entry.speaker.split(':').at(-1)!;
    for (const entry of entries) {
      const raw = label(entry);
      if (assignments.has(raw)) continue;
      let name = this.clips.has(raw) ? raw : undefined;
      if (!name && this.clips.size < 4) {
        // Use a single-speaker interval of at least two seconds. Never enroll overlap.
        const clean = entries
          .filter(
            (candidate) =>
              label(candidate) === raw &&
              candidate.endTimestamp - candidate.timestamp >= 2000 &&
              !entries.some(
                (other) =>
                  label(other) !== raw &&
                  other.timestamp < candidate.endTimestamp &&
                  other.endTimestamp > candidate.timestamp,
              ),
          )
          .sort((a, b) => b.endTimestamp - b.timestamp - (a.endTimestamp - a.timestamp))[0];
        if (clean) {
          const start = Math.max(0, Math.round((clean.timestamp - job.timestamp) * 24));
          const end = Math.min(
            job.samples.length,
            Math.round((clean.endTimestamp - job.timestamp) * 24),
            start + 6 * 24000,
          );
          const samples = job.samples.slice(start, end);
          if (samples.length >= 2 * 24000 && rms(samples) > 0.003) {
            name = `speaker_${this.clips.size + 1}`;
            this.clips.set(name, { name, audio: bytesToBase64(encodeWav(samples)) });
          }
        }
      }
      assignments.set(
        raw,
        name
          ? {
              speaker: `Speaker ${name.slice(-1)}`,
              speakerId: name,
              attribution: 'reference',
            }
          : {
              // A file-local label is never promoted to a session-wide identity without a clip.
              speaker: `Unidentified voice · batch ${job.sequence} · ${raw}`,
              speakerId: `${job.chunkId}:${raw}`,
              attribution: 'chunk',
            },
      );
    }
    return entries.map((entry) => ({
      timestamp: entry.timestamp,
      endTimestamp: entry.endTimestamp,
      text: entry.text,
      ...assignments.get(label(entry))!,
    }));
  }
}

/** Secondary analysis never emits another transcript or stops the live connection. */
export function createBackgroundSpeakerSink(
  settings: Settings,
  token: string,
  callbacks: CaptureCallbacks,
): AudioSink {
  const chunkSamples = Math.round(
    Math.max(4, Math.min(30, settings.diarizationChunkSeconds)) * 24000,
  );
  const overlapSamples = Math.min(2 * 24000, Math.floor(chunkSamples / 4));
  const references = new SpeakerReferences();
  let parts: Int16Array[] = [];
  let buffered = 0,
    fresh = 0,
    startedAt = 0,
    sequence = 0;
  let active = false,
    stopped = false,
    cancelled = false;
  let abort: AbortController | undefined;
  let stopPromise: Promise<void> | undefined;
  let idle: (() => void) | undefined;
  const queue: Job[] = [];
  const status = (message: string) => callbacks.onAttributionStatus?.(message);

  const processQueue = async () => {
    if (active || cancelled) return;
    active = true;
    while (queue.length && !cancelled) {
      const job = queue.shift()!;
      const endTimestamp = job.timestamp + job.samples.length / 24;
      abort = new AbortController();
      const timeout = setTimeout(() => abort?.abort(), 30000);
      const requestStarted = Date.now();
      status(
        `Identifying call speakers${queue.length ? ` · ${queue.length} batches waiting` : ' …'}`,
      );
      try {
        const response = await fetch('/api/diarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
          signal: abort.signal,
          body: JSON.stringify({
            audio: bytesToBase64(encodeWav(job.samples)),
            source: 'system',
            chunkId: job.chunkId,
            timestamp: job.timestamp,
            language: settings.language,
            knownSpeakers: [...references.clips.values()],
          }),
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            typeof result.error === 'string'
              ? result.error
              : `Speaker attribution failed (${response.status}).`,
          );
        const parsed = responseSchema.safeParse(result);
        if (!parsed.success) throw new Error('Speaker attribution returned invalid timestamps.');
        const entries = parsed.data.entries;
        if (
          entries.some(
            (entry) =>
              entry.timestamp < job.timestamp - 100 ||
              entry.endTimestamp < entry.timestamp ||
              entry.endTimestamp > endTimestamp + 500,
          )
        )
          throw new Error('Speaker attribution returned timestamps outside its audio batch.');
        if (!cancelled) {
          const segments = references.assign(job, entries);
          callbacks.onAttribution?.({
            chunkId: job.chunkId,
            timestamp: job.timestamp,
            endTimestamp,
            receivedAt: Date.now(),
            segments,
          });
          status(
            `Speaker labels updated · ${references.clips.size} reference voices · ${((Date.now() - requestStarted) / 1000).toFixed(1)} s processing`,
          );
        }
      } catch (error) {
        if (!cancelled) {
          cancelled = true;
          queue.length = 0;
          parts = [];
          references.clips.clear();
          status(
            `Speaker attribution paused: ${error instanceof Error && error.name !== 'AbortError' ? error.message : 'request timed out'}. Live transcription continues.`,
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    active = false;
    abort = undefined;
    idle?.();
  };

  const flush = (final = false) => {
    if (!fresh || cancelled) {
      if (final) parts = [];
      return;
    }
    const samples = concatPcm(parts);
    const timestamp = startedAt;
    if (final) {
      parts = [];
      buffered = 0;
    } else {
      const overlap = samples.slice(-overlapSamples);
      parts = [overlap];
      buffered = overlap.length;
      startedAt = timestamp + (samples.length - overlap.length) / 24;
    }
    fresh = 0;
    // Silent batches and sub-100ms tails are not sent to the paid endpoint.
    if (samples.length < 2400 || rms(samples) < 0.003) return;
    if (queue.length >= 2) {
      queue.shift();
      status(
        'Speaker attribution is behind · skipping an older batch. Live transcription continues.',
      );
    }
    queue.push({ samples, timestamp, chunkId: crypto.randomUUID(), sequence: ++sequence });
    void processQueue();
  };
  status(`Speaker labels pending · ${settings.diarizationChunkSeconds}-second batches`);
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
        fresh += count;
        offset += count;
        if (buffered === chunkSamples) flush();
      }
    },
    commit() {},
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      flush(true);
      stopPromise = new Promise<void>((resolve) => {
        const finish = () => {
          references.clips.clear();
          parts = [];
          idle = undefined;
          resolve();
        };
        const timer = setTimeout(() => {
          cancelled = true;
          queue.length = 0;
          abort?.abort();
          status(
            'Speaker attribution ended · some final labels are pending. The live transcript is preserved.',
          );
          finish();
        }, 10000);
        idle = () => {
          if (!active && !queue.length) {
            clearTimeout(timer);
            finish();
          }
        };
        idle();
      });
      return stopPromise;
    },
  };
}
