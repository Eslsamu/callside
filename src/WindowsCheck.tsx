import { useEffect, useRef, useState } from 'react';
import { prepareLocal } from './audio/local-sink';
import { startCapture } from './audio/capture';
import { TranscriptReconciler } from './audio/reconcile';
import { streamAnswer } from './api';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { ANSWER_MODELS, reasoningOptions } from '../shared/models';
import type {
  Bootstrap,
  CaptureHandle,
  ChatGPTStatus,
  Settings,
  TranscriptEntry,
  Source,
} from '../shared/types';
import type { SetupProgress } from './audio/setup-progress';
import './windows-check.css';

type State = 'not-run' | 'running' | 'review' | 'pass' | 'fail' | 'stopped' | 'skipped';
type AudioCheck = Source | 'conversation' | 'call';
type Judgment = 'transcript' | 'echo' | 'speakers';
type Result = {
  state: State;
  text: string;
  peak: number;
  message: string;
  errors: string[];
  firstTextMs?: number;
  durationMs?: number;
  matches?: boolean;
  entries: TranscriptEntry[];
  peaks: Record<Source, number>;
  echoCount: number;
  speakerCount: number;
  attributionEvents: number;
  attributionMessage: string;
  attributionDelayMs?: number;
  judgments: Partial<Record<Judgment, boolean>>;
  localInference?: Array<
    import('../shared/local-test').LocalMeasurement & { source: Source; empty: boolean }
  >;
};
type Shortcut = { state: State; received: number; outsideApp: boolean; message: string };
type Answer = {
  billing?: Settings['answerBilling'];
  state: State;
  connected: boolean;
  model: string;
  models: string[];
  text: string;
  message: string;
  errors: string[];
  firstTextMs?: number;
  durationMs?: number;
  requestCount: number;
};
type Restart = {
  state: State;
  message: string;
  settingsMatch?: boolean;
  chatgptPersisted?: boolean;
  secureStoragePersisted?: boolean;
};
type Checkpoint = {
  sessionId: string;
  nonce: string;
  expected: Pick<Settings, 'language' | 'captureMic' | 'captureSystem' | 'answerBilling' | 'model'>;
  chatgptWasConnected: boolean;
  previousTemplate: Settings | null;
};
type SavedState = {
  schemaVersion: 2;
  savedAt: string;
  checks: Record<AudioCheck, Result> & { shortcut: Shortcut; chatgpt: Answer; restart: Restart };
  preferences: { output: string; model: string };
  notes: string;
  restartCheckpoint?: Checkpoint;
};
const empty = (): Result => ({
  state: 'not-run',
  text: '',
  peak: 0,
  message: 'Not tested',
  errors: [],
  entries: [],
  peaks: { mic: 0, system: 0 },
  echoCount: 0,
  speakerCount: 0,
  attributionEvents: 0,
  attributionMessage: '',
  judgments: {},
});
const emptyAnswer = (): Answer => ({
  state: 'not-run',
  connected: false,
  model: '',
  models: [],
  text: '',
  message: 'Not tested',
  errors: [],
  requestCount: 0,
});
const phrases = {
  mic: 'This is the microphone test. Today we are testing Callside on Windows.',
  system: "Euros, which I don't actually know what that is in Pounds, at all. Any ideas?",
};
const labels: Record<AudioCheck, string> = {
  mic: 'Microphone',
  system: 'Computer audio',
  conversation: 'Conversation and speakers',
  call: 'Call application',
};
const statuses: Record<State, string> = {
  'not-run': 'Not tested',
  running: 'In progress',
  review: 'Review needed',
  pass: 'Passed',
  fail: 'Needs review',
  stopped: 'Interrupted',
  skipped: 'Skipped',
};
const safeMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home)\/)[^\s]+/g, '[local path]')
    .replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi, '[redacted]')
    .slice(0, 600);
const restoreState = <T extends { state: State; message: string }>(value: T): T =>
  value.state === 'running'
    ? {
        ...value,
        state: 'stopped',
        message: 'The app closed during this step. Retry it or continue with the other checks.',
      }
    : value;

