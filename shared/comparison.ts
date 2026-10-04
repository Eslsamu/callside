import type { LocalMeasurement } from './local-test.js';
export type ComparisonEngineId = 'whisper' | 'cohere' | 'openai' | 'elevenlabs';
export interface ComparisonMetrics {
  audioMs: number;
  wallMs: number;
  processingMs: number;
  processingToAudioRatio: number;
  firstTextMs: number | null;
  medianFinalDelayMs: number | null;
  p95FinalDelayMs: number | null;
  maxQueueMs: number;
  drainMs: number;
  requests: number;
  finalTurns: number;
  wer: number | null;
  wordErrors: number | null;
  referenceWords: number;
}
export interface ComparisonResult {
  engine: ComparisonEngineId;
  model: string;
  transcript: string;
  metrics: ComparisonMetrics;
  measurements: LocalMeasurement[];
  error?: string;
  details?: Record<string, string | number | boolean>;
}
export interface ComparisonReport {
  version: 1;
  createdAt: string;
  language: 'en' | 'de';
  audioSha256: string;
  audioMs: number;
  reference: string;
  protocol: string;
  hardware: { platform: string; arch: string; cpu: string; memoryBytes: number; node: string };
  results: ComparisonResult[];
}
export type ComparisonEvent =
  | { type: 'start'; engine: ComparisonEngineId; model: string }
  | {
      type: 'turn';
      engine: ComparisonEngineId;
      id: string;
      text: string;
      final: boolean;
      measurement?: LocalMeasurement;
    }
  | { type: 'done'; engine: ComparisonEngineId; metrics: ComparisonMetrics; error?: string }
  | { type: 'complete'; report: ComparisonReport }
  | { type: 'error'; message: string };
