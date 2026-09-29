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
  transcribe(audio: Uint8Array, language: string, signal: AbortSignal): Promise<LocalTranscription>;
}
