import { withSetupProgress } from './setup-progress';
import type { CaptureCallbacks } from '../../shared/types';
import { bytesToBase64, type AudioSink } from './transports';

/** Continuous PCM preserves one model timeline and speaker state across the call. */
export async function createLocalSpeakerSink(
  token: string,
  callbacks: CaptureCallbacks,
): Promise<AudioSink> {
  const post = async (path: string, body: object) => {
    const response = await fetch('/api/local-speakers/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Local speaker labeling failed.');
    return result;
  };
  const { session } = await withSetupProgress(
    token,
    'local-speakers',
    () => post('start', {}),
    (progress) =>
      callbacks.onAttributionStatus?.(
        progress.message +
          (progress.percent === undefined ? '' : ' · ' + Math.round(progress.percent) + '%'),
      ),
  );
  let origin: number | undefined,
    buffer = new Int16Array(96000),
    length = 0;
  let chain = Promise.resolve(),
    queued = 0,
    failed = false,
    stopped = false,
    sequence = 0;
  callbacks.onAttributionStatus?.('Local speaker labels pending · experimental');
  const send = (audio?: Int16Array, final = false) => {
    queued++;
    chain = chain
      .then(async () => {
        if (failed && !final) return;
        const result = await post('audio', {
          session,
          final,
          ...(audio
            ? {
                audio: bytesToBase64(
                  new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
                ),
              }
            : {}),
        });
        if (origin === undefined) return;
        callbacks.onAttribution?.({
          chunkId: session + '-' + sequence++,
          timestamp: origin + result.from * 1000,
          endTimestamp: origin + result.through * 1000,
          receivedAt: Date.now(),
          segments: result.segments.map(
            (segment: { start: number; end: number; speaker: number }) => ({
              timestamp: origin! + segment.start * 1000,
              endTimestamp: origin! + segment.end * 1000,
              speaker: 'Speaker ' + (segment.speaker + 1) + ' · local',
              speakerId: session + '-' + segment.speaker,
              attribution: 'local' as const,
              text: '',
            }),
          ),
        });
        callbacks.onAttributionStatus?.(
          result.segments.length
            ? 'Local speaker labels updated · experimental'
            : 'Local speaker labels pending · experimental',
        );
      })
      .catch((error) => {
        failed = true;
        callbacks.onAttributionStatus?.(
          error instanceof Error ? error.message : 'Local speaker labeling failed.',
        );
      })
      .finally(() => {
        queued--;
      });
  };
  return {
    beginTurn() {},
    commit() {},
    append(samples, timestamp) {
      if (failed || stopped) return;
      origin ??= timestamp;
      if (queued >= 4) {
        failed = true;
        callbacks.onAttributionStatus?.(
          'Local speaker analysis cannot keep up. Transcription continues; restart the call to retry.',
        );
        send(undefined, true);
        return;
      }
      let offset = 0;
      while (offset < samples.length) {
        const count = Math.min(buffer.length - length, samples.length - offset);
        buffer.set(samples.subarray(offset, offset + count), length);
        length += count;
        offset += count;
        if (length === buffer.length) {
          send(buffer);
          buffer = new Int16Array(96000);
          length = 0;
        }
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (!failed && length) send(buffer.slice(0, length));
      if (!failed) send(undefined, true);
      await chain;
    },
  };
}
