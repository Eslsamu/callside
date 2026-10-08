import { DesktopUpdates } from './DesktopUpdates';
import { LocalAudioSetup } from './LocalAudioSetup';
import { ResultMarkdown } from './ResultMarkdown';
import { FittedResult } from './FittedResult';
import { answerInstructions } from '../shared/instructions';
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
  Maximize2,
  Minimize2,
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
import { MAX_CONTEXT_CHARACTERS } from '../shared/tasks';
import type {
  Bootstrap,
  ChatGPTStatus,
  CaptureHandle,
  Settings,
  Source,
  Suggestion,
  TranscriptEntry,
  RequestUsage,
} from '../shared/types';
import { startCapture } from './audio/capture';
import { TranscriptReconciler } from './audio/reconcile';
import { streamAnswer } from './api';
import { DEMO_TURNS, safeSettings, sessionMarkdown } from './session';
import { createLibrary, saveTemplates } from './template';
import type { TemplateLibrary } from '../shared/templates';

const time = (value: number) =>
  new Date(value).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export default function App({
  initialSettings,
  initialError,
  initialLibrary,
}: {
  initialLibrary?: TemplateLibrary;
  initialSettings: Settings;
  initialError: string;
}) {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [library, setLibrary] = useState(() => initialLibrary ?? createLibrary(initialSettings));
  const [activeTemplate, setActiveTemplate] = useState(
    () => (initialLibrary ?? createLibrary(initialSettings)).activeId,
  );
  const [templateName, setTemplateName] = useState(
    () =>
      (initialLibrary ?? createLibrary(initialSettings)).templates.find(
        (t) => t.id === (initialLibrary ?? createLibrary(initialSettings)).activeId,
      )!.name,
  );
  const drafts = useRef<Record<string, Settings>>({});
  const [deletePending, setDeletePending] = useState(false);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [settingsPage, setSettingsPage] = useState('task');
  const [answersMaximized, setAnswersMaximized] = useState(false);
  useEffect(() => {
    if (!answersMaximized) return;
    const restore = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAnswersMaximized(false);
    };
    window.addEventListener('keydown', restore);
    return () => window.removeEventListener('keydown', restore);
  }, [answersMaximized]);
  const [view, setView] = useState<'session' | 'settings'>('session');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [requestUsage, setRequestUsage] = useState<RequestUsage[]>([]);
  const [listening, setListening] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [demo, setDemo] = useState(false);
  const [auto, setAuto] = useState(false);
  const [consent, setConsent] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateFeedback, setTemplateFeedback] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [notice, setNotice] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [chatgptBusy, setChatgptBusy] = useState(false);
  const [chatgptError, setChatgptError] = useState('');
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
  const autoSeen = useRef(new Set<string>());
  const lastAutoAt = useRef(0);
  const sessionEpoch = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const shortcuts = useRef<Record<string, boolean>>({});
  const reconciler = useRef(new TranscriptReconciler());
  const echoNotified = useRef(false);
  const lastTemplateSettings = useRef(settings);

  useEffect(() => {
    if (settings !== lastTemplateSettings.current) setTemplateFeedback(null);
  }, [settings]);

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
          setNotice('A global shortcut is already in use. Use the other shortcut or Help now.');
      })
      .catch(() => {});
    return () => {
      abort.abort();
    };
  }, []);
  const chatgptAction = useCallback(async (action: string, accountId?: string) => {
    const token = latest.current.bootstrap?.token;
    if (!token) return;
    setChatgptBusy(true);
    setChatgptError('');
    try {
      const response = await fetch(`/api/chatgpt/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-callside-token': token },
        body: JSON.stringify({ accountId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'ChatGPT connection failed.');
      setBootstrap((current) => (current ? { ...current, chatgpt: data } : current));
      if (action === 'connect')
        setSettings((current) => ({ ...current, answerBilling: 'chatgpt' }));
      if (action === 'models' && data.models.length)
        setSettings((current) =>
          safeSettings(
            {
              ...current,
              model: data.models.some((m: { id: string }) => m.id === current.model)
                ? current.model
                : data.models[0].id,
            },
            DEFAULT_SETTINGS,
          ),
        );
    } catch (error) {
      setChatgptError(error instanceof Error ? error.message : 'ChatGPT connection failed.');
    } finally {
      setChatgptBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!bootstrap?.chatgpt?.pending) return;
    const abort = new AbortController();
    const interval = setInterval(() => {
      fetch('/api/chatgpt', {
        headers: { 'x-callside-token': bootstrap.token },
        signal: abort.signal,
      })
        .then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then((chatgpt: ChatGPTStatus) =>
          setBootstrap((current) => (current ? { ...current, chatgpt } : current)),
        )
        .catch(() => {});
    }, 1000);
    return () => {
      clearInterval(interval);
      abort.abort();
    };
  }, [bootstrap?.chatgpt?.pending, bootstrap?.token]);
  useEffect(() => {
    if (bootstrap?.chatgpt?.connected && !bootstrap.chatgpt.pending) void chatgptAction('models');
  }, [
    bootstrap?.chatgpt?.connected,
    bootstrap?.chatgpt?.activeId,
    bootstrap?.chatgpt?.pending,
    chatgptAction,
  ]);
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
    if (
      !state.bootstrap ||
      (!state.entries.length && !typed.trim() && !state.settings.context.trim())
    )
      return;
    if (state.settings.context.length > MAX_CONTEXT_CHARACTERS) {
      setError(
        `Reference material exceeds ${MAX_CONTEXT_CHARACTERS.toLocaleString('en-US')} characters. Shorten it in Settings before running the task.`,
      );
      return;
    }
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
        if ((event.type === 'done' || event.type === 'skip') && event.usage) {
          setRequestUsage((current) => [
            ...current,
            {
              timestamp: Date.now(),
              model: state.settings.model,
              billing: state.settings.answerBilling,
              mode,
              skipped: event.type === 'skip',
              usage: event.usage!,
            },
          ]);
        }
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
        setError(e instanceof Error ? e.message : 'The task failed. Try again.');
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

  const automaticTurn = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.final &&
        (settings.autoTriggerSource === 'either' || entry.source === settings.autoTriggerSource),
    );
  const automaticTurnKey = automaticTurn
    ? `${automaticTurn.source}:${automaticTurn.turnId ?? automaticTurn.id}`
    : '';
  const contextTooLong = settings.context.length > MAX_CONTEXT_CHARACTERS;
  useEffect(() => {
    if (
      !auto ||
      !listening ||
      busy ||
      contextTooLong ||
      !automaticTurnKey ||
      autoSeen.current.has(automaticTurnKey)
    )
      return;
    const delay = Math.max(550, settings.autoCooldownMs - (Date.now() - lastAutoAt.current));
    autoTimer.current = setTimeout(() => {
      autoSeen.current.add(automaticTurnKey);
      lastAutoAt.current = Date.now();
      void requestAnswer('auto');
    }, delay);
    return () => clearTimeout(autoTimer.current);
  }, [
    auto,
    listening,
    busy,
    contextTooLong,
    automaticTurnKey,
    settings.autoCooldownMs,
    settings.autoTriggerSource,
    requestAnswer,
  ]);

  useEffect(() => {
    if (!auto && activeMode.current === 'auto') answerRef.current?.abort();
  }, [auto]);
  useEffect(() => {
    const trigger = () => {
      void requestAnswer('manual');
    };
    const unregister = window.callsideDesktop?.onAnswer(trigger);
    const handler = (event: KeyboardEvent) => {
      if (
        event.key === 'F8' ||
        ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'Space')
      ) {
        event.preventDefault();
        if (event.repeat) return;
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
    setRequestUsage([]);
    setElapsed(0);
    setQuestion('');
    autoSeen.current.clear();
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
    if (!bootstrap) return;
    if (settings.transcriptionProvider === 'openai' && !bootstrap.hasApiKey) {
      setSettingsPage('connections');
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
        safeSettings(
          {
            ...settings,
            backgroundSpeakers:
              settings.backgroundSpeakers &&
              (settings.diarizationProvider === 'local' || bootstrap.hasApiKey),
          },
          DEFAULT_SETTINGS,
        ),
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

  function selectTemplate(id: string) {
    drafts.current[activeTemplate] = settings;
    const selected = library.templates.find((t) => t.id === id);
    if (!selected) return;
    setActiveTemplate(id);
    setTemplateName(selected.name);
    const nextSettings = drafts.current[id] ?? { ...selected.settings };
    lastTemplateSettings.current = nextSettings;
    setSettings(nextSettings);
    setTemplateFeedback(null);
    setDeletePending(false);
  }

  async function persistTemplate(action: 'save' | 'new' | 'rename' | 'delete' = 'save') {
    if (templateBusy) return;
    const name = templateName.trim();
    if (
      action !== 'delete' &&
      (!name ||
        name.length > 80 ||
        library.templates.some(
          (t) =>
            t.name.toLowerCase() === name.toLowerCase() &&
            (action === 'new' || t.id !== activeTemplate),
        ))
    ) {
      setTemplateFeedback({ text: 'Enter a unique template name (1–80 characters).', error: true });
      return;
    }
    if (action === 'delete' && library.templates.length === 1) return;
    const id = action === 'new' ? crypto.randomUUID() : activeTemplate;
    const snapshot = safeSettings(settings, DEFAULT_SETTINGS);
    const templates =
      action === 'delete'
        ? library.templates.filter((t) => t.id !== id)
        : action === 'new'
          ? [...library.templates, { id, name, settings: snapshot }]
          : library.templates.map((t) =>
              t.id === id
                ? { ...t, name, settings: action === 'rename' ? t.settings : snapshot }
                : t,
            );
    const next: TemplateLibrary = {
      ...library,
      version: 2,
      activeId: action === 'delete' ? templates[0].id : id,
      templates,
    };
    setTemplateBusy(true);
    try {
      await saveTemplates(next);
      if (action === 'new') drafts.current[activeTemplate] = snapshot;
      setLibrary(next);
      setActiveTemplate(next.activeId);
      const selected = templates.find((t) => t.id === next.activeId)!;
      setTemplateName(selected.name);
      if (action === 'delete') {
        delete drafts.current[id];
        const nextSettings = drafts.current[selected.id] ?? { ...selected.settings };
        lastTemplateSettings.current = nextSettings;
        setSettings(nextSettings);
      } else if (action !== 'rename') drafts.current[id] = snapshot;
      setDeletePending(false);
      setTemplateFeedback({
        text:
          action === 'delete'
            ? 'Template deleted.'
            : action === 'rename'
              ? 'Template renamed.'
              : 'Template saved. It will load automatically when you reopen Callside.',
        error: false,
      });
    } catch {
      setTemplateFeedback({
        text: 'Could not save templates. Your edits are still here; please try again.',
        error: true,
      });
    } finally {
      setTemplateBusy(false);
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
                  (settings.diarizationProvider === 'local' || Boolean(bootstrap?.hasApiKey)) &&
                  settings.captureSystem &&
                  !demo,
                provider: settings.diarizationProvider,
                batchSeconds:
                  settings.diarizationProvider === 'local' ? 4 : settings.diarizationChunkSeconds,
                status: attributionStatus,
              },
              suggestions,
              requestUsage,
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
      setError('Copying was blocked. Select the result text and copy it with your keyboard.');
    }
  }
  const current = suggestions.at(-1);
  const live = listening || starting || stopping;
  useEffect(() => {
    void window.callsideDesktop?.setSessionActive?.(live || busy || setupBusy);
  }, [live, busy, setupBusy]);
  const minutes = `${Math.floor(elapsed / 60)
    .toString()
    .padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;

  return (
    <div
      className={`app-shell ${view === 'session' ? 'session-shell' : ''} ${view === 'session' && answersMaximized ? 'answers-maximized' : ''}`}
    >
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
            <span className="small-dot" /> Local server
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

      {bootstrap?.chatgpt?.welcomePending && (
        <section className="message notice" role="dialog" aria-label="ChatGPT plan connected">
          <span>
            You're using your ChatGPT plan for eligible suggestions. OpenAI audio processing, when
            enabled, uses API credit. Manage plan limits in ChatGPT Settings.
          </span>
          <button disabled={chatgptBusy} onClick={() => void chatgptAction('welcome')}>
            Got it
          </button>
        </section>
      )}
      {view === 'session' ? (
        <main className="session-view">
          <section className="session-top" aria-label="Recording controls">
            <div className="session-heading">
              <h1>Conversation</h1>
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
                  disabled={starting || stopping || setupBusy || !bootstrap}
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
                  : starting
                    ? 'Connecting'
                    : stopping
                      ? 'Finishing transcription'
                      : 'Not recording'}
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
                      : settings.transcriptionProvider === 'local'
                        ? 'Local · separate audio channels'
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
                    <h3>No transcript yet</h3>
                    <p>
                      {live
                        ? 'Waiting for speech from the enabled audio sources.'
                        : 'Start call to transcribe the enabled audio sources.'}
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
                    <button
                      disabled={!entries.length && !suggestions.length}
                      onClick={() => download('md')}
                    >
                      Transcript as Markdown
                    </button>
                    <button
                      disabled={!entries.length && !suggestions.length && !requestUsage.length}
                      onClick={() => download('json')}
                    >
                      Session as JSON
                    </button>
                  </div>
                </details>
              </div>
            </section>

            <section className="assistant-pane" aria-labelledby="assistant-title">
              <div className="pane-header">
                <h2 id="assistant-title">Results</h2>
                <span className="model-label">
                  {settings.model} ·{' '}
                  {demo
                    ? 'Demo'
                    : settings.answerBilling === 'chatgpt'
                      ? 'Using ChatGPT plan'
                      : 'API credit'}
                </span>
                <button
                  className="icon-button maximize-results"
                  aria-label={answersMaximized ? 'Restore results layout' : 'Maximize results'}
                  aria-pressed={answersMaximized}
                  title={answersMaximized ? 'Restore layout (Esc)' : 'Maximize results'}
                  onClick={() => setAnswersMaximized((value) => !value)}
                >
                  {answersMaximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </button>
              </div>
              <label className="auto-control">
                <span>
                  <Zap size={16} />
                  <span>
                    Automatic hints<small>Uses the automatic mode prompt in Settings.</small>
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
                            ? 'Command'
                            : 'Result'}
                      </span>
                      <time>{time(current.timestamp)}</time>
                    </div>
                    {current.question && <p className="asked-question">{current.question}</p>}
                    <FittedResult
                      allowColumns={!answersMaximized}
                      text={current.text}
                      streaming={current.status === 'streaming'}
                    />
                    <div className="suggestion-bottom">
                      <span>
                        {current.status === 'streaming'
                          ? 'Drafting …'
                          : current.status === 'error'
                            ? 'Incomplete result'
                            : 'Complete'}
                      </span>
                      <button
                        className="icon-button"
                        aria-label="Copy result"
                        onClick={() => void copy(current)}
                      >
                        {copied === current.id ? <Check size={17} /> : <Copy size={17} />}
                      </button>
                    </div>
                  </article>
                ) : (
                  <div className="empty-answer">
                    <h3>No results yet</h3>
                    <p>
                      Press F8 or Help now to run your task using the transcript and reference
                      material. Configure the task in Settings.
                    </p>
                  </div>
                )}
                {busy && !current?.text && (
                  <p className="thinking">
                    <span className="status-dot live" />
                    {activeMode.current === 'auto'
                      ? 'Checking whether a hint would help …'
                      : 'Working on your task …'}
                  </p>
                )}
              </div>
              {suggestions.length > 1 && (
                <details className="history">
                  <summary>{suggestions.length - 1} previous results</summary>
                  <div>
                    {suggestions
                      .slice(0, -1)
                      .reverse()
                      .map((s) => (
                        <article key={s.id}>
                          <time>{time(s.timestamp)}</time>
                          <div className="markdown-result">
                            <ResultMarkdown text={s.text} />
                          </div>
                        </article>
                      ))}
                  </div>
                </details>
              )}
              <div className="answer-controls">
                <button
                  className="answer-button"
                  disabled={
                    !bootstrap ||
                    busy ||
                    contextTooLong ||
                    (!entries.some((e) => e.text.trim()) && !settings.context.trim())
                  }
                  onClick={() => void requestAnswer('manual')}
                >
                  <Zap size={18} />
                  {busy ? 'Thinking …' : 'Help now'}
                  <kbd>F8</kbd>
                </button>
                <details className="command-options">
                  <summary>Specific command (optional)</summary>
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
                      aria-label="Command"
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder="Enter a command …"
                      maxLength={4000}
                    />
                    <button
                      type="submit"
                      aria-label="Run command"
                      disabled={!question.trim() || busy || !bootstrap || contextTooLong}
                    >
                      <ArrowRight size={18} />
                    </button>
                  </form>
                </details>
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
              {demo
                ? 'Demo data · no audio recorded'
                : settings.transcriptionProvider === 'local'
                  ? settings.diarizationProvider === 'openai' &&
                    bootstrap?.hasApiKey &&
                    settings.captureSystem
                    ? 'Local transcription · call audio sent to OpenAI for speaker labels'
                    : 'Local transcription · no audio uploads'
                  : 'Audio sent to OpenAI · no local recording'}
              <span className="footer-divider">/</span>Transcript kept in this session only
            </span>
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
              <h1>Settings</h1>
            </div>
            <button className="quiet-button" onClick={() => setView('session')}>
              Back to conversation
              <ArrowRight size={16} />
            </button>
          </div>
          <nav className="settings-tabs" aria-label="Settings sections">
            {(
              [
                ['task', 'Templates & task'],
                ['models', 'Models'],
                ['audio', 'Audio'],
                ['connections', 'Connections'],
                ['app', 'App'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-current={settingsPage === id ? 'page' : undefined}
                onClick={() => setSettingsPage(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <p className="settings-template-summary">
            Current template:{' '}
            <strong>{library.templates.find((t) => t.id === activeTemplate)?.name}</strong>
          </p>
          {settingsPage === 'app' &&
            (window.callsideDesktop ? (
              <DesktopUpdates disabled={live || busy || setupBusy} />
            ) : (
              <section className="settings-section">
                <h2>Browser version</h2>
                <p>Global shortcuts and application updates are available in the desktop app.</p>
              </section>
            ))}
          <section
            hidden={settingsPage !== 'task'}
            className="settings-section template-manager"
            aria-label="Template library"
          >
            <div className="field-row">
              <label>
                Saved templates
                <select
                  aria-label="Saved templates"
                  value={activeTemplate}
                  disabled={live || busy || templateBusy}
                  onChange={(e) => selectTemplate(e.target.value)}
                >
                  {library.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Template name
                <input
                  value={templateName}
                  maxLength={80}
                  disabled={templateBusy}
                  onChange={(e) => setTemplateName(e.target.value)}
                />
              </label>
            </div>
            <div className="template-actions">
              <button
                className="secondary-button"
                disabled={templateBusy}
                onClick={() => void persistTemplate('new')}
              >
                Save as new
              </button>
              <button
                className="quiet-button"
                disabled={templateBusy}
                onClick={() => void persistTemplate('rename')}
              >
                Rename
              </button>
              <button
                className="quiet-button"
                disabled={live || busy || templateBusy || library.templates.length < 2}
                onClick={() => setDeletePending(true)}
              >
                Delete template
              </button>
              {deletePending && (
                <>
                  <span>
                    Delete “{library.templates.find((t) => t.id === activeTemplate)?.name}”?
                  </span>
                  <button
                    className="quiet-button"
                    disabled={templateBusy}
                    onClick={() => void persistTemplate('delete')}
                  >
                    Confirm delete
                  </button>
                  <button className="quiet-button" onClick={() => setDeletePending(false)}>
                    Cancel
                  </button>
                </>
              )}
            </div>
            <p className="field-help">
              Each template has its own settings, instructions, and reference material. Switching
              keeps unsaved field edits until you close the app. Save template makes them permanent.
              To create a copy, enter a new name and choose Save as new.
            </p>
          </section>
          <div className={`settings-grid settings-page-${settingsPage}`}>
            <section hidden={settingsPage !== 'connections'} className="settings-section">
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
            <section hidden={settingsPage !== 'connections'} className="settings-section">
              <h2>Suggestion connection</h2>
              {bootstrap?.chatgpt?.available && (
                <button
                  className="text-button"
                  disabled={chatgptBusy}
                  onClick={() => void chatgptAction('usage')}
                >
                  Manage ChatGPT usage
                </button>
              )}
              <label>
                Pay for suggestions with
                <select
                  value={settings.answerBilling}
                  disabled={busy}
                  onChange={(e) =>
                    update('answerBilling', e.target.value as Settings['answerBilling'])
                  }
                >
                  <option value="api">OpenAI API credit</option>
                  <option value="chatgpt">ChatGPT subscription</option>
                </select>
              </label>
              <p>
                ChatGPT suggestions use your plan limits. Only audio options set to OpenAI use API
                credit. Subscription requests never fall back to API billing.
              </p>
              {!bootstrap?.chatgpt?.available ? (
                <p className="field-help">Open the desktop app to connect ChatGPT.</p>
              ) : (
                <>
                  <p className="key-state">
                    {bootstrap.chatgpt.connected ? 'ChatGPT connected' : 'ChatGPT not connected'}
                  </p>
                  {bootstrap.chatgpt.accounts.length > 0 && (
                    <label>
                      ChatGPT account
                      <select
                        value={bootstrap.chatgpt.activeId ?? ''}
                        disabled={chatgptBusy || bootstrap.chatgpt.pending || busy}
                        onChange={(e) => void chatgptAction('select', e.target.value)}
                      >
                        {bootstrap.chatgpt.accounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.label}
                            {account.connected ? '' : ' (signed out)'}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {bootstrap.chatgpt.pending ? (
                    <>
                      <p>Complete sign-in in your browser, then return here.</p>
                      <button
                        className="secondary-button"
                        disabled={chatgptBusy}
                        onClick={() => void chatgptAction('cancel')}
                      >
                        Cancel sign-in
                      </button>
                    </>
                  ) : (
                    <div className="chatgpt-actions">
                      <div className="chatgpt-action-row">
                        <button
                          className="secondary-button"
                          disabled={chatgptBusy || busy}
                          onClick={() => void chatgptAction('connect', bootstrap.chatgpt?.activeId)}
                        >
                          Continue with ChatGPT
                        </button>
                        {bootstrap.chatgpt.accounts.length > 0 && (
                          <button
                            className="text-button"
                            disabled={chatgptBusy || busy}
                            onClick={() => void chatgptAction('connect')}
                          >
                            Add another account
                          </button>
                        )}
                      </div>
                      {bootstrap.chatgpt.connected && (
                        <div className="chatgpt-action-row">
                          <button
                            className="text-button"
                            disabled={chatgptBusy}
                            onClick={() => void chatgptAction('models')}
                          >
                            Refresh available models
                          </button>
                          <button
                            className="text-button"
                            disabled={chatgptBusy}
                            onClick={() => void chatgptAction('disconnect')}
                          >
                            Sign out of ChatGPT
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <p className="field-help">
                    Credentials are encrypted on this device and excluded from templates and
                    exports. Manage limits and connected apps in ChatGPT Settings.
                  </p>
                </>
              )}
              {(chatgptError || bootstrap?.chatgpt?.error) && (
                <p role="alert">{chatgptError || bootstrap?.chatgpt?.error}</p>
              )}
            </section>
            <section hidden={settingsPage !== 'models'} className="settings-section">
              <h2>Model & language</h2>
              <label>
                Task model
                <select
                  value={settings.model}
                  onChange={(e) =>
                    setSettings((current) =>
                      safeSettings({ ...current, model: e.target.value }, DEFAULT_SETTINGS),
                    )
                  }
                >
                  {settings.answerBilling === 'chatgpt' &&
                    !bootstrap?.chatgpt?.models.some((m) => m.id === settings.model) && (
                      <option value={settings.model}>Connect ChatGPT / refresh models</option>
                    )}
                  {(settings.answerBilling === 'chatgpt'
                    ? (bootstrap?.chatgpt?.models.map((m) => m.id) ?? [])
                    : ANSWER_MODELS
                  ).map((model) => (
                    <option key={model} value={model}>
                      {settings.answerBilling === 'chatgpt'
                        ? bootstrap?.chatgpt?.models.find((m) => m.id === model)?.name
                        : model
                            .replace(/^gpt-(6(?:\.1)?)-/, 'GPT-$1 ')
                            .replace(
                              /\b(luna|sol|astra)\b/g,
                              (name) => name[0].toUpperCase() + name.slice(1),
                            )}
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-help">
                {settings.answerBilling === 'chatgpt'
                  ? 'Models come from the selected account’s ChatGPT connection. This list can differ from the models in ChatGPT itself.'
                  : 'Availability depends on your OpenAI API project.'}
              </p>
              {settings.answerBilling === 'chatgpt' && (
                <details className="model-availability">
                  <summary>Why is a model missing?</summary>
                  <button
                    className="text-button"
                    disabled={chatgptBusy || !bootstrap?.chatgpt?.connected}
                    onClick={() => void chatgptAction('models')}
                  >
                    Refresh model availability
                  </button>
                  {bootstrap?.chatgpt?.modelCatalog ? (
                    <>
                      <ul>
                        {ANSWER_MODELS.map((id) => {
                          const model = bootstrap.chatgpt!.modelCatalog!.find((m) => m.id === id);
                          return (
                            <li key={id}>
                              {id}:{' '}
                              {!model
                                ? 'Not returned by OpenAI'
                                : model.visibility !== 'list'
                                  ? `Returned by OpenAI but hidden from the picker (${model.visibility})`
                                  : 'Available'}
                            </li>
                          );
                        })}
                      </ul>
                      {bootstrap.chatgpt.modelCatalog.some((m) => !m.supported) && (
                        <p>
                          Other returned model IDs (not supported by Callside):{' '}
                          {bootstrap.chatgpt.modelCatalog
                            .filter((m) => !m.supported)
                            .map((m) => m.id)
                            .join(', ')}
                        </p>
                      )}
                    </>
                  ) : (
                    <p>
                      Refresh to inspect the catalog returned by OpenAI. This does not generate an
                      answer.
                    </p>
                  )}
                </details>
              )}
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
                {settings.answerBilling === 'chatgpt'
                  ? 'Fast requests priority processing where your plan allows it. OpenAI documents 2.5× included subscription usage for Fast mode; purchased credits use 2×. Custom output caps remain unavailable.'
                  : 'Fast requests priority processing at 2× standard token rates, where available.'}{' '}
                Higher reasoning can increase response time and token use. The token budget includes
                reasoning and the visible result.
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
                  Output token limit
                  <select
                    disabled={settings.answerBilling === 'chatgpt'}
                    value={
                      settings.answerBilling === 'chatgpt' || settings.maxOutputTokens === null
                        ? 'model'
                        : 'custom'
                    }
                    onChange={(e) =>
                      update('maxOutputTokens', e.target.value === 'model' ? null : 4096)
                    }
                  >
                    <option value="model">Model default</option>
                    <option value="custom">Custom limit</option>
                  </select>
                </label>
              </div>
              {settings.answerBilling !== 'chatgpt' && settings.maxOutputTokens !== null && (
                <label>
                  Maximum output tokens
                  <input
                    type="number"
                    min={64}
                    max={32768}
                    value={settings.maxOutputTokens}
                    onChange={(e) => update('maxOutputTokens', Number(e.target.value))}
                  />
                </label>
              )}
              <p className="field-help">
                The limit includes internal reasoning and the visible result. Model default leaves
                the token limit to the model. Task instructions control length; requests still have
                a time limit.
              </p>
            </section>
            <section hidden={settingsPage !== 'audio'} className="settings-section audio-settings">
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
                <button
                  className="secondary-button"
                  onClick={() =>
                    setSettings((current) => ({
                      ...current,
                      answerBilling: 'chatgpt',
                      transcriptionProvider: 'local',
                      diarizationProvider: 'local',
                      backgroundSpeakers: true,
                      captureMode: 'realtime',
                    }))
                  }
                >
                  Use local audio + ChatGPT subscription
                </button>
                <p className="field-help">
                  No metered API calls in this configuration. Connect to ChatGPT for suggestions;
                  your subscription limits apply.
                </p>
                {window.callsideDesktop && bootstrap && (
                  <LocalAudioSetup token={bootstrap.token} disabled={live} onBusy={setSetupBusy} />
                )}
                <label>
                  Transcription processing
                  <select
                    value={settings.transcriptionProvider}
                    onChange={(e) =>
                      setSettings((current) => ({
                        ...current,
                        transcriptionProvider: e.target.value as Settings['transcriptionProvider'],
                        captureMode: 'realtime',
                      }))
                    }
                  >
                    <option value="local">Local · Whisper</option>
                    <option value="openai">OpenAI · API key</option>
                  </select>
                </label>
                {settings.transcriptionProvider === 'local' && (
                  <p className="field-help">
                    Whisper large-v3-turbo runs on this computer. First start downloads a 574 MB
                    model.{' '}
                    {window.callsideDesktop
                      ? 'The desktop app includes the runtime.'
                      : 'Install whisper.cpp first (macOS: brew install whisper-cpp).'}{' '}
                    Audio stays local unless OpenAI speaker labeling below is enabled. Suggestions
                    still send transcript text to your selected answer provider.
                  </p>
                )}
                {settings.transcriptionProvider === 'openai' && (
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
                )}
                {settings.captureMode === 'realtime' ? (
                  <>
                    {settings.transcriptionProvider === 'openai' && (
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
                    )}
                    <label>
                      Speaker labeling
                      <select
                        value={settings.diarizationProvider}
                        onChange={(e) =>
                          setSettings((current) => ({
                            ...current,
                            diarizationProvider: e.target.value as Settings['diarizationProvider'],
                            backgroundSpeakers: e.target.value !== 'off',
                          }))
                        }
                      >
                        <option value="off">Off · microphone / other speaker</option>
                        <option value="local">Local · LS-EEND (experimental)</option>
                        <option value="openai" disabled={!bootstrap?.hasApiKey}>
                          OpenAI · API key
                        </option>
                      </select>
                    </label>
                    <p className="field-help">
                      Labels arrive in the background without delaying suggestions. Local labeling
                      supports up to four remote voices. The Mac installer and Windows test package
                      include the speaker runtime. The Windows test package also includes the model;
                      on Mac it downloads on first use. Labels are estimates; mixed turns may remain
                      unassigned. Microphone echo can still cause duplicates without headphones.
                    </p>
                    {settings.diarizationProvider === 'openai' && (
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
            <section hidden={settingsPage !== 'task'} className="settings-section prompt-settings">
              <h2>Task configuration</h2>
              <p className="field-help">
                Task instructions are sent exactly as written. Callside adds no hidden style,
                length, or interview instructions. Reference material, transcript, previous results,
                and any typed command are sent separately as context.
              </p>
              <label>
                Task instructions
                <textarea
                  rows={5}
                  value={settings.systemPrompt}
                  aria-label="Task instructions"
                  maxLength={12000}
                  onChange={(e) => update('systemPrompt', e.target.value)}
                />
              </label>
              <label>
                Reference material
                <textarea
                  rows={4}
                  value={settings.context}
                  aria-label="Reference material"
                  aria-describedby="reference-help"
                  aria-invalid={contextTooLong}
                  placeholder="Paste course notes, documentation, or facts. Include section and exercise identifiers."
                  onChange={(e) => update('context', e.target.value)}
                />
              </label>
              <p
                id="reference-help"
                className="field-help"
                role={contextTooLong ? 'alert' : undefined}
              >
                {settings.context.length.toLocaleString('en-US')} /{' '}
                {MAX_CONTEXT_CHARACTERS.toLocaleString('en-US')} characters.
                {contextTooLong
                  ? ' Shorten the material before running a task. Your pasted text has been kept in full.'
                  : ' Included in full with each request, alongside recent conversation. Saved on this device with Save template.'}
              </p>
              <label>
                Automatic trigger source
                <select
                  value={settings.autoTriggerSource}
                  onChange={(e) =>
                    update('autoTriggerSource', e.target.value as Settings['autoTriggerSource'])
                  }
                >
                  <option value="system">Other speakers (call audio)</option>
                  <option value="mic">Me (microphone)</option>
                  <option value="either">Either</option>
                </select>
              </label>
              <label>
                Automatic mode prompt
                <textarea
                  rows={4}
                  value={settings.autoPrompt}
                  aria-label="Automatic mode prompt"
                  maxLength={12000}
                  onChange={(e) => update('autoPrompt', e.target.value)}
                />
              </label>
              <label>
                Full automatic-mode addition (read-only)
                <textarea
                  rows={6}
                  readOnly
                  value={answerInstructions(settings, 'auto').modeInstructions}
                />
              </label>
              <p className="field-help">
                Manual requests use only Task instructions. Automatic requests also include the
                exact addition above. The [[WAIT]] marker lets Callside stay silent when your rule
                does not call for a result.
              </p>
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
                After finalized transcript segments from the selected source, the model checks this
                rule. Checks that produce no result also consume API tokens. F8 runs the task
                immediately using available text.
              </p>
            </section>
          </div>
          {settingsPage === 'task' && (
            <div className="settings-bottom">
              <div className="template-copy">
                <p>
                  Changes apply immediately. Save template updates only the selected template on
                  this device. Keys and transcripts are never included.
                </p>
                {templateFeedback && (
                  <p
                    className={`template-feedback ${templateFeedback.error ? 'error' : ''}`}
                    role={templateFeedback.error ? 'alert' : 'status'}
                    data-testid="template-feedback"
                  >
                    {templateFeedback.text}
                  </p>
                )}
              </div>
              <button
                className="secondary-button"
                disabled={templateBusy}
                onClick={() => void persistTemplate()}
              >
                {templateBusy ? 'Saving …' : 'Save template'}
              </button>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
