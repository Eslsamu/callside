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
  universal: { name: 'Universell', prompt: DEFAULT_SETTINGS.systemPrompt },
  sales: {
    name: 'Sales',
    prompt:
      'Du begleitest mich in einem Verkaufsgespräch. Schlage eine kurze, hilfreiche Antwort auf die letzte Frage oder den letzten Einwand vor. Stelle bei unklaren Bedürfnissen eine offene Rückfrage. Erfinde keine Preise, Garantien, Referenzen oder Produktfähigkeiten. Nutze die Sprache des Gesprächs. Höchstens drei kurze Sätze.',
  },
  interview: {
    name: 'Interview',
    prompt:
      'Du begleitest mich in einem Interview. Hilf mir, meine im Gesprächskontext angegebenen Erfahrungen klar zu formulieren. Erfinde keine Qualifikationen oder Erlebnisse. Fehlen konkrete Fakten, schlage eine Rückfrage oder eine Struktur vor. Nutze die Sprache des Gesprächs. Höchstens drei kurze Sätze.',
  },
};
const time = (value: number) =>
  new Date(value).toLocaleTimeString('de-DE', {
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
  const [pin, setPin] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [levels, setLevels] = useState<Record<Source, number>>({ mic: 0, system: 0 });
  const [sourceStatus, setSourceStatus] = useState<Record<Source, string>>({
    mic: 'Bereit',
    system: 'Bereit',
  });
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

  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/bootstrap', { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('Der lokale Server ist nicht erreichbar. Starte die App neu.');
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
            'Eine globale Taste ist bereits belegt. Nutze die andere Tastenkombination oder den Antwort-Button.',
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

  const addEntry = useCallback((entry: TranscriptEntry) => {
    setEntries((current) => {
      const index = current.findIndex((item) => item.id === entry.id);
      if (index === -1) return [...current, entry].sort((a, b) => a.timestamp - b.timestamp);
      const next = [...current];
      if (next[index].final && !entry.final) return current;
      next[index] = entry;
      return next.sort((a, b) => a.timestamp - b.timestamp);
    });
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
        setError(e instanceof Error ? e.message : 'Antwort fehlgeschlagen. Versuche es erneut.');
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
    if (!last || last.id === autoSeen.current) return;
    const delay = Math.max(550, settings.autoCooldownMs - (Date.now() - lastAutoAt.current));
    autoTimer.current = setTimeout(() => {
      autoSeen.current = last.id;
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
      setError(e instanceof Error ? e.message : 'Aufnahme konnte nicht sauber beendet werden.');
    } finally {
      setStopping(false);
      setLevels({ mic: 0, system: 0 });
      setSourceStatus({ mic: 'Beendet', system: 'Beendet' });
    }
  }

  function reset() {
    sessionEpoch.current++;
    answerRef.current?.abort();
    demoTimers.current.forEach(clearTimeout);
    demoTimers.current = [];
    setEntries([]);
    setSuggestions([]);
    setElapsed(0);
    setQuestion('');
    autoSeen.current = '';
    lastAutoAt.current = 0;
    followTranscript.current = true;
    setError('');
    setNotice('');
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
      setNotice('Hinterlege zuerst einen OpenAI API-Key.');
      return;
    }
    if (!consent) {
      setError('Bestätige vor dem Start, dass alle Beteiligten von der Transkription wissen.');
      return;
    }
    if (!settings.captureMic && !settings.captureSystem) {
      setError('Wähle mindestens eine Audioquelle in den Einstellungen.');
      return;
    }
    reset();
    setDemo(false);
    setStarting(true);
    setSourceStatus({
      mic: settings.captureMic ? 'Verbindet …' : 'Aus',
      system: settings.captureSystem ? 'Verbindet …' : 'Aus',
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
          onLevel: (source, level) => {
            if (epoch === sessionEpoch.current)
              setLevels((current) => ({ ...current, [source]: level }));
          },
          onStatus: (source, status) => {
            if (epoch !== sessionEpoch.current) return;
            setSourceStatus((current) => ({ ...current, [source]: status }));
            if (status.startsWith('Noch kein Audiosignal'))
              setNotice(`${source === 'mic' ? 'Mikrofon' : 'Call-Audio'}: ${status}.`);
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
        e instanceof Error
          ? e.message
          : 'Die Aufnahme konnte nicht starten. Prüfe deine Audiofreigaben.',
      );
    } finally {
      setStarting(false);
    }
  }

  async function saveKey() {
    if (!bootstrap || !apiKey.trim()) return;
    setKeyBusy(true);
    setError('');
    try {
      const response = await fetch('/api/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Callside-Token': bootstrap.token },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Der Key konnte nicht übernommen werden.');
      setBootstrap({ ...bootstrap, hasApiKey: data.hasApiKey });
      setApiKey('');
      setNotice('Key für diese Sitzung hinterlegt. Er wird beim ersten API-Aufruf geprüft.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Key konnte nicht übernommen werden.');
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
      setError(
        'Audioeingänge nicht verfügbar. Erlaube den Mikrofonzugriff in den Systemeinstellungen.',
      );
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
      setError(
        'Kopieren wurde blockiert. Markiere den Antworttext und kopiere ihn mit der Tastatur.',
      );
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
          aria-label="Callside Gespräch"
        >
          <Radio size={25} />
          <span>
            callside<span className="brand-period">.</span>
          </span>
        </a>
        <nav aria-label="Hauptnavigation">
          <button
            className={view === 'session' ? 'nav-button active' : 'nav-button'}
            onClick={() => setView('session')}
          >
            Gespräch
          </button>
          <button
            className={view === 'settings' ? 'nav-button active' : 'nav-button'}
            onClick={() => setView('settings')}
          >
            <Settings2 size={15} />
            Einstellungen
          </button>
        </nav>
        <div className="header-right">
          {window.callsideDesktop && (
            <button
              className={`icon-button ${pin ? 'selected' : ''}`}
              aria-label="Fenster im Vordergrund halten"
              aria-pressed={pin}
              onClick={async () => {
                try {
                  await window.callsideDesktop!.setAlwaysOnTop(!pin);
                  setPin(!pin);
                } catch {
                  setError('Das Fenster konnte nicht angeheftet werden.');
                }
              }}
            >
              <Pin size={17} />
            </button>
          )}
          <span className="local-badge">
            <span className="small-dot" /> Lokal auf deinem Gerät
          </span>
        </div>
      </header>

      {error && (
        <div className="message error" role="alert">
          <span>{error}</span>
          <button aria-label="Fehlermeldung schließen" onClick={() => setError('')}>
            <X size={17} />
          </button>
        </div>
      )}
      {notice && (
        <div className="message notice" role="status">
          <span>{notice}</span>
          <button aria-label="Hinweis schließen" onClick={() => setNotice('')}>
            <X size={17} />
          </button>
        </div>
      )}

      {view === 'session' ? (
        <main className="session-view">
          <section className="session-top" aria-label="Aufnahmesteuerung">
            <div className="session-heading">
              <h1>Raum für dein Gespräch.</h1>
              <p>Hör zu. Bleib im Moment. Die nächste Antwort ist schon da.</p>
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
                  Neue Sitzung
                </button>
              )}
              {listening ? (
                <button className="stop-button" onClick={() => void stop()}>
                  <Square size={14} fill="currentColor" />
                  {demo ? 'Demo beenden' : 'Call beenden'}
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={starting || stopping || !bootstrap}
                  onClick={() => void start()}
                >
                  <Mic size={17} />
                  {starting ? 'Verbindet …' : stopping ? 'Schließt ab …' : 'Call starten'}
                </button>
              )}
            </div>
          </section>
          <div className="session-meta">
            <div className="capture-state">
              <span className={`status-dot ${listening ? 'live' : ''}`} />
              {demo
                ? 'Demo · synthetisches Gespräch'
                : listening
                  ? 'Transkription läuft'
                  : 'Bereit, wenn du es bist'}
              <span className="timer">{minutes}</span>
            </div>
            {!live && (
              <label className="consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Alle Beteiligten wissen von der Transkription.
              </label>
            )}
            {live && (
              <span className="mode-label">
                {demo
                  ? 'Ohne API-Kosten'
                  : settings.captureMode === 'realtime'
                    ? 'Live · getrennte Audiokanäle'
                    : `Sprechererkennung · ${settings.diarizationChunkSeconds}-Sekunden-Blöcke`}
              </span>
            )}
          </div>

          <div className="workspace">
            <section className="transcript-pane" aria-labelledby="transcript-title">
              <div className="pane-header">
                <h2 id="transcript-title">Live-Transkript</h2>
                <span className="count-label">
                  {entries.filter((e) => e.final).length} Beiträge
                </span>
              </div>
              <div className="source-strip">
                {(['mic', 'system'] as Source[]).map((source) => (
                  <div className="source-item" key={source}>
                    {source === 'mic' ? <Mic size={14} /> : <Volume2 size={14} />}
                    <span>{source === 'mic' ? settings.micLabel : settings.systemLabel}</span>
                    <div
                      className="level-meter"
                      role="meter"
                      aria-label={`${source === 'mic' ? 'Mikrofon' : 'Call'}-Pegel`}
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
                    <h3>Hier wird dein Gespräch sichtbar.</h3>
                    <p>
                      Mikrofon und Call-Audio werden live transkribiert. Du siehst, was gesagt wird,
                      während du zuhörst.
                    </p>
                    <button
                      className="text-button"
                      disabled={live || !bootstrap}
                      onClick={startDemo}
                    >
                      Demo ausprobieren
                      <ArrowRight size={16} />
                    </button>
                    <span className="small-print">Kein Key, kein Mikrofon. Nur ein Beispiel.</span>
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
                <span>Kopfhörer vermeiden doppelte Transkription.</span>
                <details className="export-menu">
                  <summary aria-label="Sitzung exportieren">
                    <Download size={16} />
                    <ChevronDown size={13} />
                  </summary>
                  <div>
                    <button disabled={!entries.length} onClick={() => download('md')}>
                      Transkript als Markdown
                    </button>
                    <button disabled={!entries.length} onClick={() => download('json')}>
                      Sitzung als JSON
                    </button>
                  </div>
                </details>
              </div>
            </section>

            <section className="assistant-pane" aria-labelledby="assistant-title">
              <div className="pane-header">
                <h2 id="assistant-title">Dein nächster Gedanke</h2>
                <span className="model-label">{settings.model}</span>
              </div>
              <label className="auto-control">
                <span>
                  <Zap size={16} />
                  <span>
                    Automatische Hinweise<small>Das Modell entscheidet, wann es hilft.</small>
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Automatische Hinweise"
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
                          ? 'Automatischer Hinweis'
                          : current.question
                            ? 'Deine Frage'
                            : 'Antwortvorschlag'}
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
                          ? 'Wird formuliert …'
                          : current.status === 'error'
                            ? 'Unvollständige Antwort'
                            : 'Als Formulierungshilfe gedacht.'}
                      </span>
                      <button
                        className="icon-button"
                        aria-label="Antwort kopieren"
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
                      Die richtigen Worte.
                      <br />
                      Wenn du sie brauchst.
                    </h3>
                    <p>
                      Ein Tastendruck genügt. Dein Assistent greift das Gespräch auf und schlägt dir
                      eine kurze Antwort vor.
                    </p>
                    <div className="shortcut-demo">
                      <kbd>F8</kbd>
                      <span>oder den Button unten nutzen</span>
                    </div>
                  </div>
                )}
                {busy && !current?.text && (
                  <p className="thinking">
                    <span className="status-dot live" />
                    {activeMode.current === 'auto'
                      ? 'Prüft, ob ein Hinweis hilft …'
                      : 'Formuliert eine Antwort …'}
                  </p>
                )}
              </div>
              {suggestions.length > 1 && (
                <details className="history">
                  <summary>{suggestions.length - 1} frühere Vorschläge</summary>
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
                  {busy ? 'Denkt mit …' : 'Antwort vorschlagen'}
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
                    aria-label="Eigene Frage"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Oder eine eigene Frage stellen …"
                    maxLength={4000}
                  />
                  <button
                    type="submit"
                    aria-label="Frage senden"
                    disabled={!question.trim() || busy || !bootstrap}
                  >
                    <ArrowRight size={18} />
                  </button>
                </form>
                <span className="shortcut-hint">
                  <Keyboard size={13} />
                  {window.callsideDesktop
                    ? 'Global: F8 oder ⌘ / Strg + Umschalt + Leertaste'
                    : 'F8 im Browser · globale Taste in der Desktop-App'}
                </span>
              </div>
            </section>
          </div>
          <footer className="page-footer">
            <span>
              {demo
                ? 'Demo-Daten · keine Audioaufnahme'
                : 'Audio an OpenAI · keine lokale Aufzeichnung'}
              <span className="footer-divider">/</span>Transkript nur in dieser Sitzung
            </span>
            <span>Open source. Dein Workflow.</span>
          </footer>
        </main>
      ) : (
        <main className="settings-view">
          {live && (
            <section className="settings-session-state" aria-label="Aktive Sitzung">
              <div className="capture-state">
                <span className={`status-dot ${listening ? 'live' : ''}`} />
                <span>
                  {starting
                    ? 'Audio wird verbunden …'
                    : stopping
                      ? 'Transkript wird abgeschlossen …'
                      : demo
                        ? 'Demo läuft · synthetisches Gespräch'
                        : 'Transkription läuft weiter'}
                </span>
                <span className="timer">{minutes}</span>
              </div>
              <button className="stop-button" disabled={!listening} onClick={() => void stop()}>
                <Square size={14} fill="currentColor" />
                {demo ? 'Demo beenden' : 'Call beenden'}
              </button>
            </section>
          )}
          <div className="settings-heading">
            <div>
              <h1>Für dein Gespräch eingerichtet.</h1>
              <p>Audio, Modell und Anweisungen an einem Ort.</p>
            </div>
            <button className="quiet-button" onClick={() => setView('session')}>
              Zurück zum Gespräch
              <ArrowRight size={16} />
            </button>
          </div>
          <div className="settings-grid">
            <section className="settings-section">
              <h2>OpenAI verbinden</h2>
              <p>
                API-Nutzung wird separat abgerechnet. Ein ChatGPT-Abo stellt keinen allgemeinen
                Audio-API-Zugang bereit.
              </p>
              <div className="key-state">
                <span className={`status-dot ${bootstrap?.hasApiKey ? 'live' : ''}`} />
                {bootstrap?.hasApiKey ? 'API-Key hinterlegt' : 'Noch kein API-Key hinterlegt'}
              </div>
              <label>
                OpenAI API-Key
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="sk-…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
              <button
                className="secondary-button"
                disabled={!apiKey.trim() || keyBusy || !bootstrap || live}
                onClick={() => void saveKey()}
              >
                {keyBusy ? 'Übernimmt …' : 'Key für diese Sitzung verwenden'}
              </button>
              <p className="field-help">
                Der Key bleibt im Arbeitsspeicher des lokalen Servers. Alternativ: OPENAI_API_KEY in
                der lokalen .env-Datei.
              </p>
            </section>
            <section className="settings-section">
              <h2>Modell & Sprache</h2>
              <label>
                Antwortmodell
                <input
                  list="models"
                  value={settings.model}
                  onChange={(e) => update('model', e.target.value)}
                  maxLength={100}
                />
                <datalist id="models">
                  {(bootstrap?.models || ['gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini']).map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </label>
              <p className="field-help">
                Eine Responses-API-Modell-ID aus deinem OpenAI-Projekt. Verfügbarkeit hängt von
                deinem Account ab.
              </p>
              <div className="field-row">
                <label>
                  Sprache
                  <select
                    value={settings.language}
                    disabled={live}
                    onChange={(e) => update('language', e.target.value)}
                  >
                    <option value="de">Deutsch</option>
                    <option value="en">Englisch</option>
                    <option value="">Automatisch</option>
                    <option value="es">Spanisch</option>
                    <option value="fr">Französisch</option>
                  </select>
                </label>
                <label>
                  Max. Antwort-Tokens
                  <input
                    type="number"
                    min={64}
                    max={2000}
                    value={settings.maxOutputTokens}
                    onChange={(e) => update('maxOutputTokens', Number(e.target.value))}
                  />
                </label>
              </div>
            </section>
            <section className="settings-section audio-settings">
              <h2>Audioquellen</h2>
              {live && (
                <p className="audio-lock-note">
                  Die Audioeinstellungen sind während der Sitzung gesperrt. Beende die Sitzung, um
                  die Quellen oder den Transkriptionsmodus zu ändern.
                </p>
              )}
              <p>
                Für einen Call: dein Mikrofon plus das Audio des Gesprächs. Die Auswahl erfolgt beim
                Start.
              </p>
              <fieldset disabled={live}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.captureMic}
                    onChange={(e) => update('captureMic', e.target.checked)}
                  />
                  Mikrofon transkribieren
                </label>
                <div className="field-row">
                  <label>
                    Name deiner Spur
                    <input
                      value={settings.micLabel}
                      maxLength={60}
                      onChange={(e) => update('micLabel', e.target.value)}
                    />
                  </label>
                  <label>
                    Mikrofon
                    <select
                      value={settings.micDeviceId}
                      onChange={(e) => update('micDeviceId', e.target.value)}
                    >
                      <option value="">Standardmikrofon</option>
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
                  Call-Audio transkribieren
                </label>
                <div className="field-row">
                  <label>
                    Name der Call-Spur
                    <input
                      value={settings.systemLabel}
                      maxLength={60}
                      onChange={(e) => update('systemLabel', e.target.value)}
                    />
                  </label>
                  <label>
                    Call-Audioquelle
                    <select
                      value={settings.systemDeviceId}
                      onChange={(e) => update('systemDeviceId', e.target.value)}
                    >
                      <option value="">System / geteiltes Tab</option>
                      {devices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button className="text-button" onClick={() => void discoverDevices()}>
                  Audioeingänge laden
                  <Mic size={15} />
                </button>
                <p className="field-help">
                  Ein virtueller Audioeingang kann Systemaudio ersetzen, wenn dein Betriebssystem es
                  nicht direkt freigibt. Kopfhörer empfohlen.
                </p>
                <label>
                  Transkriptionsmodus
                  <select
                    value={settings.captureMode}
                    onChange={(e) =>
                      update('captureMode', e.target.value as Settings['captureMode'])
                    }
                  >
                    <option value="realtime">Schnell: getrennte Live-Kanäle</option>
                    <option value="diarized">Sprechererkennung in Audioblöcken</option>
                  </select>
                </label>
                {settings.captureMode === 'realtime' ? (
                  <>
                    <label>
                      Transkriptionsmodell
                      <select
                        value={settings.transcriptionModel}
                        onChange={(e) => update('transcriptionModel', e.target.value)}
                      >
                        <option value="gpt-live-transcribe">gpt-live-transcribe</option>
                        <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option>
                        <option value="gpt-4o-transcribe">gpt-4o-transcribe</option>
                      </select>
                    </label>
                    <p className="field-help">
                      „Ich“ und „Gegenüber“ werden anhand der Audioquelle zugeordnet. Mehrere
                      Stimmen im Call werden hier nicht getrennt erkannt.
                    </p>
                  </>
                ) : (
                  <>
                    <label>
                      Blocklänge in Sekunden
                      <input
                        type="number"
                        min={4}
                        max={30}
                        value={settings.diarizationChunkSeconds}
                        onChange={(e) => update('diarizationChunkSeconds', Number(e.target.value))}
                      />
                    </label>
                    <p className="field-help">
                      gpt-4o-transcribe-diarize erkennt Sprecher innerhalb jedes Blocks. Die Kennung
                      ist über Blockgrenzen nicht stabil. Ergebnisse erscheinen mit zusätzlicher
                      Verzögerung.
                    </p>
                  </>
                )}
              </fieldset>
            </section>
            <section className="settings-section prompt-settings">
              <h2>So soll dein Assistent helfen</h2>
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
                System-Prompt
                <textarea
                  rows={5}
                  value={settings.systemPrompt}
                  maxLength={12000}
                  onChange={(e) => update('systemPrompt', e.target.value)}
                />
              </label>
              <label>
                Gesprächskontext
                <textarea
                  rows={4}
                  value={settings.context}
                  maxLength={16000}
                  placeholder="Worum geht es? Was sollte das Modell wissen? Zum Beispiel: Angebot, Ziele, Hintergrund und Fakten."
                  onChange={(e) => update('context', e.target.value)}
                />
              </label>
              <label>
                Automatik-Prompt
                <textarea
                  rows={4}
                  value={settings.autoPrompt}
                  maxLength={12000}
                  onChange={(e) => update('autoPrompt', e.target.value)}
                />
              </label>
              <label>
                Mindestabstand automatischer Prüfungen (Sekunden)
                <input
                  type="number"
                  min={3}
                  max={60}
                  value={settings.autoCooldownMs / 1000}
                  onChange={(e) => update('autoCooldownMs', Number(e.target.value) * 1000)}
                />
              </label>
              <p className="field-help">
                Nach neuen Beiträgen der Call-Spur entscheidet das Modell anhand dieses Prompts, ob
                ein Vorschlag sinnvoll ist. Auch Prüfungen ohne Hinweis verbrauchen API-Tokens.
              </p>
            </section>
          </div>
          <div className="settings-bottom">
            <p>
              Änderungen gelten sofort. Eine gespeicherte Vorlage enthält Prompts und Kontext auf
              diesem Gerät, keine Keys oder Transkripte.
            </p>
            <button
              className="secondary-button"
              onClick={() => {
                try {
                  localStorage.setItem(
                    settingsKey,
                    JSON.stringify(safeSettings(settings, DEFAULT_SETTINGS)),
                  );
                  setNotice('Vorlage auf diesem Gerät gespeichert.');
                } catch {
                  setError('Vorlage konnte nicht gespeichert werden.');
                }
              }}
            >
              Vorlage speichern
            </button>
            <button
              className="quiet-button"
              disabled={live}
              onClick={() => {
                localStorage.removeItem(settingsKey);
                setSettings({ ...DEFAULT_SETTINGS });
                setNotice('Einstellungen zurückgesetzt und gespeicherte Vorlage entfernt.');
              }}
            >
              Zurücksetzen
            </button>
          </div>
        </main>
      )}
    </div>
  );
}
