import type { Settings } from './types.js';
export const DEFAULT_SETTINGS: Settings = {
  model: 'gpt-4.1-mini',
  transcriptionModel: 'gpt-live-transcribe',
  language: 'de',
  systemPrompt:
    'Du bist mein diskreter Gesprächsassistent. Gib mir eine kurze, direkt aussprechbare Antwort auf die letzte Frage im Gespräch. Nutze die Sprache des Gesprächs. Erfinde keine Fakten, Preise oder Zusagen. Wenn Informationen fehlen, schlage eine konkrete Rückfrage vor. Höchstens drei kurze Sätze.',
  autoPrompt:
    'Gib mir einen Antwortvorschlag, wenn die andere Person eine Frage an mich stellt oder einen Einwand äußert. Bleibe bei Smalltalk, meinen eigenen Aussagen und bereits beantworteten Fragen still.',
  context: '',
  maxOutputTokens: 300,
  autoCooldownMs: 8000,
  captureMode: 'realtime',
  captureMic: true,
  captureSystem: true,
  micDeviceId: '',
  systemDeviceId: '',
  micLabel: 'Ich',
  systemLabel: 'Gegenüber',
  diarizationChunkSeconds: 8,
};
