import type { Settings, Suggestion, TranscriptEntry } from '../shared/types';
export const DEMO_TURNS = [
  {
    source: 'system' as const,
    text: 'Wir suchen eine Lösung, die unser Vertriebsteam im Gespräch unterstützt.',
  },
  { source: 'mic' as const, text: 'Was kostet euch im Moment die meiste Zeit?' },
  {
    source: 'system' as const,
    text: 'Die Vorbereitung. Jeder sucht sich Informationen aus verschiedenen Tools zusammen.',
  },
  {
    source: 'mic' as const,
    text: 'Verstanden. Dann sollten wir zuerst diesen Ablauf genauer anschauen.',
  },
  { source: 'system' as const, text: 'Wie würdest du einen ersten gemeinsamen Test aufsetzen?' },
];
export function sessionMarkdown(
  entries: TranscriptEntry[],
  suggestions: Suggestion[],
  demo: boolean,
): string {
  return [
    '# Callside Sitzung',
    demo ? '\nDemo: synthetisches Beispielgespräch.\n' : '',
    '## Transkript',
    ...entries.map(
      (e) =>
        `\n**${e.speaker}** (${new Date(e.timestamp).toLocaleTimeString('de-DE')}): ${e.text}${e.final ? '' : ' [vorläufig]'}`,
    ),
    '\n## Antwortvorschläge',
    ...suggestions.map(
      (s) =>
        `\n### ${s.mode === 'auto' ? 'Automatisch' : 'Manuell'}${s.question ? `: ${s.question}` : ''}\n\n${s.text}`,
    ),
  ].join('\n');
}
export function safeSettings(stored: unknown, defaults: Settings): Settings {
  if (!stored || typeof stored !== 'object') return { ...defaults };
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    const value = (stored as Record<string, unknown>)[key];
    if (typeof value === typeof defaults[key]) Object.assign(result, { [key]: value });
  }
  result.captureMode = result.captureMode === 'diarized' ? 'diarized' : 'realtime';
  result.maxOutputTokens = Math.max(64, Math.min(2000, result.maxOutputTokens));
  result.autoCooldownMs = Math.max(3000, Math.min(60000, result.autoCooldownMs));
  result.diarizationChunkSeconds = Math.max(4, Math.min(30, result.diarizationChunkSeconds));
  return result;
}
