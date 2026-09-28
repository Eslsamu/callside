import { ANSWER_MODELS, reasoningOptions } from '../shared/models';
import type { Settings, Suggestion, TranscriptEntry } from '../shared/types';
export const DEMO_TURNS = [
  {
    source: 'system' as const,
    text: 'We are looking for a solution that supports our sales team during calls.',
  },
  { source: 'mic' as const, text: 'What takes the most time right now?' },
  {
    source: 'system' as const,
    text: 'Preparation. Everyone gathers information from several different tools.',
  },
  {
    source: 'mic' as const,
    text: 'Understood. Let us look at that process first.',
  },
  { source: 'system' as const, text: 'How would you set up our first test together?' },
];
export function sessionMarkdown(
  entries: TranscriptEntry[],
  suggestions: Suggestion[],
  demo: boolean,
): string {
  return [
    '# Callside session',
    demo ? '\nDemo: synthetic sample conversation.\n' : '',
    '## Transcript',
    ...entries.map(
      (e) =>
        `\n**${e.speaker}** (${new Date(e.timestamp).toLocaleTimeString('en-GB')}): ${e.text}${e.final ? '' : ' [partial]'}`,
    ),
    '\n## Answer suggestions',
    ...suggestions.map(
      (s) =>
        `\n### ${s.mode === 'auto' ? 'Automatic' : 'Manual'}${s.question ? `: ${s.question}` : ''}\n\n${s.text}`,
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
  if (!ANSWER_MODELS.some((model) => model === result.model)) result.model = defaults.model;
  if (!reasoningOptions(result.model).includes(result.reasoningEffort))
    result.reasoningEffort = result.model === 'gpt-6-astra' ? 'low' : defaults.reasoningEffort;
  result.captureMode = result.captureMode === 'diarized' ? 'diarized' : 'realtime';
  result.maxOutputTokens = Math.max(64, Math.min(32768, result.maxOutputTokens));
  result.autoCooldownMs = Math.max(3000, Math.min(60000, result.autoCooldownMs));
  result.diarizationChunkSeconds = Math.max(4, Math.min(30, result.diarizationChunkSeconds));
  return result;
}