export default function WindowsCheck() {
  const [token, setToken] = useState('');
  const [environment, setEnvironment] = useState<Record<string, unknown>>({});
  const [hydrated, setHydrated] = useState(false);
  const [restored, setRestored] = useState(false);
  const [storageMessage, setStorageMessage] = useState('');
  const [exportMessage, setExportMessage] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [setup, setSetup] = useState<SetupProgress>({
    phase: 'idle',
    message: 'The local models are included. Prepare them before recording.',
  });
  const [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [consent, setConsent] = useState(false);
  const [results, setResults] = useState<Record<AudioCheck, Result>>({
    mic: empty(),
    system: empty(),
    conversation: empty(),
    call: empty(),
  });
  const [shortcut, setShortcut] = useState<Shortcut>({
    state: 'not-run',
    received: 0,
    outsideApp: false,
    message: 'Waiting for the shortcut.',
  });
  const [answer, setAnswer] = useState<Answer>(emptyAnswer);
  const [restart, setRestart] = useState<Restart>({ state: 'not-run', message: 'Not tested' });
  const [chatgpt, setChatgpt] = useState<ChatGPTStatus>();
  const [authBusy, setAuthBusy] = useState(false),
    [authMessage, setAuthMessage] = useState('');
  const [model, setModel] = useState('');
  const [answerBilling, setAnswerBilling] = useState<Settings['answerBilling']>('chatgpt');
  const [testApiKey, setTestApiKey] = useState('');
  const [apiReady, setApiReady] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState('');
  const answerModel = answerBilling === 'api' ? 'gpt-6-luna' : model;
  const answerConnected = answerBilling === 'api' ? apiReady : !!chatgpt?.connected;
  async function configureTestKey(remove = false) {
    setKeyBusy(true);
    setKeyMessage('');
    try {
      await request('/api/key', { apiKey: remove ? '' : testApiKey.trim(), remember: false });
      setTestApiKey('');
      setApiReady(!remove);
      setKeyMessage(
        remove
          ? 'Test key removed.'
          : 'Test key set for this app session. Re-enter it after restarting.',
      );
    } catch {
      setKeyMessage('Could not set the test key. Check the key and retry.');
    } finally {
      setKeyBusy(false);
    }
  }
  const [callLimitMs, setCallLimitMs] = useState(90000);
  const [notes, setNotes] = useState(''),
    [headphones, setHeadphones] = useState('speakers');
  const [speakerEnabled, setSpeakerEnabled] = useState(true);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState('');
  const [deviceMessage, setDeviceMessage] = useState('');
  const [level, setLevel] = useState<Record<Source, number>>({ mic: 0, system: 0 });
  const [cue, setCue] = useState('');
  const [armed, setArmed] = useState(false);
  const checkpoint = useRef<Checkpoint | undefined>(undefined);
  const capture = useRef<CaptureHandle | undefined>(undefined),
    audio = useRef<HTMLAudioElement | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    cueTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const mounted = useRef(true),
    cancelled = useRef(false),
    finishing = useRef(false),
    active = useRef<AudioCheck | undefined>(undefined);
  const report = useRef(results),
    reconcile = useRef(new TranscriptReconciler()),
    speakerIds = useRef(new Set<string>());
  const started = useRef(0),
    firstSound = useRef<number | undefined>(undefined);
  const answerAbort = useRef<AbortController | undefined>(undefined);
  const triggerAnswer = useRef<(() => void) | undefined>(undefined);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef({ busy, armed });
  latest.current = { busy, armed };
  function commit(check: AudioCheck, result: Result) {
    report.current = { ...report.current, [check]: result };
    if (mounted.current) setResults({ ...report.current });
  }
  function saved(): SavedState {
    return {
      schemaVersion: 2,
      savedAt: new Date().toISOString(),
      checks: { ...report.current, shortcut, chatgpt: answer, restart },
      preferences: { output: headphones, model },
      notes,
      ...(checkpoint.current ? { restartCheckpoint: checkpoint.current } : {}),
    };
  }
  const savedRef = useRef(saved);
  savedRef.current = saved;
  async function persist(value: SavedState) {
    const bridge = window.callsideDesktop;
    if (!bridge?.saveTestState)
      throw new Error(
        'Test progress cannot be saved in this build. Download the report before closing.',
      );
    saveChain.current = saveChain.current
      .catch(() => undefined)
      .then(() => bridge.saveTestState!(value as unknown as Record<string, unknown>));
    await saveChain.current;
  }
  async function request(path: string, body?: object, currentToken = token): Promise<any> {
    const response = await fetch(path, {
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { 'Content-Type': 'application/json', 'X-Callside-Token': currentToken },
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  useEffect(() => {
    // StrictMode can start a second setup before the first async bootstrap resolves.
    // A shared mounted ref cannot identify which setup owns a restart checkpoint.
    let disposed = false;
    mounted.current = true;
    void (async () => {
      try {
        const [bootstrap, diagnostics, loaded] = await Promise.all([
          request('/api/bootstrap') as Promise<Bootstrap>,
          window.callsideDesktop
            ?.getTestDiagnostics?.()
            .catch(() => ({ diagnostics: 'unavailable' }) as Record<string, unknown>) ??
            ({} as Record<string, unknown>),
          window.callsideDesktop?.loadTestState?.().catch(() => {
            if (!disposed)
              setStorageMessage(
                'Saved test progress could not be read. You can continue and download a new report.',
              );
            return null;
          }),
        ]);
        if (disposed) return;
        setToken(bootstrap.token);
        setChatgpt(bootstrap.chatgpt);
        setEnvironment(diagnostics);
        const state = loaded as unknown as SavedState | null;
        if (state?.schemaVersion === 2 && state.checks && state.preferences) {
          setRestored(true);
          const restored = Object.fromEntries(
            (['mic', 'system', 'conversation', 'call'] as const).map((key) => [
              key,
              restoreState({ ...empty(), ...state.checks[key] }),
            ]),
          ) as Record<AudioCheck, Result>;
          report.current = restored;
          setResults(restored);
          setShortcut(
            restoreState(
              state.checks.shortcut || {
                state: 'not-run',
                received: 0,
                outsideApp: false,
                message: 'Not tested',
              },
            ),
          );
          setAnswer(restoreState({ ...emptyAnswer(), ...state.checks.chatgpt }));
          setRestart(
            restoreState(state.checks.restart || { state: 'not-run', message: 'Not tested' }),
          );
          setNotes(state.notes || '');
          setHeadphones(state.preferences.output || 'speakers');
          setModel(state.preferences.model || '');
          checkpoint.current = state.restartCheckpoint;
          if (
            checkpoint.current &&
            diagnostics.sessionId &&
            checkpoint.current.sessionId !== diagnostics.sessionId
          ) {
            const check = checkpoint.current;
            try {
              const template = await window.callsideDesktop!.loadTemplate();
              if (disposed) return;
              const settingsMatch =
                !!template &&
                Object.entries(check.expected).every(
                  ([key, value]) => template[key as keyof Settings] === value,
                ) &&
                template.context === check.nonce;
              const chatgptPersisted =
                !check.chatgptWasConnected || bootstrap.chatgpt?.connected === true;
              const secureStoragePersisted = diagnostics.secureStorageRestart === true;
              if (check.previousTemplate)
                await window.callsideDesktop!.saveTemplate(check.previousTemplate);
              else await window.callsideDesktop!.removeTemplate();
              if (disposed) return;
              checkpoint.current = undefined;
              setRestart({
                state:
                  settingsMatch && chatgptPersisted && secureStoragePersisted ? 'pass' : 'fail',
                settingsMatch,
                chatgptPersisted: check.chatgptWasConnected ? chatgptPersisted : undefined,
                secureStoragePersisted,
                message:
                  settingsMatch && chatgptPersisted && secureStoragePersisted
                    ? 'The app restarted. Saved settings and encrypted storage survived. Previous settings were restored.'
                    : 'The app restarted, but a persistence check failed. Details are in the report; previous settings were restored.',
              });
            } catch (error) {
              if (disposed) return;
              setRestart({
                state: 'fail',
                message: `Restart check failed: ${safeMessage(error)} Your previous settings remain backed up in this test session.`,
              });
            }
          }
        }
      } catch (error) {
        if (disposed) return;
        setSetup({
          phase: 'error',
          message: `Could not load the test: ${safeMessage(error)} Close and reopen the app.`,
        });
      } finally {
        if (!disposed) setHydrated(true);
      }
    })();
    const remove = window.callsideDesktop?.onAnswer(() => {
      if (disposed) return;
      const outside = !document.hasFocus();
      setShortcut((old) => ({
        state: outside || old.outsideApp ? 'pass' : 'review',
        received: old.received + 1,
        outsideApp: old.outsideApp || outside,
        message:
          outside || old.outsideApp
            ? 'Global shortcut received while another window was active.'
            : 'Shortcut received inside Callside. Try once with another window active.',
      }));
      if (latest.current.armed && !latest.current.busy) triggerAnswer.current?.();
    });
    return () => {
      disposed = true;
      mounted.current = false;
      cancelled.current = true;
      clearTimeout(timer.current);
      clearInterval(cueTimer.current);
      audio.current?.pause();
      answerAbort.current?.abort();
      void capture.current?.stop();
      remove?.();
    };
  }, []);
  useEffect(() => {
    void window.callsideDesktop?.setSessionActive?.(busy);
  }, [busy]);
  useEffect(() => {
    if (!hydrated) return;
    const id = setTimeout(
      () =>
        void persist(savedRef.current())
          .then(() => setStorageMessage(''))
          .catch((error) => setStorageMessage(safeMessage(error))),
      350,
    );
    return () => clearTimeout(id);
  }, [hydrated, results, shortcut, answer, restart, notes, headphones, model]);
  useEffect(() => {
    if (!chatgpt?.pending || !token) return;
    let stopped = false;
    const id = setInterval(
      () =>
        void request('/api/chatgpt')
          .then((status: ChatGPTStatus) => {
            if (!stopped) setChatgpt(status);
          })
          .catch((error) => {
            if (!stopped) setAuthMessage(safeMessage(error));
          }),
      1500,
    );
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [chatgpt?.pending, token]);
  useEffect(() => {
    if (answerBilling === 'chatgpt' && chatgpt?.connected && !chatgpt.pending)
      void authAction('models');
  }, [chatgpt?.connected, chatgpt?.pending, answerBilling]);
  useEffect(() => {
    if (answerBilling !== 'chatgpt' || !chatgpt?.error) return;
    const message = safeMessage(chatgpt.error);
    setAnswer((old) => ({
      ...old,
      state: 'fail',
      message,
      errors: old.errors.includes(message) ? old.errors : [...old.errors, message].slice(-10),
    }));
  }, [chatgpt?.error, answerBilling]);
  async function authAction(action: 'connect' | 'cancel' | 'models' | 'welcome' | 'disconnect') {
    setAuthBusy(true);
    setAuthMessage('');
    try {
      const status = await request(`/api/chatgpt/${action}`, {});
      if (!mounted.current) return;
      setChatgpt(status);
      if (action === 'models') {
        const available = (status.models as ChatGPTStatus['models']).filter((entry) =>
          (ANSWER_MODELS as readonly string[]).includes(entry.id),
        );
        setModel((old) =>
          available.some((entry) => entry.id === old) ? old : available[0]?.id || '',
        );
        setAnswer((old) => ({
          ...old,
          connected: !!status.connected,
          models: available.map((entry) => entry.id),
          message: available.length
            ? old.message
            : 'No supported answer model is available for this account. Save the report or skip this step.',
        }));
      }
    } catch (error) {
      setAuthMessage(safeMessage(error));
      setAnswer((old) => ({
        ...old,
        state: 'fail',
        message: safeMessage(error),
        errors: [...old.errors, safeMessage(error)].slice(-10),
      }));
    } finally {
      if (mounted.current) setAuthBusy(false);
    }
  }
  async function prepare() {
    setBusy(true);
    setSetup({ phase: 'loading', message: 'Loading the included local model…' });
    try {
      await prepareLocal(token, setSetup);
      setReady(true);
    } catch (error) {
      setSetup({ phase: 'error', message: safeMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  async function loadMicrophones() {
    setBusy(true);
    setDeviceMessage('');
    try {
      // Enumeration still permits selection when the OS default input cannot be opened.
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === 'audioinput');
      setMicrophones(inputs);
      setDeviceMessage(
        inputs.length
          ? 'Choose your microphone below. If names are hidden, run the microphone test to grant access, then refresh this list.'
          : 'No microphone is visible. Connect it and enable Windows Settings → Privacy & security → Microphone → Microphone access and Let desktop apps access your microphone, then restart Callside.',
      );
    } catch (error) {
      setDeviceMessage(safeMessage(error));
    } finally {
      setBusy(false);
    }
  }
  function updateTranscript(check: AudioCheck) {
    const view = reconcile.current.view(true);
    const current = report.current[check];
    commit(check, {
      ...current,
      entries: view.entries.slice(-100),
      text: view.entries
        .map((entry) => entry.text)
        .join(' ')
        .slice(0, 12000),
      echoCount: view.echoCount,
    });
  }
  async function finish(stopped = false) {
    if (finishing.current) return;
    if (stopped) cancelled.current = true;
    if (!capture.current) {
      if (active.current)
        commit(active.current, {
          ...report.current[active.current],
          message: 'Waiting for audio startup to stop…',
        });
      return;
    }
    finishing.current = true;
    clearTimeout(timer.current);
    clearInterval(cueTimer.current);
    audio.current?.pause();
    setCue('');
    const check = active.current;
    if (check)
      commit(check, {
        ...report.current[check],
        message: 'Finishing transcription and speaker labels…',
      });
    try {
      await capture.current.stop();
    } catch (error) {
      if (check)
        commit(check, {
          ...report.current[check],
          state: 'fail',
          errors: [...report.current[check].errors, safeMessage(error)],
          message: safeMessage(error),
        });
    }
    capture.current = undefined;
    if (check) {
      updateTranscript(check);
      const current = report.current[check];
      commit(check, {
        ...current,
        durationMs: Math.round(performance.now() - started.current),
        state: current.errors.length
          ? 'fail'
          : stopped
            ? 'stopped'
            : current.text
              ? 'review'
              : 'fail',
        message: current.errors.length
          ? 'A problem occurred. Review the text and error details below.'
          : stopped
            ? 'Test stopped. Retry or continue with the other checks.'
            : current.text
              ? 'Review the transcript below.'
              : 'No transcript received. Retry or continue; the failure is saved.',
      });
    }
    active.current = undefined;
    setBusy(false);
    setLevel({ mic: 0, system: 0 });
    finishing.current = false;
  }
  async function run(check: AudioCheck) {
    if (busy || !ready || !consent) return;
    setBusy(true);
    cancelled.current = false;
    active.current = check;
    reconcile.current.clear();
    speakerIds.current.clear();
    firstSound.current = undefined;
    started.current = performance.now();
    const combined = check === 'conversation' || check === 'call';
    commit(check, {
      ...empty(),
      state: 'running',
      message: 'Connecting audio…',
      attributionMessage:
        combined && speakerEnabled
          ? 'Local speaker labels pending'
          : 'Speaker labeling not enabled for this step',
    });
    try {
      const handle = await startCapture(
        {
          ...DEFAULT_SETTINGS,
          language: combined ? '' : 'en',
          transcriptionProvider: 'local',
          diarizationProvider: combined && speakerEnabled ? 'local' : 'off',
          backgroundSpeakers: combined && speakerEnabled,
          captureMic: check !== 'system',
          captureSystem: check !== 'mic',
          captureMode: 'realtime',
          micDeviceId,
        },
        token,
        {
          onLocalMeasurement(source, measurement, empty) {
            const current = report.current[check];
            commit(check, {
              ...current,
              localInference: [
                ...(current.localInference ?? []),
                { ...measurement, source, empty },
              ].slice(-100),
            });
          },
          onTranscript(entry) {
            reconcile.current.accept(entry);
            const current = report.current[check];
            if (
              entry.text.trim() &&
              firstSound.current !== undefined &&
              current.firstTextMs === undefined
            )
              commit(check, {
                ...current,
                firstTextMs: Math.round(performance.now() - firstSound.current),
              });
            updateTranscript(check);
          },
          onAttribution(value) {
            reconcile.current.attribute(value);
            for (const segment of value.segments) speakerIds.current.add(segment.speakerId);
            const current = report.current[check];
            commit(check, {
              ...current,
              attributionEvents: current.attributionEvents + 1,
              speakerCount: speakerIds.current.size,
              attributionDelayMs:
                current.attributionDelayMs ??
                (value.segments.length
                  ? Math.max(0, Date.now() - value.segments[0].timestamp)
                  : undefined),
            });
            updateTranscript(check);
          },
          onAttributionStatus(message) {
            const error = /fail|cannot|unavailable|error|unsupported|not supported/i.test(message);
            commit(check, {
              ...report.current[check],
              attributionMessage: safeMessage(message),
              ...(error
                ? { errors: [...report.current[check].errors, safeMessage(message)].slice(-10) }
                : {}),
            });
          },
          onLevel(source, value) {
            if (value > 0.01 && firstSound.current === undefined)
              firstSound.current = performance.now();
            report.current[check].peak = Math.max(report.current[check].peak, value);
            report.current[check].peaks[source] = Math.max(
              report.current[check].peaks[source],
              value,
            );
            if (mounted.current) setLevel((old) => ({ ...old, [source]: value }));
          },
          onStatus(_, message) {
            if (report.current[check].state !== 'fail' && !finishing.current)
              commit(check, { ...report.current[check], message: safeMessage(message) });
          },
          onError(message) {
            commit(check, {
              ...report.current[check],
              state: 'fail',
              message: safeMessage(message),
              errors: [...report.current[check].errors, safeMessage(message)].slice(-10),
            });
          },
          onEnded() {
            if (!finishing.current && capture.current) void finish();
          },
        },
      );
      capture.current = handle;
      if (!mounted.current) {
        await handle.stop();
        capture.current = undefined;
        return;
      }
      if (cancelled.current) {
        await finish(true);
        return;
      }
      if (check === 'system' || check === 'conversation') {
        const player = new Audio(
          check === 'system' ? '/windows-system-test.wav' : '/windows-speakers-test.wav',
        );
        audio.current = player;
        player.onended = () => {
          clearTimeout(timer.current);
          clearInterval(cueTimer.current);
          setCue(
            check === 'conversation'
              ? 'Your turn: I heard the speakers. Please summarize the conversation briefly.'
              : 'Finishing…',
          );
          timer.current = setTimeout(() => void finish(), check === 'conversation' ? 8500 : 1600);
        };
        player.onerror = () => {
          commit(check, {
            ...report.current[check],
            state: 'fail',
            errors: ['The bundled test audio could not play.'],
            message: 'The bundled test audio could not play.',
          });
          void finish();
        };
        await player.play();
        if (check === 'conversation') {
          const updateCue = () => {
            setCue('Listen to the recorded meeting. Stay silent until your turn.');
          };
          updateCue();
          cueTimer.current = setInterval(updateCue, 200);
        }
        timer.current = setTimeout(() => void finish(), check === 'system' ? 20000 : 80000);
      } else timer.current = setTimeout(() => void finish(), check === 'mic' ? 11000 : callLimitMs);
    } catch (error) {
      commit(check, {
        ...report.current[check],
        state: 'fail',
        message: safeMessage(error),
        errors: [...report.current[check].errors, safeMessage(error)].slice(-10),
      });
      await capture.current?.stop().catch(() => undefined);
      capture.current = undefined;
      active.current = undefined;
      setBusy(false);
    }
  }
  function judge(check: AudioCheck, field: Judgment, value: boolean) {
    const current = report.current[check],
      judgments = { ...current.judgments, [field]: value };
    const required: Judgment[] =
      check === 'conversation' || check === 'call'
        ? ['transcript', 'echo', 'speakers']
        : ['transcript'];
    const failed = current.errors.length > 0 || required.some((key) => judgments[key] === false);
    const passed = required.every((key) => judgments[key] === true);
    commit(check, {
      ...current,
      judgments,
      matches: judgments.transcript,
      state: failed ? 'fail' : passed ? 'pass' : 'review',
      message: failed
        ? 'A problem was recorded. You can continue.'
        : passed
          ? 'Check confirmed.'
          : 'Complete the remaining review questions.',
    });
  }
  const answerTranscript = results.call.entries.length
    ? results.call.entries
    : results.conversation.entries.length
      ? results.conversation.entries
      : results.system.entries.length
        ? results.system.entries
        : results.mic.entries;
  async function runAnswer() {
    if (busy || answerAbort.current || !answerConnected || !answerModel || !answerTranscript.length)
      return;
    setArmed(false);
    setBusy(true);
    const controller = new AbortController();
    answerAbort.current = controller;
    const before = performance.now();
    let text = '',
      firstTextMs: number | undefined,
      completed = false;
    setAnswer((old) => ({
      ...old,
      state: 'running',
      connected: answerBilling === 'chatgpt',
      billing: answerBilling,
      model: answerModel,
      text: '',
      message:
        answerBilling === 'api'
          ? 'Requesting one answer using the test API key…'
          : 'Requesting one answer through your ChatGPT subscription…',
      errors: [],
      firstTextMs: undefined,
      durationMs: undefined,
      requestCount: old.requestCount + 1,
    }));
    const timeout = setTimeout(() => controller.abort(), 70000);
    try {
      for await (const event of streamAnswer(
        {
          settings: {
            ...DEFAULT_SETTINGS,
            answerBilling,
            model: answerModel as Settings['model'],
            reasoningEffort: reasoningOptions(answerModel)[0],
            fastMode: false,
            maxOutputTokens: answerBilling === 'api' ? 256 : null,
            context:
              'This is a desktop call-assistant test. The transcript comes from a desktop audio test and a licensed meeting recording. Reply in English with one short, useful sentence.',
            systemPrompt:
              'Suggest the next useful sentence the microphone speaker could say, based on the transcript. Give only the suggested sentence, without a preamble.',
          },
          transcript: answerTranscript,
          question: '',
          mode: 'manual',
          previousSuggestions: [],
        },
        token,
        controller.signal,
      )) {
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'skip') throw new Error('The model returned no suggestion.');
        if (event.type === 'delta') {
          text += event.text;
          firstTextMs ??= Math.round(performance.now() - before);
          setAnswer((old) => ({ ...old, text, firstTextMs }));
        }
        if (event.type === 'done') completed = true;
      }
      if (!completed || !text.trim())
        throw new Error('The answer did not finish. Retry or save the report.');
      setAnswer((old) => ({
        ...old,
        state: 'review',
        text,
        firstTextMs,
        durationMs: Math.round(performance.now() - before),
        message: 'Did the suggestion fit the conversation, and appear quickly enough?',
      }));
    } catch (error) {
      const message = controller.signal.aborted
        ? 'Answer stopped or timed out. No API fallback was used.'
        : safeMessage(error);
      setAnswer((old) => ({
        ...old,
        state: 'fail',
        text,
        message,
        errors: [message],
        durationMs: Math.round(performance.now() - before),
      }));
    } finally {
      clearTimeout(timeout);
      answerAbort.current = undefined;
      setBusy(false);
    }
  }
  triggerAnswer.current = () => void runAnswer();
  async function restartApp() {
    const bridge = window.callsideDesktop;
    if (!bridge?.relaunchTest || !bridge.saveTestState || !environment.sessionId) {
      setRestart({
        state: 'fail',
        message: 'This build cannot run the restart check. Save the report.',
      });
      return;
    }
    setBusy(true);
    setRestart({ state: 'running', message: 'Saving progress and restarting…' });
    let backup: Settings | null | undefined;
    try {
      backup = checkpoint.current
        ? checkpoint.current.previousTemplate
        : await bridge.loadTemplate();
      const expected: Checkpoint['expected'] = {
        language: 'de',
        captureMic: true,
        captureSystem: true,
        answerBilling: 'chatgpt',
        model: (model || DEFAULT_SETTINGS.model) as Settings['model'],
      };
      checkpoint.current = {
        sessionId: String(environment.sessionId),
        nonce: `Callside Windows test ${crypto.randomUUID()}`,
        expected,
        chatgptWasConnected: !!chatgpt?.connected,
        previousTemplate: backup,
      };
      await persist({
        ...savedRef.current(),
        checks: {
          ...savedRef.current().checks,
          restart: { state: 'running', message: 'Awaiting app restart.' },
        },
      });
      await bridge.saveTemplate({
        ...DEFAULT_SETTINGS,
        ...expected,
        context: checkpoint.current.nonce,
      });
      await bridge.setSessionActive(false);
      await bridge.relaunchTest();
    } catch (error) {
      let message = safeMessage(error);
      if (backup !== undefined) {
        try {
          if (backup) await bridge.saveTemplate(backup);
          else await bridge.removeTemplate();
          checkpoint.current = undefined;
        } catch {
          message +=
            ' Previous settings could not be restored; their backup is retained in this test session.';
        }
      }
      setRestart({ state: 'fail', message });
      setBusy(false);
    }
  }
  async function download() {
    if (exportBusy) return;
    setExportMessage('');
    const allowed = [
      'platform',
      'arch',
      'osVersion',
      'machine',
      'cpu',
      'cpuThreads',
      'ramGB',
      'appVersion',
      'electronVersion',
      'preview',
      'buildId',
      'secureStorage',
      'secureStorageRestart',
      'shortcuts',
    ];
    const diagnostic = Object.fromEntries(
      Object.entries(environment).filter(([key]) => allowed.includes(key)),
    );
    const data = {
      schemaVersion: 2,
      test: 'windows-comprehensive-preview',
      exportedAt: new Date().toISOString(),
      environment: diagnostic,
      setup: { phase: setup.phase, message: safeMessage(setup.message) },
      output: headphones,
      checks: { ...report.current, shortcut, chatgpt: answer, restart },
      notes,
      scope:
        'Guided real microphone and loopback capture, simultaneous sources, local Whisper and local speaker labeling, optional real call application, optional ChatGPT subscription or explicit API suggestion (billing field identifies which), global shortcut and persistence across app restart. Skipped, interrupted and not-run steps are not passes. This is a hardware test, not a claim of general Windows support.',
      privacy:
        'Includes test transcript text, your optional notes, results and basic system specifications. No audio, API keys, account identifiers, authentication tokens, device IDs, usernames or saved templates. Reports stay on this computer until you share them.',
    };
    if (window.callsideDesktop?.saveTestReport) {
      setExportBusy(true);
      try {
        const result = await window.callsideDesktop.saveTestReport(data);
        setExportMessage(
          result.saved
            ? 'Report saved. Send the JSON file back.'
            : 'Save cancelled. Your results are still here.',
        );
      } catch (error) {
        setExportMessage(
          `Could not save the report: ${safeMessage(error)} Try again; your results are still here.`,
        );
      } finally {
        setExportBusy(false);
      }
      return;
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `callside-windows-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setExportMessage('Report download started. Send the JSON file back.');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function skip(check: AudioCheck) {
    commit(check, {
      ...report.current[check],
      state: 'skipped',
      message: 'Skipped by the tester. This feature is not verified.',
    });
  }
  function transcript(check: AudioCheck) {
    const result = results[check],
      combined = check === 'conversation' || check === 'call';
    return (
      <>
        <p role="status">
          <span className={`check-state check-state-${result.state}`}>
            {statuses[result.state]}
          </span>{' '}
          {result.message}
        </p>
        {active.current === check && (
          <div className="check-recording">
            <p>
              {cue ||
                (check === 'mic'
                  ? 'Recording microphone — read the test sentence now.'
                  : 'Recording computer audio and microphone as selected.')}
            </p>
            {(['mic', 'system'] as const)
              .filter((source) => combined || source === check)
              .map((source) => (
                <label key={source}>
                  {labels[source]} level
                  <meter
                    aria-label={`${labels[source]} level`}
                    min={0}
                    max={0.3}
                    value={level[source]}
                  />
                </label>
              ))}
            <button
              className="stop-button"
              disabled={finishing.current}
              onClick={() => void finish(check === 'call' ? false : true)}
            >
              {finishing.current
                ? 'Finishing…'
                : check === 'call'
                  ? 'Finish call test'
                  : 'Stop test'}
            </button>
          </div>
        )}
        {!!result.errors.length && (
          <ul className="check-errors">
            {result.errors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        )}
        {result.text && (
          <div className="check-transcript" data-testid={`check-transcript-${check}`}>
            {combined
              ? result.entries.map((entry) => (
                  <p key={entry.id}>
                    <strong>
                      {entry.speaker}
                      {entry.source === 'system' && !entry.attribution
                        ? result.state === 'running'
                          ? ' · labels pending'
                          : ' · unassigned'
                        : ''}
                    </strong>
                    <span>{entry.text}</span>
                  </p>
                ))
              : result.text}
          </div>
        )}
        {combined && result.state !== 'not-run' && (
          <p className="field-help">
            {result.attributionMessage}. {result.speakerCount} computer voices detected;{' '}
            {result.echoCount} matching microphone duplicates filtered. Labels are anonymous and may
            arrive after the text.
          </p>
        )}
        {result.firstTextMs !== undefined && (
          <p className="field-help">
            First text: {(result.firstTextMs / 1000).toFixed(1)} s after the first audio signal.
            Approximate; this includes speaking time.
          </p>
        )}
        {result.text && result.state !== 'running' && (
          <div className="check-review">
            <p>Is the transcript substantially correct?</p>
            <div className="check-actions">
              <button
                className="secondary-button"
                disabled={busy}
                aria-pressed={result.judgments.transcript === true}
                onClick={() => judge(check, 'transcript', true)}
              >
                Text is correct
              </button>
              <button
                className="quiet-button"
                disabled={busy}
                aria-pressed={result.judgments.transcript === false}
                onClick={() => judge(check, 'transcript', false)}
              >
                Text is incorrect
              </button>
            </div>
            {combined && (
              <>
                <p>Is your own speech present, without computer speech appearing twice as you?</p>
                <div className="check-actions">
                  <button
                    className="secondary-button"
                    disabled={busy}
                    aria-pressed={result.judgments.echo === true}
                    onClick={() => judge(check, 'echo', true)}
                  >
                    Sources are correct
                  </button>
                  <button
                    className="quiet-button"
                    disabled={busy}
                    aria-pressed={result.judgments.echo === false}
                    onClick={() => judge(check, 'echo', false)}
                  >
                    Missing or duplicated speech
                  </button>
                </div>
                <p>
                  {check === 'conversation'
                    ? 'The meeting has four voices. Do the three longer voices have different labels, and does the first voice keep its label when it returns? Brief overlaps may remain uncertain.'
                    : 'Do computer participants keep separate, consistent speaker labels?'}
                </p>
                <div className="check-actions">
                  <button
                    className="secondary-button"
                    disabled={busy || result.speakerCount < (check === 'conversation' ? 3 : 1)}
                    aria-pressed={result.judgments.speakers === true}
                    onClick={() => judge(check, 'speakers', true)}
                  >
                    Speaker labels are correct
                  </button>
                  <button
                    className="quiet-button"
                    disabled={busy}
                    aria-pressed={result.judgments.speakers === false}
                    onClick={() => judge(check, 'speakers', false)}
                  >
                    Speaker labels need review
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </>
    );
  }
  const availableModels =
    chatgpt?.models.filter((entry) => (ANSWER_MODELS as readonly string[]).includes(entry.id)) ||
    [];
  const summary = [
    ...Object.entries(results).map(([key, result]) => ({
      label: labels[key as AudioCheck],
      state: result.state,
    })),
    { label: 'Global shortcut', state: shortcut.state },
    { label: 'Answer', state: answer.state },
    { label: 'Restart and settings', state: restart.state },
  ];
  return (
    <main className="windows-check">
      <header>
        <span className="check-brand">Callside</span>
        <h1>Windows guided test</h1>
        <p>
          One session, about 10–15 minutes after model loading. Complete the steps below, then send
          one report back. A failed step does not prevent the remaining checks.
        </p>
        <p className="field-help">
          Audio and speaker analysis run locally. Only the optional answer request sends the
          displayed test transcript to your own account. Use the test sentences, not private
          conversations.
        </p>
      </header>
      {!hydrated && <p role="status">Loading test progress…</p>}
      {restored && (
        <p role="status">
          Previous test progress restored.{' '}
          <a href="#report-title">Review results and download the report</a>, or continue any
          unfinished step.
        </p>
      )}
      {storageMessage && (
        <p className="check-errors" role="alert">
          {storageMessage}
        </p>
      )}
      <section aria-labelledby="prepare-title">
        <h2 id="prepare-title">1. Prepare</h2>
        <p role="status">{setup.message}</p>
        {['loading', 'downloading'].includes(setup.phase) && (
          <progress aria-label="Model setup" max={100} value={setup.percent} />
        )}
        <button
          className="primary-button"
          disabled={busy || ready || !token}
          onClick={() => void prepare()}
        >
          {ready ? 'Model ready' : setup.phase === 'error' ? 'Retry preparation' : 'Prepare test'}
        </button>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy}
            onChange={(event) => setConsent(event.target.checked)}
          />
          I am ready to capture my microphone and computer audio for this test.
        </label>
        <label>
          Audio output
          <select
            value={headphones}
            disabled={busy}
            onChange={(event) => setHeadphones(event.target.value)}
          >
            <option value="speakers">Speakers</option>
            <option value="headphones">Headphones</option>
          </select>
        </label>
        <label>
          Microphone input
          <select
            value={micDeviceId}
            disabled={busy}
            onChange={(event) => setMicDeviceId(event.target.value)}
          >
            <option value="">System default</option>
            {microphones
              .filter((device) => device.deviceId && device.deviceId !== 'default')
              .map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
          </select>
        </label>
        <button className="secondary-button" disabled={busy} onClick={() => void loadMicrophones()}>
          Refresh microphone list
        </button>
        {deviceMessage && <p role="status">{deviceMessage}</p>}
        <p className="field-help">
          If the default input fails, select your headset or built-in microphone here. This
          selection applies to all microphone checks in this session. Check Windows microphone
          access for desktop apps if no input is available.
        </p>
        <p className="field-help">
          Use your normal speakers at a comfortable volume. Pause unrelated audio. Each recording
          stops automatically and can also be stopped manually.
        </p>
      </section>
      <section aria-labelledby="audio-title">
        <h2 id="audio-title">2. Check each audio source</h2>
        {(['mic', 'system'] as const).map((source) => (
          <div className="audio-check" key={source}>
            <h3>{labels[source]}</h3>
            <p>
              {source === 'mic'
                ? 'Click the button, allow microphone access, and read this sentence aloud:'
                : 'The app plays this sentence and captures computer audio. Stay silent:'}
            </p>
            <blockquote>{phrases[source]}</blockquote>
            <div className="check-actions">
              <button
                className="secondary-button"
                disabled={busy || !ready || !consent}
                onClick={() => void run(source)}
              >
                {source === 'mic' ? 'Test microphone' : 'Test computer audio'}
              </button>
              <button className="text-button" disabled={busy} onClick={() => skip(source)}>
                Skip {source === 'mic' ? 'microphone' : 'computer audio'}
              </button>
            </div>
            {transcript(source)}
          </div>
        ))}
      </section>
      <section aria-labelledby="conversation-title">
        <h2 id="conversation-title">3. Conversation and speaker labels</h2>
        <p>
          A 50-second meeting excerpt with four speakers plays through the computer. Both audio
          sources are captured together. Stay silent during playback, then read the reply shown
          below when prompted.
        </p>
        <p>
          Your reply after playback:{' '}
          <strong>I heard the speakers. Please summarize the conversation briefly.</strong>
        </p>
        <details className="check-reference">
          <summary>Reference voices and recording credit</summary>
          <ul>
            <li>0–5 s: the first voice asks about euros and pounds.</li>
            <li>18–22 s: another voice asks about taking notes.</li>
            <li>24–38 s: a third voice discusses prices around twenty pounds.</li>
            <li>43–48 s: the first voice returns with a production cost of twelve fifty.</li>
            <li>48–50 s: a fourth voice briefly comments on the margin.</li>
          </ul>
          <p className="field-help">
            AMI Meeting Corpus, AMI Project.{' '}
            <a href="https://groups.inf.ed.ac.uk/ami/download/">Source</a> ·{' '}
            <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Cropped and
            resampled for this functional test. Anonymous labels need not match the reference
            numbers.
          </p>
        </details>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={speakerEnabled}
            disabled={busy}
            onChange={(event) => setSpeakerEnabled(event.target.checked)}
          />
          Include local speaker labeling
        </label>
        <p className="field-help">
          Leave this on for the full test. If speaker loading fails, you may turn it off and retry
          audio; the report will show that speaker labeling remains unverified.
        </p>
        <div className="check-actions">
          <button
            className="secondary-button"
            disabled={busy || !ready || !consent}
            onClick={() => void run('conversation')}
          >
            Test conversation
          </button>
          <button className="text-button" disabled={busy} onClick={() => skip('conversation')}>
            Skip conversation test
          </button>
        </div>
        {transcript('conversation')}
      </section>
      <section aria-labelledby="call-title">
        <h2 id="call-title">4. Your call application</h2>
        <p>
          For a full check, open a short test call in WhatsApp, Teams, Zoom, or your usual app. Tell
          the other person this is a transcription test. Take turns saying a few non-private
          sentences, then click Finish call test. Capture stops at the selected time limit.
        </p>
        <p className="field-help">
          This tests audio from a real call app. The recorded conversation above cannot verify its
          device routing. Skip if nobody is available; the report will state that this was not
          tested.
        </p>
        <label>
          Call test time limit
          <select
            value={callLimitMs}
            disabled={busy}
            onChange={(event) => setCallLimitMs(Number(event.target.value))}
          >
            <option value={90000}>90 seconds — quick check</option>
            <option value={1800000}>30 minutes — sustained capture</option>
          </select>
        </label>
        <div className="check-actions">
          <button
            className="secondary-button"
            disabled={busy || !ready || !consent}
            onClick={() => void run('call')}
          >
            Test a real call
          </button>
          <button className="text-button" disabled={busy} onClick={() => skip('call')}>
            Skip real call
          </button>
        </div>
        {transcript('call')}
      </section>
      <section aria-labelledby="shortcut-title">
        <h2 id="shortcut-title">5. Global shortcut and answer</h2>
        <p>
          Open another window, such as Notepad. While that window is active, press <kbd>F8</kbd> or{' '}
          <kbd>Ctrl + Shift + Space</kbd>, then return here.
        </p>
        <p role="status">
          <span className={`check-state check-state-${shortcut.state}`}>
            {statuses[shortcut.state]}
          </span>{' '}
          {shortcut.message}
        </p>
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            setShortcut((old) => ({ ...old, state: 'skipped', message: 'Skipped by the tester.' }))
          }
        >
          Skip shortcut
        </button>
        <label>
          Answer connection
          <select
            value={answerBilling}
            disabled={busy || keyBusy || authBusy}
            onChange={(event) => {
              setAnswerBilling(event.target.value as Settings['answerBilling']);
              setArmed(false);
              setAnswer(emptyAnswer());
            }}
          >
            <option value="chatgpt">ChatGPT subscription</option>
            <option value="api">Provided API test key</option>
          </select>
        </label>
        {answerBilling === 'api' && (
          <>
            <h3 className="check-subheading">Answer using the provided test key</h3>
            <p>
              Uses GPT-6 Luna with reasoning off and up to 256 output tokens. Only this answer
              request uses API credits. Audio transcription and speaker labels stay local. This does
              not verify ChatGPT subscription sign-in.
            </p>
            <label>
              Test API key
              <input
                type="password"
                autoComplete="off"
                value={testApiKey}
                disabled={busy || keyBusy}
                onChange={(event) => setTestApiKey(event.target.value)}
              />
            </label>
            <div className="check-actions">
              <button
                className="secondary-button"
                disabled={busy || keyBusy || !token || !testApiKey.trim()}
                onClick={() => void configureTestKey()}
              >
                Use test key for this session
              </button>
              <button
                className="text-button"
                disabled={busy || keyBusy || !apiReady}
                onClick={() => void configureTestKey(true)}
              >
                Remove test key
              </button>
            </div>
            <p role="status">{keyMessage}</p>
            <p className="field-help">
              The key is kept in memory, never included in the report or checkpoint. Re-enter after
              restarting. An expired or exhausted key is a blocker to report; do not buy credits.
            </p>
          </>
        )}
        {answerBilling === 'chatgpt' && (
          <>
            <h3 className="check-subheading">One answer through your subscription</h3>
            <p>
              You need your own ChatGPT account with an eligible subscription. Sign in yourself in
              the browser that opens, then return here. No API key is used. This optional request
              counts toward your subscription limits.
            </p>
            <p role="status">
              {chatgpt?.connected
                ? 'ChatGPT connected.'
                : chatgpt?.pending
                  ? 'Finish signing in in your browser, then return here.'
                  : chatgpt?.available
                    ? 'ChatGPT not connected.'
                    : 'ChatGPT sign-in is unavailable in this build.'}
            </p>
            {chatgpt?.welcomePending && (
              <div className="check-actions">
                <p>
                  This connection uses your ChatGPT subscription and its usage limits. API credits
                  are not used.
                </p>
                <button
                  className="secondary-button"
                  disabled={authBusy || busy}
                  onClick={() => void authAction('welcome')}
                >
                  Got it
                </button>
              </div>
            )}
            <div className="check-actions">
              {chatgpt?.pending ? (
                <button
                  className="secondary-button"
                  disabled={authBusy || busy}
                  onClick={() => void authAction('cancel')}
                >
                  Cancel sign-in
                </button>
              ) : (
                <button
                  className="secondary-button"
                  disabled={authBusy || busy || !chatgpt?.available}
                  onClick={() => void authAction(chatgpt?.connected ? 'models' : 'connect')}
                >
                  {chatgpt?.connected ? 'Refresh models' : 'Connect to ChatGPT'}
                </button>
              )}
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setArmed(false);
                  if (chatgpt?.pending) void authAction('cancel');
                  setAnswer((old) => ({
                    ...old,
                    state: 'skipped',
                    message: 'Skipped by the tester. Subscription answers are not verified.',
                  }));
                }}
              >
                Skip ChatGPT test
              </button>
            </div>
            {(authMessage || chatgpt?.error) && (
              <p role="alert" className="check-errors">
                {authMessage || safeMessage(chatgpt?.error)}
              </p>
            )}
          </>
        )}
        {answerConnected && (
          <>
            {answerBilling === 'chatgpt' && (
              <label>
                Answer model
                <select
                  value={model}
                  disabled={busy || authBusy}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {!availableModels.length && (
                    <option value="">No supported model available</option>
                  )}
                  {availableModels.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="field-help">
              Uses the lowest supported reasoning setting. The request includes only a transcript
              recorded in this test. The selected connection is used with no automatic fallback.
            </p>
            {!answerTranscript.length && (
              <p>Record at least one audio test before requesting an answer.</p>
            )}
            <div className="check-actions">
              <button
                className="secondary-button"
                disabled={
                  busy ||
                  !answerModel ||
                  !answerTranscript.length ||
                  (answerBilling === 'chatgpt' && !!chatgpt?.pending)
                }
                onClick={() => setArmed(true)}
              >
                {armed ? 'Waiting for your shortcut…' : 'Use shortcut for one answer'}
              </button>
              <button
                className="quiet-button"
                disabled={
                  busy ||
                  !answerModel ||
                  !answerTranscript.length ||
                  (answerBilling === 'chatgpt' && !!chatgpt?.pending)
                }
                onClick={() => void runAnswer()}
              >
                Request one test answer
              </button>
              {armed && (
                <button className="text-button" onClick={() => setArmed(false)}>
                  Cancel shortcut request
                </button>
              )}
              {answer.state === 'running' && (
                <button className="stop-button" onClick={() => answerAbort.current?.abort()}>
                  Stop answer
                </button>
              )}
            </div>
            {armed && (
              <p role="status">
                Switch to another window and press F8. The next shortcut sends one request.
              </p>
            )}
          </>
        )}
        <p role="status">
          <span className={`check-state check-state-${answer.state}`}>
            {statuses[answer.state]}
          </span>{' '}
          {answer.message !== statuses[answer.state] ? answer.message : ''}
        </p>
        {answer.text && <div className="check-answer">{answer.text}</div>}
        {answer.firstTextMs !== undefined && (
          <p className="field-help">
            First answer text: {(answer.firstTextMs / 1000).toFixed(1)} s after the request.
          </p>
        )}
        {answer.text && answer.state !== 'running' && (
          <div className="check-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                setAnswer((old) => ({
                  ...old,
                  state: old.errors.length ? 'fail' : 'pass',
                  message: old.errors.length
                    ? 'The answer had an error. Details are saved.'
                    : 'Suggestion and speed confirmed by the tester.',
                }))
              }
            >
              Useful and fast enough
            </button>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() =>
                setAnswer((old) => ({
                  ...old,
                  state: 'fail',
                  message: 'The suggestion or its speed needs review.',
                }))
              }
            >
              Answer or speed needs review
            </button>
          </div>
        )}
      </section>
      <section aria-labelledby="restart-title">
        <h2 id="restart-title">6. Restart and saved settings</h2>
        <p>
          This saves the report so far, writes temporary test settings through the real settings
          system, and restarts Callside. The app checks the saved values, encrypted storage, and
          your ChatGPT connection if you signed in. Your previous settings are restored
          automatically.
        </p>
        <div className="check-actions">
          <button
            className="secondary-button"
            disabled={busy || authBusy || !!chatgpt?.pending || !hydrated}
            onClick={() => void restartApp()}
          >
            Save progress and restart
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              setRestart({
                state: 'skipped',
                message: 'Skipped by the tester. Restart persistence is not verified.',
              })
            }
          >
            Skip restart
          </button>
        </div>
        <p role="status">
          <span className={`check-state check-state-${restart.state}`}>
            {statuses[restart.state]}
          </span>{' '}
          {restart.message !== statuses[restart.state] ? restart.message : ''}
        </p>
      </section>
      <section aria-labelledby="report-title">
        <h2 id="report-title">7. Send one report back</h2>
        <ul className="check-summary">
          {summary.map((item) => (
            <li key={item.label}>
              <span>{item.label}</span>
              <span className={`check-state check-state-${item.state}`}>
                {statuses[item.state]}
              </span>
            </li>
          ))}
        </ul>
        <label>
          Anything else that did not work? (optional)
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={2000}
            rows={3}
          />
        </label>
        <p>
          The JSON report contains the test text, results, your notes, and basic computer
          specifications. It contains no audio, keys, saved templates, or account details. Save it
          even if a check failed or was skipped.
        </p>
        <button className="primary-button" disabled={exportBusy} onClick={() => void download()}>
          {exportBusy ? 'Saving report…' : 'Download test report'}
        </button>
        {exportMessage && <p role="status">{exportMessage}</p>}
        <a
          className="check-app-link"
          href="/"
          onClick={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          Open the full app
        </a>
        <p className="field-help">
          If a step remains untested, the report will say so. No result is uploaded automatically.
        </p>
      </section>
    </main>
  );
}
