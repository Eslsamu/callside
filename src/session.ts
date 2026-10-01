import { ANSWER_MODELS, reasoningOptions } from '../shared/models';
import { LEGACY_TASK_PROMPT, LEGACY_AUTO_PROMPT } from '../shared/tasks';
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
    '\n## Results',
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
    if (key === 'maxOutputTokens') continue;
    const value = (stored as Record<string, unknown>)[key];
    if (typeof value === typeof defaults[key]) Object.assign(result, { [key]: value });
  }
  if (!ANSWER_MODELS.some((model) => model === result.model)) result.model = defaults.model;
  if (!reasoningOptions(result.model).includes(result.reasoningEffort))
    result.reasoningEffort = reasoningOptions(result.model).includes(defaults.reasoningEffort)
      ? defaults.reasoningEffort
      : reasoningOptions(result.model)[0];
  result.captureMode = result.captureMode === 'diarized' ? 'diarized' : 'realtime';
  const budget = (stored as Record<string, unknown>).maxOutputTokens;
  if (budget === null) result.maxOutputTokens = null;
  else if (typeof budget === 'number' && Number.isFinite(budget))
    result.maxOutputTokens = Math.max(64, Math.min(32768, Math.floor(budget)));
  if (!['system', 'mic', 'either'].includes(result.autoTriggerSource))
    result.autoTriggerSource = defaults.autoTriggerSource;
  if (result.systemPrompt === LEGACY_TASK_PROMPT) result.systemPrompt = defaults.systemPrompt;
  if (result.autoPrompt === LEGACY_AUTO_PROMPT) result.autoPrompt = defaults.autoPrompt;
  result.autoCooldownMs = Math.max(3000, Math.min(60000, result.autoCooldownMs));
  result.diarizationChunkSeconds = Math.max(4, Math.min(30, result.diarizationChunkSeconds));
  return result;
}
