export type Source = 'mic' | 'system';
export type CaptureMode = 'realtime' | 'diarized';
export interface TranscriptEntry {
  id: string;
  source: Source;
  speaker: string;
  text: string;
  timestamp: number;
  endTimestamp?: number;
  /** Original live turn ID, shared by any fragments created by attribution. */
  turnId?: string;
  speakerId?: string;
  attribution?: 'reference' | 'chunk';
  final: boolean;
}
export interface SpeakerReference {
  name: string;
  /** Session-only WAV clip. Never included in transcript exports or saved settings. */
  audio: string;
}
export interface SpeakerSegment {
  timestamp: number;
  endTimestamp: number;
  speaker: string;
  speakerId: string;
  attribution: 'reference' | 'chunk';
  text: string;
}
export interface SpeakerAttribution {
  chunkId: string;
  timestamp: number;
  endTimestamp: number;
  receivedAt: number;
  segments: SpeakerSegment[];
}
export interface Settings {
  model: (typeof import('./models.js').ANSWER_MODELS)[number];
  reasoningEffort: import('./models.js').ReasoningEffort;
  fastMode: boolean;
  transcriptionModel: string;
  language: string;
  systemPrompt: string;
  autoPrompt: string;
  context: string;
  maxOutputTokens: number;
  autoCooldownMs: number;
  captureMode: CaptureMode;
  captureMic: boolean;
  captureSystem: boolean;
  filterMicrophoneEcho: boolean;
  backgroundSpeakers: boolean;
  micDeviceId: string;
  systemDeviceId: string;
  micLabel: string;
  systemLabel: string;
  diarizationChunkSeconds: number;
}
export interface AnswerRequest {
  settings: Settings;
  transcript: TranscriptEntry[];
  question: string;
  mode: 'manual' | 'auto';
  previousSuggestions: string[];
  demo?: boolean;
}
export type AnswerEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'skip' }
  | { type: 'error'; message: string };
export interface Suggestion {
  id: string;
  text: string;
  mode: 'manual' | 'auto';
  timestamp: number;
  question: string;
  status: 'streaming' | 'done' | 'error';
}
export interface Bootstrap {
  token: string;
  hasApiKey: boolean;
  models: string[];
  keyStorage?: { canRemember: boolean; saved: boolean; error?: string };
}
export interface CaptureCallbacks {
  onTranscript: (entry: TranscriptEntry) => void;
  onAttribution?: (result: SpeakerAttribution) => void;
  onAttributionStatus?: (status: string) => void;
  onLevel: (source: Source, level: number) => void;
  onStatus: (source: Source, status: string) => void;
  onError: (message: string) => void;
  onEnded: () => void;
}
export interface CaptureHandle {
  stop: () => Promise<void>;
}
