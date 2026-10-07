import type { Settings } from './types.js';

export const WAIT_SENTINEL = '[[WAIT]]';

/** Shared by Settings and the provider: no private writing/style instructions. */
export function answerInstructions(
  settings: Pick<Settings, 'systemPrompt' | 'autoPrompt'>,
  mode: 'manual' | 'auto',
) {
  return {
    instructions: settings.systemPrompt,
    modeInstructions:
      mode === 'auto'
        ? `AUTOMATIC MODE\n${settings.autoPrompt}\n\nIf the automatic rule does not call for a result, output exactly ${WAIT_SENTINEL}. Otherwise perform the task described above.`
        : '',
  };
}
