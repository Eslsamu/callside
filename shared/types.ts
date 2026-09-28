export type Source = 'mic' | 'system';
export type CaptureMode = 'realtime' | 'diarized';
export interface TranscriptEntry {
  id: string;
  source: Source;
  speaker: string;
  text: string;
  timestamp: number;
  final: boolean;
}
export interface Settings {
  model: string;
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
}
export interface CaptureCallbacks {
  onTranscript: (entry: TranscriptEntry) => void;
  onLevel: (source: Source, level: number) => void;
  onStatus: (source: Source, status: string) => void;
  onError: (message: string) => void;
  onEnded: () => void;
}
export interface CaptureHandle {
  stop: () => Promise<void>;
}
