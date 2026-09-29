import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Mic, Square } from 'lucide-react';
import { startLocalCapture, type LocalCapture, type LocalTurn } from './audio/local';
import type { LocalMeasurement } from '../shared/local-test';
import './local-test.css';

const seconds = (ms?: number) =>
  ms === undefined ? 'Waiting for speech' : `${(ms / 1000).toFixed(2)} s`;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
    : undefined;
};

export default function LocalTest() {
  const [token, setToken] = useState('');
  const [model, setModel] = useState('');
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<
    'loading' | 'idle' | 'starting' | 'listening' | 'stopping' | 'stopped'
  >('loading');
  const [status, setStatus] = useState('Checking local engine');
  const [error, setError] = useState('');
  const [language, setLanguage] = useState('de');
  const [device, setDevice] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [turns, setTurns] = useState<LocalTurn[]>([]);
  const [metrics, setMetrics] = useState<LocalMeasurement[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [reportWarning, setReportWarning] = useState('');
  const capture = useRef<LocalCapture | null>(null);
  const mounted = useRef(true);
  const transcript = useRef<HTMLDivElement>(null);
  const began = useRef(0);
  const active = ['starting', 'listening', 'stopping'].includes(phase);
  const last = metrics.at(-1);
  const finals = metrics.filter((m) => m.final);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const bootstrap = await fetch('/api/bootstrap').then((r) => r.json());
        const response = await fetch('/api/local-test/status', {
          headers: { 'X-Callside-Token': bootstrap.token },
        });
        if (!response.ok) throw new Error('Could not check the local engine. Reload this page.');
        const result = await response.json();
        if (!mounted.current) return;
        setToken(bootstrap.token);
        setModel(result.model || '');
        setReady(result.ready);
        setStatus(result.ready ? 'Ready. Microphone is off.' : 'Local engine is not running');
        setPhase('idle');
        if (navigator.mediaDevices)
          setDevices(
            (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(
              (d) => d.kind === 'audioinput',
            ),
          );
      } catch (e) {
        if (mounted.current) {
          setError(String(e));
          setPhase('idle');
        }
      }
    })();
    const leave = () => capture.current?.cancel();
    window.addEventListener('pagehide', leave);
    return () => {
      mounted.current = false;
      leave();
      window.removeEventListener('pagehide', leave);
    };
  }, []);

  useEffect(() => {
    if (phase !== 'listening') return;
    const timer = setInterval(
      () => setElapsed(Math.floor((performance.now() - began.current) / 1000)),
      250,
    );
    return () => clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [turns]);

  async function start() {
    if (active || !ready) return;
    setPhase('starting');
    setError('');
    setReportWarning('');
    setStatus('Waiting for microphone access');
    setTurns([]);
    setMetrics([]);
    setElapsed(0);
    try {
      const reset = await fetch('/api/local-test/measurements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
        body: JSON.stringify({ reset: true }),
      });
      if (!reset.ok) throw new Error('Could not start a fresh test. Reload the page.');
      const handle = await startLocalCapture(token, language, device, {
        onTurn: (turn) => {
          setTurns((current) => {
            const index = current.findIndex((entry) => entry.id === turn.id);
            if (index < 0) return [...current, turn];
            return current.map((entry) => (entry.id === turn.id ? turn : entry));
          });
          if (turn.measurement) {
            setMetrics((current) => [...current, turn.measurement!]);
            void fetch('/api/local-test/measurements', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
              body: JSON.stringify(turn.measurement),
            })
              .then((r) => {
                if (!r.ok) throw new Error();
              })
              .catch(() =>
                setReportWarning(
                  'Timing history could not reach the local server. Download the report before closing this page.',
                ),
              );
          }
        },
        onLevel: setLevel,
        onStatus: setStatus,
        onError: (message) => {
          setError(message);
          setPhase('stopped');
          setStatus('Microphone is off');
          capture.current = null;
        },
      });
      if (!mounted.current) {
        handle.cancel();
        return;
      }
      capture.current = handle;
      began.current = performance.now();
      setPhase('listening');
      // Device labels are optional. A failed refresh must not hide Stop while the
      // already-open microphone continues capturing.
      void navigator.mediaDevices
        .enumerateDevices()
        .then((inputs) => {
          if (mounted.current) setDevices(inputs.filter((d) => d.kind === 'audioinput'));
        })
        .catch(() => undefined);
    } catch (e) {
      capture.current?.cancel();
      capture.current = null;
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Microphone is off');
      setPhase('stopped');
    }
  }

  async function stop() {
    if (phase !== 'listening') return;
    setPhase('stopping');
    setStatus('Finishing the last phrase. Microphone is stopping.');
    try {
      await capture.current?.stop();
    } finally {
      capture.current = null;
      setPhase('stopped');
      setStatus('Test complete. Microphone is off.');
    }
  }

  function download() {
    const report = {
      model,
      language,
      elapsedSeconds: elapsed,
      measurements: metrics,
      transcript: turns.map(({ id, text, final }) => ({ id, text, final })),
      note: 'Approximate browser-side timings. Speech-to-text measures the last detected speech in a snapshot to the text callback, before browser paint. Microphone hardware delay is not calibrated.',
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'callside-local-test.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <main className="local-test">
      <header className="local-test-header">
        <a href="/">
          <ArrowLeft size={16} /> Callside
        </a>
        <span>Local transcription test</span>
      </header>
      <section className="local-test-heading">
        <h1>Speak. See how quickly it lands.</h1>
        <p>
          Test your microphone with local Whisper. Speak naturally for 30–60 seconds, pause between
          a few phrases, then stop and review.
        </p>
      </section>
      {error && (
        <div className="local-test-error" role="alert">
          {error}
        </div>
      )}
      {!ready && phase === 'idle' && (
        <div className="local-test-help">
          Run <code>npm run local:test</code> from the repository, then open the URL printed in your
          terminal.
        </div>
      )}
      <section className="local-test-controls" aria-label="Recording controls">
        <label>
          Language
          <select value={language} disabled={active} onChange={(e) => setLanguage(e.target.value)}>
            <option value="de">German</option>
            <option value="en">English</option>
            <option value="auto">Detect automatically</option>
          </select>
        </label>
        <label>
          Microphone
          <select value={device} disabled={active} onChange={(e) => setDevice(e.target.value)}>
            <option value="">System default</option>
            {devices
              .filter((d) => d.deviceId && d.deviceId !== 'default')
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
          </select>
        </label>
        <div className="local-test-actions">
          {phase === 'listening' || phase === 'stopping' ? (
            <button
              className="stop-button"
              onClick={() => void stop()}
              disabled={phase === 'stopping'}
            >
              <Square size={16} />
              {phase === 'stopping' ? 'Finishing…' : 'Stop'}
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={!ready || phase === 'starting'}
              onClick={() => void start()}
            >
              <Mic size={17} />
              {phase === 'starting'
                ? 'Connecting…'
                : phase === 'stopped'
                  ? 'Start a new test'
                  : 'Start microphone'}
            </button>
          )}
        </div>
      </section>
      <div className="local-test-state">
        <span className={phase === 'listening' ? 'local-live' : ''}>{status}</span>
        <meter min="0" max="0.15" value={level} aria-label="Microphone input level" />
        <time>
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
        </time>
      </div>
      <section className="local-test-workspace">
        <div className="local-test-transcript">
          <div className="local-test-pane-title">
            <h2>Live transcript</h2>
            <span>Me · microphone</span>
          </div>
          <div
            ref={transcript}
            className="local-test-turns"
            role="log"
            aria-label="Live transcript"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {!turns.length ? (
              <div className="local-test-empty">
                <Mic size={28} />
                <p>
                  {phase === 'listening'
                    ? 'Listening for your first phrase…'
                    : 'Your words will appear here.'}
                </p>
                <span>Live drafts update as you speak. A short pause finalizes each phrase.</span>
              </div>
            ) : (
              turns.map((turn) => (
                <article key={turn.id} className={turn.final ? '' : 'local-test-draft'}>
                  <div>
                    <strong>Me</strong>
                    <span>{turn.final ? 'Final' : 'Live draft'}</span>
                    {turn.measurement && (
                      <time>{seconds(turn.measurement.speechToTextMs)} delay</time>
                    )}
                  </div>
                  <p>{turn.text || 'No speech recognized in this phrase.'}</p>
                </article>
              ))
            )}
          </div>
        </div>
        <aside className="local-test-timing">
          <h2>Timing</h2>
          <dl>
            <div>
              <dt>Latest speech → text</dt>
              <dd>{seconds(last?.speechToTextMs)}</dd>
              <p>Last detected speech in the audio snapshot to text arriving in this page.</p>
            </div>
            <div>
              <dt>Local processing</dt>
              <dd>{seconds(last?.processingMs)}</dd>
              <p>Time spent waiting for the local Whisper engine.</p>
            </div>
            <div>
              <dt>First text in latest phrase</dt>
              <dd>{seconds(last?.firstTextMs)}</dd>
            </div>
            <div>
              <dt>Median final delay</dt>
              <dd>{seconds(median(finals.map((m) => m.speechToTextMs)))}</dd>
              <p>
                {finals.length} finalized {finals.length === 1 ? 'phrase' : 'phrases'}. A natural
                pause adds about 0.5 s.
              </p>
            </div>
          </dl>
          <button
            className="secondary-button"
            disabled={!metrics.length || active}
            onClick={download}
          >
            <Download size={16} />
            Download test report
          </button>
          <p className="local-test-report-note">
            Includes the transcript and timing samples. Available after stopping.
          </p>
        </aside>
      </section>
      {reportWarning && <p role="alert">{reportWarning}</p>}
      <footer className="local-test-footer">
        <p>{model ? `Whisper ${model}` : 'Local Whisper'} · No API key · No per-minute fee</p>
        <p>
          Audio stays on this computer and is not saved. Text stays in this tab unless you download
          it. Timing samples stay in local server memory until restart.
        </p>
        <p>
          Approximate timing, before browser paint. This solo test measures transcription, not
          speaker identification or answer generation.
        </p>
      </footer>
    </main>
  );
}
