import { withSetupProgress, type SetupProgress } from './setup-progress';
import type { CaptureCallbacks, Settings, Source } from '../../shared/types';
import { LocalSpeechPipeline } from './local';
import { StreamingResampler, floatToPcm16, encodeWav } from './dsp';
import { bytesToBase64, type AudioSink } from './transports';

export async function prepareLocal(token: string, update?: (progress: SetupProgress) => void) {
  return withSetupProgress(
    token,
    'local',
    async () => {
      const response = await fetch('/api/local/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Local model could not start.');
      update?.({ phase: 'ready', percent: 100, message: 'Whisper ready' });
    },
    update,
  );
}

export function createLocalSink(
  settings: Settings,
  token: string,
  source: Source,
  callbacks: CaptureCallbacks,
  fail: (message: string) => void,
): AudioSink {
  const resampler = new StreamingResampler(24000, 16000);
  const prefix = `${source}-local-${crypto.randomUUID()}`;
  let origin: number | undefined;
  const pipeline = new LocalSpeechPipeline(
    async (samples, signal) => {
      const response = await fetch('/api/local/transcribe', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
        body: JSON.stringify({
          audio: bytesToBase64(encodeWav(samples, 16000)),
          language: settings.language || 'auto',
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Local transcription failed.');
      return result;
    },
    {
      onTurn: (turn) => {
        if (turn.measurement)
          callbacks.onLocalMeasurement?.(source, turn.measurement, !turn.text.trim());
        callbacks.onTranscript({
          id: `${prefix}-${turn.id}`,
          source,
          speaker: source === 'mic' ? settings.micLabel : settings.systemLabel,
          text: turn.text,
          final: turn.final,
          timestamp:
            (origin ?? Date.now() - performance.now()) + (turn.startedAt ?? performance.now()),
          endTimestamp:
            (origin ?? Date.now() - performance.now()) + (turn.endedAt ?? performance.now()),
        });
      },
      onLevel: () => undefined,
      onStatus: (status) => callbacks.onStatus(source, `Local · ${status}`),
      onError: fail,
    },
    undefined,
    // CPU-only Windows builds should not decode the same phrase repeatedly as it grows.
    { drafts: window.callsideDesktop?.platform !== 'win32', measureEmptyResults: true },
  );
  return {
    beginTurn: () => undefined,
    commit: () => undefined,
    append(samples, timestamp) {
      origin ??= timestamp - performance.now();
      pipeline.feed(floatToPcm16(resampler.process(Float32Array.from(samples, (s) => s / 32768))));
    },
    stop: () => pipeline.finish(),
  };
}
