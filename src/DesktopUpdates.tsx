import { useEffect, useState } from 'react';
export function DesktopUpdates({ disabled }: { disabled: boolean }) {
  const [state, setState] = useState<{
    phase: string;
    version: string;
    message: string;
    percent?: number;
    nextVersion?: string;
  }>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () =>
      window.callsideDesktop
        ?.updates?.('status')
        .then((value) => {
          if (active) setState(value);
        })
        .catch(() => {});
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function action(value: 'check' | 'install') {
    setError('');
    try {
      const next = await window.callsideDesktop!.updates(value);
      if (next) setState(next);
    } catch {
      setError('Could not update. Finish your call and try again.');
    }
  }
  if (!state) return null;
  return (
    <section className="desktop-updates" aria-label="Application updates">
      <div>
        <h2>Callside {state.version}</h2>
        <p className="field-help" role="status">
          {error || state.message}
        </p>
      </div>
      {state.phase === 'downloading' && (
        <progress aria-label="Update download" max={100} value={state.percent} />
      )}
      <button
        className="secondary-button"
        disabled={disabled || ['unavailable', 'checking', 'downloading'].includes(state.phase)}
        onClick={() => void action(state.phase === 'ready' ? 'install' : 'check')}
      >
        {state.phase === 'ready' ? 'Restart and update' : 'Check for updates'}
      </button>
    </section>
  );
}
