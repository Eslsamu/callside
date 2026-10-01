export const ANSWER_MODELS = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra'] as const;
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export function reasoningOptions(model: string): readonly ReasoningEffort[] {
  return model === 'gpt-6-astra' || model === 'gpt-6.1-sol'
    ? REASONING_EFFORTS.filter((effort) => effort !== 'none')
    : REASONING_EFFORTS;
}
