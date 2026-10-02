export interface LocalMeasurement {
  turnId: string;
  final: boolean;
  audioMs: number;
  processingMs: number;
  requestMs: number;
  queueMs: number;
  speechToTextMs: number;
  firstTextMs: number;
}

export interface LocalTranscription {
  text: string;
  processingMs: number;
}

export interface LocalEngine {
  model: string;
  details?: Record<string, string | number | boolean>;
  transcribe(audio: Uint8Array, language: string, signal: AbortSignal): Promise<LocalTranscription>;
}
