import { ANSWER_MODELS, reasoningOptions } from '../shared/models';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Download,
  Headphones,
  Keyboard,
  Mic,
  Pin,
  Play,
  Radio,
  Settings2,
  Square,
  Volume2,
  X,
  Zap,
} from 'lucide-react';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type {
  Bootstrap,
  CaptureHandle,
  Settings,
  Source,
  Suggestion,
  TranscriptEntry,
} from '../shared/types';
import { startCapture } from './audio/capture';
import { TranscriptReconciler } from './audio/reconcile';
import { streamAnswer } from './api';
import { DEMO_TURNS, safeSettings, sessionMarkdown } from './session';

const settingsKey = 'callside.settings.v1';
function loadSettings(): Settings {
  try {
    return safeSettings(JSON.parse(localStorage.getItem(settingsKey) || 'null'), DEFAULT_SETTINGS);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
const presets = {
  universal: { name: 'General', prompt: DEFAULT_SETTINGS.systemPrompt },
  sales: {
    name: 'Sales',
    prompt:
      'You are helping me during a sales call. Suggest a short, useful answer to the latest question or objection. Ask an open question when needs are unclear. Do not invent prices, guarantees, references, or product capabilities. Use the language of the conversation. Use at most three short sentences.',
  },
  interview: {
    name: 'Interview',
    prompt:
      'You are helping me during an interview. Help me clearly describe the experience provided in the conversation context. Do not invent qualifications or experiences. When facts are missing, suggest a follow-up question or an answer structure. Use the language of the conversation. Use at most three short sentences.',
  },
};
const time = (value: number) =>
  new Date(value).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<'session' | 'settings'>('session');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [demo, setDemo] = useState(false);
  const [auto, setAuto] = useState(false);
  const [consent, setConsent] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [rememberKey, setRememberKey] = useState(true);
  const [pin, setPin] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [levels, setLevels] = useState<Record<Source, number>>({ mic: 0, system: 0 });
  const [sourceStatus, setSourceStatus] = useState<Record<Source, string>>({
    mic: 'Ready',
    system: 'Ready',
  });
  const [attributionStatus, setAttributionStatus] = useState('');
  const [copied, setCopied] = useState('');
  const captureRef = useRef<CaptureHandle | null>(null);
  const answerRef = useRef<AbortController | null>(null);
  const demoTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ settings, entries, suggestions, bootstrap, demo, auto, listening });
  latest.current = { settings, entries, suggestions, bootstrap, demo, auto, listening };
  const busyRef = useRef(false);
  const activeMode = useRef<'manual' | 'auto' | null>(null);
  const autoSeen = useRef('');
  const lastAutoAt = useRef(0);
  const sessionEpoch = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const shortcuts = useRef<Record<string, boolean>>({});
  const reconciler = useRef(new TranscriptReconciler());
  const echoNotified = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/bootstrap', { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('The local server is unavailable. Restart the app.');
        setBootstrap(await r.json());
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    window.callsideDesktop
      ?.getShortcutStatus()
      .then((status) => {
        shortcuts.current = Object.fromEntries(status.map((s) => [s.accelerator, s.registered]));
        if (status.some((s) => !s.registered))
          setNotice(
            'A global shortcut is already in use. Use the other shortcut or the answer button.',
          );
      })
      .catch(() => {});
    return () => {
      abort.abort();
    };
  }, []);
  useEffect(
    () => () => {
      sessionEpoch.current++;
      void captureRef.current?.stop();
      answerRef.current?.abort();
      demoTimers.current.forEach(clearTimeout);
      clearTimeout(autoTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!listening) return;
    const interval = setInterval(() => setElapsed((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [listening]);
  useEffect(() => {
    if (followTranscript.current) transcriptEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [entries]);

  useEffect(() => {
    setEntries(reconciler.current.view(settings.filterMicrophoneEcho).entries);
  }, [settings.filterMicrophoneEcho]);
  const addEntry = useCallback((entry: TranscriptEntry) => {
    reconciler.current.accept(entry);
    const result = reconciler.current.view(latest.current.settings.filterMicrophoneEcho);
    setEntries(result.entries);
    if (result.echoCount && !echoNotified.current) {
      echoNotified.current = true;
      setNotice(
        'Matching microphone echo was filtered. Headphones help prevent the call audio entering your microphone. You can disable the filter in Audio sources.',
      );
    }
  }, []);

  const requestAnswer = useCallback(async (mode: 'manual' | 'auto', typed = '') => {
    const state = latest.current;
    if (!state.bootstrap || (!state.entries.length && !typed.trim())) return;
    if (busyRef.current) {
      if (mode === 'auto' || activeMode.current === 'manual') return;
      answerRef.current?.abort();
    }
    const controller = new AbortController();
    answerRef.current = controller;
    activeMode.current = mode;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const id = crypto.randomUUID();
    const epoch = sessionEpoch.current;
    let text = '';
    let exists = false;
    try {
      for await (const event of streamAnswer(
        {
          settings: safeSettings(state.settings, DEFAULT_SETTINGS),
          transcript: state.entries.slice(-120),
          question: typed.trim(),
          mode,
          previousSuggestions: state.suggestions
            .filter((s) => s.status === 'done')
            .slice(-5)
            .map((s) => s.text),
          demo: state.demo,
        },
        state.bootstrap.token,
        controller.signal,
      )) {
        if (epoch !== sessionEpoch.current) break;
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'skip') break;
        if (event.type === 'delta') {
          text += event.text;
          const value = text;
          if (!exists) {
            exists = true;
            setSuggestions((current) => [
              ...current,
              {
                id,
                text: value,
                mode,
                question: typed,
                timestamp: Date.now(),
                status: 'streaming',
              },
            ]);
          } else
            setSuggestions((current) =>
              current.map((s) => (s.id === id ? { ...s, text: value } : s)),
            );
        }
      }
      setSuggestions((current) => current.map((s) => (s.id === id ? { ...s, status: 'done' } : s)));
    } catch (e) {
      if (!controller.signal.aborted && epoch === sessionEpoch.current) {
        setError(e instanceof Error ? e.message : 'The answer failed. Try again.');
        setSuggestions((current) =>
          current.map((s) => (s.id === id ? { ...s, status: 'error' } : s)),
        );
      } else
        setSuggestions((current) =>
          current
            .filter((s) => s.id !== id || s.text)
            .map((s) => (s.id === id ? { ...s, status: 'done' } : s)),
        );
    } finally {
      if (answerRef.current === controller) {
        busyRef.current = false;
        activeMode.current = null;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!auto || !listening || busy) return;
    const last = [...entries].reverse().find((entry) => entry.final && entry.source === 'system');
    const turnId = last?.turnId ?? last?.id;
    if (!last || turnId === autoSeen.current) return;
    const delay = Math.max(550, settings.autoCooldownMs - (Date.now() - lastAutoAt.current));
    autoTimer.current = setTimeout(() => {
      autoSeen.current = turnId!;
      lastAutoAt.current = Date.now();
      void requestAnswer('auto');
    }, delay);
    return () => clearTimeout(autoTimer.current);
  }, [auto, listening, busy, entries, settings.autoCooldownMs, requestAnswer]);

  useEffect(() => {
    if (!auto && activeMode.current === 'auto') answerRef.current?.abort();
  }, [auto]);
  useEffect(() => {
    const trigger = () => {
      void requestAnswer('manual');
    };
    const unregister = window.callsideDesktop?.onAnswer(trigger);
    const handler = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (
        event.key === 'F8' ||
        ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'Space')
      ) {
        event.preventDefault();
        const accelerator = event.key === 'F8' ? 'F8' : 'CommandOrControl+Shift+Space';
        if (!window.callsideDesktop || shortcuts.current[accelerator] === false) trigger();
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      unregister?.();
      window.removeEventListener('keydown', handler);
    };
  }, [requestAnswer]);

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setListening(false);
    demoTimers.current.forEach(clearTimeout);
    demoTimers.current = [];
    clearTimeout(autoTimer.current);
    if (activeMode.current === 'auto') answerRef.current?.abort();
    const capture = captureRef.current;
    captureRef.current = null;
    try {
      await capture?.stop();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recording could not finish cleanly.');
    } finally {
      setStopping(false);
      setLevels({ mic: 0, system: 0 });
      setSourceStatus({ mic: 'Ended', system: 'Ended' });
    }
  }

  function reset() {
    sessionEpoch.current++;
    answerRef.current?.abort();
    demoTimers.current.forEach(clearTimeout);
    demoTimers.current = [];
    setEntries([]);
    reconciler.current.clear();
    echoNotified.current = false;
    setSuggestions([]);
    setElapsed(0);
    setQuestion('');
    autoSeen.current = '';
    lastAutoAt.current = 0;
    followTranscript.current = true;
    setError('');
    setNotice('');
    setAttributionStatus('');
  }

  function startDemo() {
    reset();
    setDemo(true);
    setListening(true);
    setView('session');
    const started = Date.now();
    DEMO_TURNS.forEach((turn, i) => {
      demoTimers.current.push(
        setTimeout(() => {
          addEntry({
            id: `demo-${started}-${i}`,
            source: turn.source,
            speaker: turn.source === 'mic' ? settings.micLabel : settings.systemLabel,
            text: turn.text,
            timestamp: started + i * 650,
            final: true,
          });
        }, i * 650),
      );
    });
    setSourceStatus({ mic: 'Demo', system: 'Demo' });
  }

  async function start() {
    if (!bootstrap?.hasApiKey) {
      setView('settings');
      setNotice('Add an OpenAI API key first.');
      return;
    }
    if (!consent) {
      setError('Confirm that everyone knows about transcription before starting.');
      return;
    }
    if (!settings.captureMic && !settings.captureSystem) {
      setError('Select at least one audio source in Settings.');
      return;
    }
    reset();
    setDemo(false);
    setStarting(true);
    setSourceStatus({
      mic: settings.captureMic ? 'Connecting …' : 'Off',
      system: settings.captureSystem ? 'Connecting …' : 'Off',
    });
    try {
      const epoch = sessionEpoch.current;
      captureRef.current = await startCapture(
        safeSettings(settings, DEFAULT_SETTINGS),
        bootstrap.token,
        {
          onTranscript: (entry) => {
            if (epoch === sessionEpoch.current) addEntry(entry);
          },
          onAttribution: (result) => {
            if (epoch !== sessionEpoch.current) return;
            reconciler.current.attribute(result);
            setEntries(
              reconciler.current.view(latest.current.settings.filterMicrophoneEcho).entries,
            );
          },
          onAttributionStatus: (status) => {
            if (epoch === sessionEpoch.current) setAttributionStatus(status);
          },
          onLevel: (source, level) => {
            if (epoch === sessionEpoch.current)
              setLevels((current) => ({ ...current, [source]: level }));
          },
          onStatus: (source, status) => {
            if (epoch !== sessionEpoch.current) return;
            setSourceStatus((current) => ({ ...current, [source]: status }));
            if (status.startsWith('No audio signal yet'))
              setNotice(`${source === 'mic' ? 'Microphone' : 'Call audio'}: ${status}.`);
          },
          onError: (message) => {
            if (epoch === sessionEpoch.current) setError(message);
          },
          onEnded: () => {
            if (epoch !== sessionEpoch.current) return;
            captureRef.current = null;
            setListening(false);
            setStopping(false);
            setLevels({ mic: 0, system: 0 });
            clearTimeout(autoTimer.current);
            if (activeMode.current === 'auto') answerRef.current?.abort();
          },
        },
      );
      setListening(true);
      setView('session');
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Recording could not start. Check your audio permissions.',
      );
    } finally {
      setStarting(false);
    }
  }

  async function saveKey(remove = false) {
    if (!bootstrap || (!remove && !apiKey.trim())) return;
    setKeyBusy(true);
    setError('');
    try {
      const response = await fetch('/api/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Callside-Token': bootstrap.token },
        body: JSON.stringify({
          apiKey: remove ? '' : apiKey.trim(),
          remember: !remove && Boolean(bootstrap.keyStorage?.canRemember && rememberKey),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not apply the key.');
      setBootstrap({ ...bootstrap, hasApiKey: data.hasApiKey, keyStorage: data.keyStorage });
      setApiKey('');
      setNotice(
        remove
          ? 'Key removed from this session and secure storage.'
          : data.keyStorage?.saved
            ? 'API key saved securely. It will load automatically after restarting Callside.'
            : 'Key added for this session. It will be validated on the first API request.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not apply the key.');
    } finally {
      setKeyBusy(false);
    }
  }

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));
  async function discoverDevices() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter(
          (device) => device.kind === 'audioinput',
        ),
      );
    } catch {
      setError('Audio inputs are unavailable. Allow microphone access in system settings.');
    }
  }
  function download(format: 'json' | 'md') {
    const content =
      format === 'json'
        ? JSON.stringify(
            {
              version: 1,
              exportedAt: new Date().toISOString(),
              demo,
              transcript: entries,
              speakerAttribution: {
                enabled:
                  settings.captureMode === 'realtime' &&
                  settings.backgroundSpeakers &&
                  settings.captureSystem &&
                  !demo,
                batchSeconds: settings.diarizationChunkSeconds,
                status: attributionStatus,
              },
              suggestions,
            },
            null,
            2,
          )
        : sessionMarkdown(entries, suggestions, demo);
    const url = URL.createObjectURL(
      new Blob([content], {
        type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `callside-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copy(suggestion: Suggestion) {
    try {
      await navigator.clipboard.writeText(suggestion.text);
      setCopied(suggestion.id);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setError('Copying was blocked. Select the answer text and copy it with your keyboard.');
    }
  }
  const current = suggestions.at(-1);
  const live = listening || starting || stopping;
  const minutes = `${Math.floor(elapsed / 60)
    .toString()
    .padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;

  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView('session');
          }}
          aria-label="Callside conversation"
        >
          <Radio size={25} />
          <span>
            callside<span className="brand-period">.</span>
          </span>
        </a>
        <nav aria-label="Main navigation">
          <button
            className={view === 'session' ? 'nav-button active' : 'nav-button'}
            onClick={() => setView('session')}
          >
            Conversation
          </button>
          <button
            className={view === 'settings' ? 'nav-button active' : 'nav-button'}
            onClick={() => setView('settings')}
          >
            <Settings2 size={15} />
            Settings
          </button>
        </nav>
        <div className="header-right">
          {window.callsideDesktop && (
            <button
              className={`icon-button ${pin ? 'selected' : ''}`}
              aria-label="Keep window on top"
              aria-pressed={pin}
              onClick={async () => {
                try {
                  await window.callsideDesktop!.setAlwaysOnTop(!pin);
                  setPin(!pin);
                } catch {
                  setError('Could not pin the window.');
                }
              }}
            >
              <Pin size={17} />
            </button>
          )}
          <span className="local-badge">
            <span className="small-dot" /> Local on your device
          </span>
        </div>
      </header>

      {error && (
        <div className="message error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={17} />
          </button>
        </div>
      )}
      {notice && (
        <div className="message notice" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss notice" onClick={() => setNotice('')}>
            <X size={17} />
          </button>
        </div>
      )}

      {view === 'session' ? (
        <main className="session-view">
          <section className="session-top" aria-label="Recording controls">
            <div className="session-heading">
              <h1>Room for your conversation.</h1>
              <p>Listen. Stay present. Find your next words here.</p>
            </div>
            <div className="session-actions">
              {!live && entries.length > 0 && (
                <button
                  className="quiet-button"
                  onClick={() => {
                    reset();
                    setDemo(false);
                  }}
                >
                  New session
                </button>
              )}
              {listening ? (
                <button className="stop-button" onClick={() => void stop()}>
                  <Square size={14} fill="currentColor" />
                  {demo ? 'End demo' : 'End call'}
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={starting || stopping || !bootstrap}
                  onClick={() => void start()}
                >
                  <Mic size={17} />
                  {starting ? 'Connecting …' : stopping ? 'Finishing …' : 'Start call'}
                </button>
              )}
            </div>
          </section>
          <div className="session-meta">
            <div className="capture-state">
              <span className={`status-dot ${listening ? 'live' : ''}`} />
              {demo
                ? 'Demo · synthetic conversation'
                : listening
                  ? 'Transcribing'
                  : 'Ready when you are'}
              <span className="timer">{minutes}</span>
            </div>
            {!live && (
              <label className="consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Everyone knows about transcription.
              </label>
            )}
            {live && (
              <span className="mode-label">
                {demo
                  ? 'No API costs'
                  : settings.captureMode === 'realtime'
                    ? settings.backgroundSpeakers && settings.captureSystem
                      ? 'Live · speaker labels in background'
                      : 'Live · separate audio channels'
                    : `Speaker identification · ${settings.diarizationChunkSeconds}-second chunks`}
              </span>
            )}
          </div>

          <div className="workspace">
            <section className="transcript-pane" aria-labelledby="transcript-title">
              <div className="pane-header">
                <h2 id="transcript-title">Live transcript</h2>
                <span className="count-label">{entries.filter((e) => e.final).length} turns</span>
              </div>
              <div className="source-strip">
                {(['mic', 'system'] as Source[]).map((source) => (
                  <div className="source-item" key={source}>
                    {source === 'mic' ? <Mic size={14} /> : <Volume2 size={14} />}
                    <span>{source === 'mic' ? settings.micLabel : settings.systemLabel}</span>
                    <div
                      className="level-meter"
                      role="meter"
                      aria-label={`${source === 'mic' ? 'Microphone' : 'Call'} level`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(levels[source] * 100)}
                    >
                      <span style={{ transform: `scaleX(${Math.min(1, levels[source])})` }} />
                    </div>
                    <span className="source-status">{sourceStatus[source]}</span>
                  </div>
                ))}
              </div>
              {attributionStatus && (
                <div
                  className="attribution-status"
                  role="status"
                  data-testid="speaker-attribution-status"
                >
                  {attributionStatus}
                </div>
              )}
              <div
                className="transcript-content"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  followTranscript.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
                }}
              >
                {!entries.length ? (
                  <div className="empty-transcript">
                    <div className="empty-wave">
                      <Activity size={42} strokeWidth={1.2} />
                    </div>
                    <h3>Your conversation appears here.</h3>
                    <p>
                      Your microphone and call audio are transcribed live. Follow what is being said
                      as you listen.
                    </p>
                    <button
                      className="text-button"
                      disabled={live || !bootstrap}
                      onClick={startDemo}
                    >
                      Try demo
                      <ArrowRight size={16} />
                    </button>
                    <span className="small-print">
                      A sample conversation. No key or microphone needed.
                    </span>
                  </div>
                ) : (
                  entries.map((entry) => (
                    <article
                      className={`transcript-entry ${entry.source} ${entry.final ? '' : 'partial'}`}
                      key={entry.id}
                      data-testid="transcript-entry"
                    >
                      <div className="entry-meta">
                        <strong>{entry.speaker}</strong>
                        <time dateTime={new Date(entry.timestamp).toISOString()}>
                          {time(entry.timestamp)}
                        </time>
                        {!entry.final && <span className="partial-label">live</span>}
                      </div>
                      <p>{entry.text || '…'}</p>
                    </article>
                  ))
                )}
                <div ref={transcriptEnd} />
              </div>
              <div className="transcript-footer">
                <Headphones size={14} />
                <span>Use headphones to avoid duplicate transcription.</span>
                <details className="export-menu">
                  <summary aria-label="Export session">
                    <Download size={16} />
                    <ChevronDown size={13} />
                  </summary>
                  <div>
                    <button disabled={!entries.length} onClick={() => download('md')}>
                      Transcript as Markdown
                    </button>
                    <button disabled={!entries.length} onClick={() => download('json')}>
                      Session as JSON
                    </button>
                  </div>
                </details>
              </div>
            </section>

            <section className="assistant-pane" aria-labelledby="assistant-title">
              <div className="pane-header">
                <h2 id="assistant-title">Your next thought</h2>
                <span className="model-label">{settings.model}</span>
              </div>
              <label className="auto-control">
                <span>
                  <Zap size={16} />
                  <span>
                    Automatic hints<small>The model decides when to help.</small>
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Automatic hints"
                  checked={auto}
                  onChange={(e) => setAuto(e.target.checked)}
                />
                <span className="switch-track" />
              </label>
              <div className="suggestion-area" aria-live="polite" aria-busy={busy}>
                {current ? (
                  <article className={`suggestion ${current.status}`} data-testid="suggestion">
                    <div className="suggestion-meta">
                      <span>
                        {current.mode === 'auto'
                          ? 'Automatic hint'
                          : current.question
                            ? 'Your question'
                            : 'Answer suggestion'}
                      </span>
                      <time>{time(current.timestamp)}</time>
                    </div>
                    {current.question && <p className="asked-question">{current.question}</p>}
                    <p className="answer-text">
                      {current.text}
                      <span
                        className={current.status === 'streaming' ? 'stream-cursor' : 'hidden'}
                      />
                    </p>
                    <div className="suggestion-bottom">
                      <span>
                        {current.status === 'streaming'
                          ? 'Drafting …'
                          : current.status === 'error'
                            ? 'Incomplete answer'
                            : 'A suggestion to put in your own words.'}
                      </span>
                      <button
                        className="icon-button"
                        aria-label="Copy answer"
                        onClick={() => void copy(current)}
                      >
                        {copied === current.id ? <Check size={17} /> : <Copy size={17} />}
                      </button>
                    </div>
                  </article>
                ) : (
                  <div className="empty-answer">
                    <span className="answer-mark">“</span>
                    <h3>
                      The right words.
                      <br />
                      When you need them.
                    </h3>
                    <p>Press a key to get a short answer suggestion based on the conversation.</p>
                    <div className="shortcut-demo">
                      <kbd>F8</kbd>
                      <span>or use the button below</span>
                    </div>
                  </div>
                )}
                {busy && !current?.text && (
                  <p className="thinking">
                    <span className="status-dot live" />
                    {activeMode.current === 'auto'
                      ? 'Checking whether a hint would help …'
                      : 'Drafting an answer …'}
                  </p>
                )}
              </div>
              {suggestions.length > 1 && (
                <details className="history">
                  <summary>{suggestions.length - 1} previous suggestions</summary>
                  <div>
                    {suggestions
                      .slice(0, -1)
                      .reverse()
                      .map((s) => (
                        <article key={s.id}>
                          <time>{time(s.timestamp)}</time>
                          <p>{s.text}</p>
                        </article>
                      ))}
                  </div>
                </details>
              )}
              <div className="answer-controls">
                <button
                  className="answer-button"
                  disabled={!bootstrap || busy || !entries.some((e) => e.text.trim())}
                  onClick={() => void requestAnswer('manual')}
                >
                  <Zap size={18} />
                  {busy ? 'Thinking …' : 'Suggest answer'}
                  <kbd>F8</kbd>
                </button>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (question.trim()) {
                      void requestAnswer('manual', question);
                      setQuestion('');
                    }
                  }}
                >
                  <input
                    aria-label="Your question"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Or ask your own question …"
                    maxLength={4000}
                  />
                  <button
                    type="submit"
                    aria-label="Send question"
                    disabled={!question.trim() || busy || !bootstrap}
                  >
                    <ArrowRight size={18} />
                  </button>
                </form>
                <span className="shortcut-hint">
                  <Keyboard size={13} />
                  {window.callsideDesktop
                    ? 'Global: F8 or ⌘ / Ctrl + Shift + Space'
                    : 'F8 in the browser · global shortcut in the desktop app'}
                </span>
              </div>
            </section>
          </div>
          <footer className="page-footer">
            <span>
              {demo ? 'Demo data · no audio recorded' : 'Audio sent to OpenAI · no local recording'}
              <span className="footer-divider">/</span>Transcript kept in this session only
            </span>
            <span>Open source. Your workflow.</span>
          </footer>
        </main>
      ) : (
        <main className="settings-view">
          {live && (
            <section className="settings-session-state" aria-label="Active session">
              <div className="capture-state">
                <span className={`status-dot ${listening ? 'live' : ''}`} />
                <span>
                  {starting
                    ? 'Connecting audio …'
                    : stopping
                      ? 'Finalizing transcript …'
                      : demo
                        ? 'Demo running · synthetic conversation'
                        : 'Transcription continues'}
                </span>
                <span className="timer">{minutes}</span>
              </div>
              <button className="stop-button" disabled={!listening} onClick={() => void stop()}>
                <Square size={14} fill="currentColor" />
                {demo ? 'End demo' : 'End call'}
              </button>
            </section>
          )}
          <div className="settings-heading">
            <div>
              <h1>Set up for your conversation.</h1>
              <p>Audio, models, and instructions in one place.</p>
            </div>
            <button className="quiet-button" onClick={() => setView('session')}>
              Back to conversation
              <ArrowRight size={16} />
            </button>
          </div>
          <div className="settings-grid">
            <section className="settings-section">
              <h2>Connect OpenAI</h2>
              <p>
                API usage is billed separately. A ChatGPT subscription does not include general
                audio API access.
              </p>
              <div className="key-state">
                <span className={`status-dot ${bootstrap?.hasApiKey ? 'live' : ''}`} />
                {bootstrap?.hasApiKey
                  ? bootstrap.keyStorage?.saved
                    ? 'API key saved on this device'
                    : 'API key added'
                  : 'No API key added'}
              </div>
              <label>
                OpenAI API key
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="sk-…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
              {bootstrap?.keyStorage?.canRemember && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={rememberKey}
                    disabled={keyBusy || live}
                    onChange={(event) => setRememberKey(event.target.checked)}
                  />
                  Remember API key on this device
                </label>
              )}
              {bootstrap?.keyStorage?.error && (
                <p role="alert" className="field-help">
                  {bootstrap.keyStorage.error}
                </p>
              )}
              <button
                className="secondary-button"
                disabled={!apiKey.trim() || keyBusy || !bootstrap || live}
                onClick={() => void saveKey()}
              >
                {keyBusy
                  ? 'Applying …'
                  : bootstrap?.keyStorage?.canRemember && rememberKey
                    ? 'Save API key'
                    : 'Use key for this session'}
              </button>
              {(bootstrap?.hasApiKey || bootstrap?.keyStorage?.saved) && (
                <button
                  className="text-button"
                  disabled={keyBusy || live}
                  onClick={() => void saveKey(true)}
                >
                  Remove API key
                </button>
              )}
              <p className="field-help">
                {bootstrap?.keyStorage?.canRemember
                  ? 'Remembered keys are encrypted using the operating system key store. Session-only mode removes any previously saved key. The key is never stored in templates or exports.'
                  : 'The key stays in local server memory. For persistence, set OPENAI_API_KEY in your local .env file or use the desktop app.'}
              </p>
            </section>
            <section className="settings-section">
              <h2>Model & language</h2>
              <label>
                Answer model
                <select
                  value={settings.model}
                  onChange={(e) =>
                    setSettings((current) =>
                      safeSettings({ ...current, model: e.target.value }, DEFAULT_SETTINGS),
                    )
                  }
                >
                  {ANSWER_MODELS.map((model) => (
                    <option key={model} value={model}>
                      {model
                        .replace('gpt-6-', 'GPT-6 ')
                        .replace(
                          /\b(luna|sol|astra)\b/g,
                          (name) => name[0].toUpperCase() + name.slice(1),
                        )}
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-help">Availability depends on your OpenAI project and account.</p>
              <label>
                Reasoning strength
                <select
                  value={settings.reasoningEffort}
                  onChange={(e) =>
                    update('reasoningEffort', e.target.value as Settings['reasoningEffort'])
                  }
                >
                  {reasoningOptions(settings.model).map((effort) => (
                    <option key={effort} value={effort}>
                      {
                        {
                          none: 'None',
                          low: 'Low',
                          medium: 'Medium',
                          high: 'High',
                          xhigh: 'Extra high',
                          max: 'Maximum',
                        }[effort]
                      }
                    </option>
                  ))}
                </select>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.fastMode}
                  onChange={(e) => update('fastMode', e.target.checked)}
                />
                Fast mode
              </label>
              <p className="field-help">
                Fast requests priority processing at 2× standard token rates, where available.
                Higher reasoning can increase response time and token use. The token budget includes
                reasoning and the visible answer.
              </p>
              <div className="field-row">
                <label>
                  Language
                  <select
                    value={settings.language}
                    disabled={live}
                    onChange={(e) => update('language', e.target.value)}
                  >
                    <option value="de">German</option>
                    <option value="en">English</option>
                    <option value="">Automatic</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                  </select>
                </label>
                <label>
                  Reasoning and answer token budget
                  <input
                    type="number"
                    min={64}
                    max={32768}
                    value={settings.maxOutputTokens}
                    onChange={(e) => update('maxOutputTokens', Number(e.target.value))}
                  />
                </label>
              </div>
            </section>
            <section className="settings-section audio-settings">
              <h2>Audio sources</h2>
              {live && (
                <p className="audio-lock-note">
                  Audio settings are locked during a session. End the session to change sources or
                  transcription mode.
                </p>
              )}
              <p>
                For a call, use your microphone and the call audio. Select sharing options when you
                start.
              </p>
              <fieldset disabled={live}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.captureMic}
                    onChange={(e) => update('captureMic', e.target.checked)}
                  />
                  Transcribe microphone
                </label>
                <div className="field-row">
                  <label>
                    Your track label
                    <input
                      value={settings.micLabel}
                      maxLength={60}
                      onChange={(e) => update('micLabel', e.target.value)}
                    />
                  </label>
                  <label>
                    Microphone
                    <select
                      value={settings.micDeviceId}
                      onChange={(e) => update('micDeviceId', e.target.value)}
                    >
                      <option value="">Default microphone</option>
                      {devices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.captureSystem}
                    onChange={(e) => update('captureSystem', e.target.checked)}
                  />
                  Transcribe call audio
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.filterMicrophoneEcho}
                    onChange={(event) => update('filterMicrophoneEcho', event.target.checked)}
                  />
                  Filter microphone echo duplicates
                </label>
                <p className="field-help">
                  Keeps the call track when near-identical speech starts on both channels within 750
                  ms. Short answers and later repetitions are kept. This is an echo filter, not
                  speaker identification. Headphones are recommended.
                </p>
                <div className="field-row">
                  <label>
                    Call track label
                    <input
                      value={settings.systemLabel}
                      maxLength={60}
                      onChange={(e) => update('systemLabel', e.target.value)}
                    />
                  </label>
                  <label>
                    Call audio source
                    <select
                      value={settings.systemDeviceId}
                      onChange={(e) => update('systemDeviceId', e.target.value)}
                    >
                      <option value="">System / shared tab</option>
                      {devices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button className="text-button" onClick={() => void discoverDevices()}>
                  Load audio inputs
                  <Mic size={15} />
                </button>
                <p className="field-help">
                  {window.callsideDesktop?.platform === 'darwin' && (
                    <>
                      System capture records this Mac's playback audio. macOS may request Screen
                      &amp; System Audio Recording access. Screen video stays on your device.{' '}
                    </>
                  )}
                  A virtual audio input can replace system audio when your operating system cannot
                  share it directly. Headphones are recommended.
                </p>
                <label>
                  Transcription mode
                  <select
                    value={settings.captureMode}
                    onChange={(e) =>
                      update('captureMode', e.target.value as Settings['captureMode'])
                    }
                  >
                    <option value="realtime">Fast: separate live channels</option>
                    <option value="diarized">Speaker identification in audio chunks</option>
                  </select>
                </label>
                {settings.captureMode === 'realtime' ? (
                  <>
                    <label>
                      Transcription model
                      <select
                        value={settings.transcriptionModel}
                        onChange={(e) => update('transcriptionModel', e.target.value)}
                      >
                        <option value="gpt-live-transcribe">gpt-live-transcribe</option>
                        <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option>
                        <option value="gpt-4o-transcribe">gpt-4o-transcribe</option>
                      </select>
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.backgroundSpeakers}
                        onChange={(e) => update('backgroundSpeakers', e.target.checked)}
                      />
                      Identify call speakers in the background
                    </label>
                    <p className="field-help">
                      Live text and suggestions appear immediately. OpenAI adds speaker labels to
                      call audio afterward. Your microphone keeps its own label. Headphones prevent
                      playback from entering your microphone.
                    </p>
                    {settings.backgroundSpeakers && (
                      <>
                        <label>
                          Speaker analysis batch length in seconds
                          <input
                            type="number"
                            min={4}
                            max={30}
                            value={settings.diarizationChunkSeconds}
                            onChange={(e) =>
                              update('diarizationChunkSeconds', Number(e.target.value))
                            }
                          />
                        </label>
                        <p className="field-help">
                          Uses gpt-4o-transcribe-diarize as an additional paid pass over call audio.
                          Labels arrive after each batch is processed. Up to four voices are linked
                          between batches using temporary reference clips. Other voices stay labeled
                          per batch. Clips are cleared when the call ends and are not exported.
                        </p>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <label>
                      Chunk length in seconds
                      <input
                        type="number"
                        min={4}
                        max={30}
                        value={settings.diarizationChunkSeconds}
                        onChange={(e) => update('diarizationChunkSeconds', Number(e.target.value))}
                      />
                    </label>
                    <p className="field-help">
                      gpt-4o-transcribe-diarize identifies speakers within each chunk. Speaker IDs
                      are not stable across chunks. Results arrive with additional delay.
                    </p>
                  </>
                )}
              </fieldset>
            </section>
            <section className="settings-section prompt-settings">
              <h2>How your assistant should help</h2>
              <div className="preset-buttons">
                {Object.entries(presets).map(([id, preset]) => (
                  <button
                    key={id}
                    className={settings.systemPrompt === preset.prompt ? 'preset active' : 'preset'}
                    onClick={() => update('systemPrompt', preset.prompt)}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
              <label>
                System prompt
                <textarea
                  rows={5}
                  value={settings.systemPrompt}
                  maxLength={12000}
                  onChange={(e) => update('systemPrompt', e.target.value)}
                />
              </label>
              <label>
                Conversation context
                <textarea
                  rows={4}
                  value={settings.context}
                  maxLength={16000}
                  placeholder="What is the call about? Add the offer, goals, background, and facts the model should know."
                  onChange={(e) => update('context', e.target.value)}
                />
              </label>
              <label>
                Automatic mode prompt
                <textarea
                  rows={4}
                  value={settings.autoPrompt}
                  maxLength={12000}
                  onChange={(e) => update('autoPrompt', e.target.value)}
                />
              </label>
              <label>
                Minimum interval between automatic checks (seconds)
                <input
                  type="number"
                  min={3}
                  max={60}
                  value={settings.autoCooldownMs / 1000}
                  onChange={(e) => update('autoCooldownMs', Number(e.target.value) * 1000)}
                />
              </label>
              <p className="field-help">
                After new call audio turns, the model uses this prompt to decide whether a
                suggestion would help. Checks that produce no hint also consume API tokens.
              </p>
            </section>
          </div>
          <div className="settings-bottom">
            <p>
              Changes apply immediately. Saving a template stores prompts and context on this
              device, without keys or transcripts.
            </p>
            <button
              className="secondary-button"
              onClick={() => {
                try {
                  localStorage.setItem(
                    settingsKey,
                    JSON.stringify(safeSettings(settings, DEFAULT_SETTINGS)),
                  );
                  setNotice('Template saved on this device.');
                } catch {
                  setError('Could not save the template.');
                }
              }}
            >
              Save template
            </button>
            <button
              className="quiet-button"
              disabled={live}
              onClick={() => {
                localStorage.removeItem(settingsKey);
                setSettings({ ...DEFAULT_SETTINGS });
                setNotice('Settings reset and saved template removed.');
              }}
            >
              Reset
            </button>
          </div>
        </main>
      )}
    </div>
  );
}
