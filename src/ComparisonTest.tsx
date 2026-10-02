import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Mic, Play, Square, Upload, X } from 'lucide-react';
import type {
  ComparisonEngineId,
  ComparisonEvent,
  ComparisonMetrics,
  ComparisonReport,
} from '../shared/comparison';
import type { LocalTurn } from './audio/local';
import {
  decodeComparisonFile,
  recordComparisonAudio,
  streamComparison,
  type ComparisonAudio,
  type ComparisonRecording,
} from './audio/comparison';
import './local-test.css';
import './comparison-test.css';

interface EngineState {
  model: string;
  phase: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';
  turns: LocalTurn[];
  metrics?: ComparisonMetrics;
  error?: string;
  startedAt?: number;
}
type EngineStates = Record<ComparisonEngineId, EngineState>;
const engineNames: Record<ComparisonEngineId, string> = { whisper: 'Whisper', cohere: 'Cohere' };
const engineIds: ComparisonEngineId[] = ['whisper', 'cohere'];
const emptyEngines = (): EngineStates => ({
  whisper: { model: '', phase: 'waiting', turns: [] },
  cohere: { model: '', phase: 'waiting', turns: [] },
});
const seconds = (ms?: number | null) => (ms == null ? '—' : `${(ms / 1000).toFixed(2)} s`);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function ComparisonTest() {
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [phase, setPhase] = useState<
    'idle' | 'starting' | 'recording' | 'stopping' | 'decoding' | 'running'
  >('idle');
  const [status, setStatus] = useState('Checking local engines');
  const [error, setError] = useState('');
  const [language, setLanguage] = useState<'en' | 'de'>('de');
  const [device, setDevice] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [audio, setAudio] = useState<ComparisonAudio | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [reference, setReference] = useState('');
  const [duration, setDuration] = useState(0);
  const [level, setLevel] = useState(0);
  const [engines, setEngines] = useState<EngineStates>(emptyEngines);
  const [report, setReport] = useState<ComparisonReport | null>(null);
  const [now, setNow] = useState(0);
  const mounted = useRef(true);
  const generation = useRef(0);
  const recording = useRef<ComparisonRecording | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = phase !== 'idle';

  useEffect(() => {
    mounted.current = true;
    const initialization = new AbortController();
    void (async () => {
      try {
        const bootstrapResponse = await fetch('/api/bootstrap', { signal: initialization.signal });
        if (!bootstrapResponse.ok)
          throw new Error('Could not connect to Callside. Reload this page.');
        const bootstrap = await bootstrapResponse.json();
        const response = await fetch('/api/comparison/status', {
          headers: { 'X-Callside-Token': bootstrap.token },
          signal: initialization.signal,
        });
        if (!response.ok)
          throw new Error('The comparison server is unavailable. Start it from the repository.');
        const result = await response.json();
        if (!mounted.current) return;
        setToken(bootstrap.token);
        setReady(Boolean(result.ready));
        setEngines((current) => {
          const next = { ...current };
          for (const engine of result.engines || []) {
            if (engineIds.includes(engine.id))
              next[engine.id as ComparisonEngineId] = {
                ...next[engine.id as ComparisonEngineId],
                model: engine.model,
              };
          }
          return next;
        });
        setStatus(
          result.ready
            ? 'Microphone is off. Record or upload audio to begin.'
            : 'Local engines are not ready.',
        );
        if (result.error) setError(result.error);
        if (navigator.mediaDevices)
          setDevices(
            (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(
              (d) => d.kind === 'audioinput',
            ),
          );
      } catch (e) {
        if (!initialization.signal.aborted && mounted.current) {
          setError(errorText(e));
          setStatus('Microphone is off.');
        }
      } finally {
        if (mounted.current) setChecking(false);
      }
    })();
    const leave = () => {
      generation.current++;
      abort.current?.abort();
      recording.current?.cancel();
    };
    window.addEventListener('pagehide', leave);
    return () => {
      mounted.current = false;
      initialization.abort();
      leave();
      window.removeEventListener('pagehide', leave);
    };
  }, []);

  useEffect(() => {
    if (!audio) {
      setAudioUrl('');
      return;
    }
    const url = URL.createObjectURL(
      new Blob([audio.wav.slice().buffer as ArrayBuffer], { type: 'audio/wav' }),
    );
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audio]);
  useEffect(() => {
    if (phase !== 'running') return;
    const timer = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(timer);
  }, [phase]);

  function clearResults() {
    setReport(null);
    setEngines((current) => ({
      whisper: { model: current.whisper.model, phase: 'waiting', turns: [] },
      cohere: { model: current.cohere.model, phase: 'waiting', turns: [] },
    }));
  }

  function acceptRecording(result: ComparisonAudio, operation: number) {
    if (!mounted.current || operation !== generation.current) return;
    recording.current = null;
    setAudio(result);
    setDuration(result.duration);
    setPhase('idle');
    setStatus('Recording ready. Microphone is off.');
  }

  async function startRecording() {
    if (busy) return;
    const operation = ++generation.current;
    const controller = new AbortController();
    abort.current = controller;
    clearResults();
    setAudio(null);
    setDuration(0);
    setError('');
    setPhase('starting');
    setStatus('Waiting for microphone access');
    try {
      const handle = await recordComparisonAudio(device, controller.signal, {
        onDuration: setDuration,
        onLevel: setLevel,
        onComplete: (result) => acceptRecording(result, operation),
        onError: (message) => {
          if (!mounted.current || operation !== generation.current) return;
          recording.current = null;
          setError(message);
          setPhase('idle');
          setStatus('Microphone is off. Record again to retry.');
        },
      });
      if (!mounted.current || controller.signal.aborted || operation !== generation.current) {
        handle.cancel();
        return;
      }
      recording.current = handle;
      setPhase('recording');
      setStatus('Recording · stops automatically at 60 seconds');
      void navigator.mediaDevices
        .enumerateDevices()
        .then((inputs) => {
          if (mounted.current) setDevices(inputs.filter((d) => d.kind === 'audioinput'));
        })
        .catch(() => undefined);
    } catch (e) {
      if (mounted.current && !controller.signal.aborted && operation === generation.current) {
        setError(errorText(e));
        setPhase('idle');
        setStatus('Microphone is off.');
      }
    }
  }

  async function stopRecording() {
    if (phase !== 'recording' || !recording.current) return;
    const operation = generation.current;
    setPhase('stopping');
    setStatus('Stopping microphone');
    try {
      acceptRecording(await recording.current.stop(), operation);
    } catch (e) {
      if (mounted.current && operation === generation.current) {
        setError(errorText(e));
        setPhase('idle');
        setStatus('Microphone is off.');
      }
    }
  }

  async function upload(file?: File) {
    if (!file || busy) return;
    const operation = ++generation.current;
    setPhase('decoding');
    setStatus('Preparing audio');
    setError('');
    try {
      const result = await decodeComparisonFile(file);
      if (!mounted.current || operation !== generation.current) return;
      clearResults();
      setAudio(result);
      setDuration(result.duration);
      setStatus('Audio ready. Microphone is off.');
    } catch (e) {
      if (mounted.current && operation === generation.current) {
        setError(errorText(e));
        setStatus(
          audio ? 'Previous audio is still selected. Microphone is off.' : 'Microphone is off.',
        );
      }
    } finally {
      if (mounted.current && operation === generation.current) setPhase('idle');
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function cancel() {
    generation.current++;
    abort.current?.abort();
    recording.current?.cancel();
    recording.current = null;
    setPhase('idle');
    setStatus('Cancelled. Microphone is off.');
    setEngines(
      (current) =>
        Object.fromEntries(
          engineIds.map((id) => [
            id,
            {
              ...current[id],
              phase: current[id].phase === 'running' ? 'cancelled' : current[id].phase,
            },
          ]),
        ) as EngineStates,
    );
  }

  async function run() {
    if (!audio || busy || !ready) return;
    const operation = ++generation.current;
    const controller = new AbortController();
    abort.current = controller;
    clearResults();
    setError('');
    setPhase('running');
    setStatus('Starting local comparison. Microphone is off.');
    try {
      for await (const event of streamComparison<ComparisonEvent>(
        token,
        audio,
        language,
        reference,
        controller.signal,
      )) {
        if (!mounted.current || controller.signal.aborted || operation !== generation.current)
          return;
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'complete') {
          setReport(event.report);
          setStatus(
            event.report.results.some((result) => result.error)
              ? 'Comparison finished with an engine error.'
              : 'Comparison complete. Review the transcripts and timing below.',
          );
          continue;
        }
        if (event.type === 'start')
          setStatus(`Testing ${engineNames[event.engine]} locally. Microphone is off.`);
        setEngines((current) => {
          const engine = current[event.engine];
          if (event.type === 'start')
            return {
              ...current,
              [event.engine]: {
                ...engine,
                phase: 'running',
                model: event.model,
                startedAt: performance.now(),
              },
            };
          if (event.type === 'done')
            return {
              ...current,
              [event.engine]: {
                ...engine,
                phase: event.error ? 'failed' : 'done',
                metrics: event.metrics,
                error: event.error,
              },
            };
          const turn: LocalTurn = {
            id: event.id,
            text: event.text,
            final: event.final,
            measurement: event.measurement,
          };
          return {
            ...current,
            [event.engine]: {
              ...engine,
              turns: engine.turns.some((item) => item.id === turn.id)
                ? engine.turns.map((item) => (item.id === turn.id ? turn : item))
                : [...engine.turns, turn],
            },
          };
        });
      }
    } catch (e) {
      if (mounted.current && !controller.signal.aborted && operation === generation.current) {
        setError(errorText(e));
        setStatus('Comparison stopped. Audio is available to retry.');
        setEngines(
          (current) =>
            Object.fromEntries(
              engineIds.map((id) => [
                id,
                {
                  ...current[id],
                  phase: current[id].phase === 'running' ? 'failed' : current[id].phase,
                },
              ]),
            ) as EngineStates,
        );
      }
    } finally {
      if (mounted.current && operation === generation.current) setPhase('idle');
    }
  }

  function download() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `callside-cohere-whisper-${report.createdAt.slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <main className="local-test comparison-test">
      <header className="local-test-header">
        <a href="/">
          <ArrowLeft size={16} /> Callside
        </a>
        <span>Local model comparison</span>
      </header>
      <section className="local-test-heading">
        <h1>Cohere vs. Whisper</h1>
        <p>
          Record once, then test both models with the same audio. Each model receives a separate
          replay at speaking speed so you can compare accuracy and delay.
        </p>
      </section>
      {error && (
        <div className="local-test-error" role="alert">
          {error}
        </div>
      )}
      {!ready && !checking && (
        <div className="local-test-help">
          Run <code>npm run local:compare</code> from the repository, then open the address printed
          in the terminal.
        </div>
      )}
      <section className="local-test-controls comparison-capture" aria-label="Audio controls">
        <label>
          Language
          <select
            value={language}
            disabled={busy}
            onChange={(e) => {
              setLanguage(e.target.value as 'en' | 'de');
              clearResults();
            }}
          >
            <option value="de">German</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          Microphone
          <select value={device} disabled={busy} onChange={(e) => setDevice(e.target.value)}>
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
        <div className="comparison-record-actions">
          {phase === 'recording' || phase === 'stopping' ? (
            <button
              className="stop-button"
              onClick={() => void stopRecording()}
              disabled={phase === 'stopping'}
            >
              <Square size={16} />
              {phase === 'stopping' ? 'Stopping…' : 'Stop recording'}
            </button>
          ) : phase === 'starting' ? (
            <button className="stop-button" onClick={cancel}>
              <X size={16} />
              Cancel microphone
            </button>
          ) : (
            <button
              className="secondary-button"
              disabled={busy || checking}
              onClick={() => void startRecording()}
            >
              <Mic size={16} />
              {audio ? 'Record again' : 'Record audio'}
            </button>
          )}
          <button
            className="secondary-button"
            disabled={busy || checking}
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={16} />
            Upload WAV
          </button>
          <input
            ref={fileInput}
            className="comparison-file-input"
            type="file"
            accept=".wav,audio/wav,audio/x-wav"
            aria-label="Upload WAV file"
            tabIndex={-1}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
        </div>
      </section>
      <div className="local-test-state">
        <span role="status" className={phase === 'recording' ? 'local-live' : ''}>
          {status}
        </span>
        {phase === 'recording' && (
          <meter min="0" max="0.15" value={level} aria-label="Microphone input level" />
        )}
        <time>{duration.toFixed(1)} / 60 s</time>
      </div>
      {audio && (
        <div className="comparison-audio">
          <span>
            {audio.name} · {audio.duration.toFixed(1)} s
          </span>
          <audio controls src={audioUrl} aria-label="Review recorded audio" preload="metadata" />
        </div>
      )}
      <section className="comparison-reference">
        <label htmlFor="comparison-reference">
          Expected transcript <span>Optional · for word error rate</span>
        </label>
        <textarea
          id="comparison-reference"
          value={reference}
          disabled={busy}
          maxLength={20000}
          rows={3}
          placeholder="Paste the exact words spoken in your recording before running the comparison."
          onChange={(e) => {
            setReference(e.target.value);
            clearResults();
          }}
        />
      </section>
      <div className="comparison-run">
        {phase === 'running' ? (
          <button className="stop-button" onClick={cancel}>
            <Square size={16} />
            Cancel comparison
          </button>
        ) : (
          <button
            className="primary-button"
            disabled={busy || !audio || !ready}
            onClick={() => void run()}
          >
            <Play size={16} />
            Run comparison
          </button>
        )}
        <p>
          Allow at least twice the recording length, plus model loading and processing. Audio is
          replayed to the models silently.
        </p>
        <button className="secondary-button" disabled={!report || busy} onClick={download}>
          <Download size={16} />
          Download report
        </button>
      </div>
      <section className="comparison-workspace" aria-label="Model results">
        {engineIds.map((id) => {
          const engine = engines[id];
          const last = engine.turns.at(-1)?.measurement;
          const replaySeconds = engine.startedAt ? Math.max(0, (now - engine.startedAt) / 1000) : 0;
          const phaseLabel =
            engine.phase === 'running'
              ? replaySeconds < (audio?.duration || 0)
                ? 'Replaying audio'
                : 'Finishing transcription'
              : (
                  {
                    waiting: 'Waiting',
                    done: 'Complete',
                    failed: 'Failed',
                    cancelled: 'Cancelled',
                  } as const
                )[engine.phase];
          return (
            <article
              className="comparison-engine"
              key={id}
              aria-label={`${engineNames[id]} results`}
            >
              <header className="local-test-pane-title">
                <h2>{engineNames[id]}</h2>
                <span className={engine.phase === 'running' ? 'local-live' : ''}>{phaseLabel}</span>
              </header>
              <p className="comparison-model">{engine.model || 'Model not connected'}</p>
              {engine.phase === 'running' && (
                <div className="comparison-progress">
                  <progress
                    max={audio?.duration || 1}
                    value={Math.min(replaySeconds, audio?.duration || 1)}
                    aria-label={`${engineNames[id]} replay progress`}
                  />
                  <span>{replaySeconds.toFixed(1)} s elapsed</span>
                </div>
              )}
              <div
                className="local-test-turns comparison-turns"
                role="log"
                aria-label={`${engineNames[id]} transcript`}
                aria-live="polite"
              >
                {!engine.turns.length ? (
                  <div className="comparison-empty">
                    {engine.phase === 'running'
                      ? 'Waiting for the first transcript…'
                      : 'The transcript will appear here.'}
                  </div>
                ) : (
                  engine.turns.map((turn) => (
                    <article key={turn.id} className={turn.final ? '' : 'local-test-draft'}>
                      <div>
                        <span>{turn.final ? 'Final' : 'Draft'}</span>
                        {turn.measurement && (
                          <time>{seconds(turn.measurement.speechToTextMs)} delay</time>
                        )}
                      </div>
                      <p>{turn.text || 'No speech recognized in this phrase.'}</p>
                    </article>
                  ))
                )}
              </div>
              {engine.error && (
                <p className="comparison-engine-error" role="alert">
                  {engine.error}
                </p>
              )}
              <dl className="comparison-metrics">
                <div>
                  <dt>First text per phrase</dt>
                  <dd>{seconds(engine.metrics?.firstTextMs ?? last?.firstTextMs)}</dd>
                </div>
                <div>
                  <dt>Median final delay</dt>
                  <dd>{seconds(engine.metrics?.medianFinalDelayMs)}</dd>
                </div>
                <div>
                  <dt>95th percentile final delay</dt>
                  <dd>{seconds(engine.metrics?.p95FinalDelayMs)}</dd>
                </div>
                <div>
                  <dt>Longest queue wait</dt>
                  <dd>{seconds(engine.metrics?.maxQueueMs)}</dd>
                </div>
                <div>
                  <dt>Processing / audio</dt>
                  <dd>
                    {engine.metrics ? `${engine.metrics.processingToAudioRatio.toFixed(2)}×` : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Word error rate</dt>
                  <dd>
                    {engine.metrics?.wer != null
                      ? `${(engine.metrics.wer * 100).toFixed(1)}%`
                      : '—'}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </section>
      <footer className="local-test-footer comparison-footer">
        <p>
          Lower delay and word error rate are better. Final delay includes the pause used to finish
          a phrase, queued work, and transcription. First text is measured from the start of a
          phrase; the completed report shows its median.
        </p>
        <p>
          Audio stays in memory on this computer. No API key, cloud transcription, or speaker
          identification. The downloaded JSON contains transcripts, timing measurements, model
          details, and the reference text; it does not contain audio.
        </p>
        <p>
          This compares Cohere Transcribe with local Whisper, the open model. It does not test the
          commercial Wispr Flow app.
        </p>
      </footer>
    </main>
  );
}
