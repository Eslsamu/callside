import type { Settings } from './types.js';
export const DEFAULT_SETTINGS: Settings = {
  model: 'gpt-6-luna',
  reasoningEffort: 'none',
  fastMode: false,
  transcriptionModel: 'gpt-live-transcribe',
  language: '',
  systemPrompt:
    'You are my private conversation assistant. Suggest a short answer I can say aloud to the latest question. Use the language of the conversation. Do not invent facts, prices, or commitments. If information is missing, suggest a specific follow-up question. Use at most three short sentences.',
  autoPrompt:
    'Suggest an answer when the other person asks me a question or raises an objection. Stay silent during small talk, my own statements, and questions already answered.',
  context: '',
  maxOutputTokens: 4096,
  autoCooldownMs: 8000,
  captureMode: 'realtime',
  captureMic: true,
  captureSystem: true,
  micDeviceId: '',
  systemDeviceId: '',
  micLabel: 'Me',
  systemLabel: 'Other speaker',
  diarizationChunkSeconds: 8,
};
