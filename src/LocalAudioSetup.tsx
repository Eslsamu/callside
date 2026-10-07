import { useEffect, useState } from 'react';
import { prepareLocal } from './audio/local-sink';
import { withSetupProgress, type SetupProgress } from './audio/setup-progress';

export function LocalAudioSetup({
  token,
  disabled,
  onBusy,
}: {
  token: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [progress, setProgress] = useState<SetupProgress>({
    phase: 'idle',
    message:
      'Existing model files are reused. Only missing models are downloaded; Whisper needs 574 MB.',
  });
  const [downloaded, setDownloaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/local/status', {
      headers: { 'X-Callside-Token': token },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.ok) {
          const status = await response.json();
          if (!controller.signal.aborted) setDownloaded(status.downloaded === true);
        }
      })
      .catch(() => {
        /* Preparation reports any setup errors. */
      });
    return () => controller.abort();
  }, [token]);
  const [busy, setBusy] = useState(false);
  async function prepare() {
    setBusy(true);
    onBusy(true);
    setProgress({ phase: 'loading', message: 'Preparing Whisper' });
    try {
      await prepareLocal(token, setProgress);
      await withSetupProgress(
        token,
        'local-speakers',
        async () => {
          setProgress({ phase: 'loading', message: 'Preparing speaker labeling' });
          const post = async (path: string, body: object) => {
            const response = await fetch('/api/local-speakers/' + path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
              body: JSON.stringify(body),
            });
            const result = await response.json();
            if (!response.ok) throw Error(result.error || 'Speaker setup failed.');
            return result;
          };
          const { session } = await post('start', {});
          await post('audio', { session, final: true });
        },
        setProgress,
      );
      setProgress({
        phase: 'ready',
        percent: 100,
        message: 'Local audio is ready. The models are kept on this computer for future calls.',
      });
    } catch (error) {
      setProgress({
        phase: 'error',
        message:
          error instanceof Error ? error.message : 'Setup failed. Check your connection and retry.',
      });
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <section className="local-audio-setup" aria-label="Local audio setup">
      <h3>Prepare local audio</h3>
      <p className="field-help" role="status">
        {progress.phase === 'idle' && downloaded
          ? 'Whisper is already downloaded. Setup reuses it and checks the speaker-labeling model.'
          : progress.message}
      </p>
      {busy && (
        <progress
          aria-label="Model preparation"
          max={100}
          value={progress.phase === 'downloading' ? progress.percent : undefined}
        />
      )}
      <button
        className="secondary-button"
        disabled={disabled || busy || progress.phase === 'ready'}
        onClick={() => void prepare()}
      >
        {busy
          ? 'Preparing…'
          : progress.phase === 'ready'
            ? 'Models ready'
            : progress.phase === 'error'
              ? 'Retry local audio setup'
              : 'Prepare local audio'}
      </button>
      <p className="field-help">
        Downloads are kept between app updates. Loading models into memory after restarting is
        normal and does not download them again. No microphone or call audio is recorded during
        setup.
      </p>
    </section>
  );
}
