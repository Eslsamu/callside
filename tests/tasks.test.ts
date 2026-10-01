import { describe, expect, it } from 'vitest';
import { buildAnswerInput } from '../server/provider';
import { settingsSchema } from '../server/validation';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import {
  LEGACY_AUTO_PROMPT,
  LEGACY_TASK_PROMPT,
  MAX_CONTEXT_CHARACTERS,
  TASK_PRESETS,
} from '../shared/tasks';
import { safeSettings } from '../src/session';
import type { AnswerRequest } from '../shared/types';

const request: AnswerRequest = {
  settings: {
    ...DEFAULT_SETTINGS,
    systemPrompt: TASK_PRESETS.workshop.prompt,
    context: '[Exercise 7]\n' + 'Course reference material. '.repeat(1700),
  },
  transcript: [
    {
      id: 'me',
      source: 'mic',
      speaker: 'Me',
      text: 'Let us explain this exercise.',
      timestamp: 1,
      final: false,
    },
  ],
  question: '',
  mode: 'manual',
  previousSuggestions: [],
};

describe('configurable tasks and reference material', () => {
  it('preserves full reference material and the same cache prefix across commands and modes', () => {
    const manual = buildAnswerInput(request);
    const auto = buildAnswerInput({
      ...request,
      mode: 'auto',
      question: 'Give a hint',
      transcript: [],
    });
    expect(manual.referenceMaterial.length).toBeGreaterThan(20000);
    expect(manual.referenceMaterial).toBe(request.settings.context);
    expect(auto.instructions).toBe(manual.instructions);
    expect(auto.referenceMaterial).toBe(manual.referenceMaterial);
    expect(manual.modeInstructions).toContain(
      'A question or completed speaking turn is not required',
    );
    expect(auto.modeInstructions).toContain('[[WAIT]]');
    expect(JSON.parse(manual.input).callTranscript[0].partial).toBe(true);
    expect(JSON.parse(auto.input).userCommand).toBe('Give a hint');
    expect(manual.maxOutputTokens).toBeNull();
  });

  it('accepts material at the shared boundary and rejects oversized material', () => {
    expect(
      settingsSchema.safeParse({ ...DEFAULT_SETTINGS, context: 'x'.repeat(MAX_CONTEXT_CHARACTERS) })
        .success,
    ).toBe(true);
    expect(
      settingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        context: 'x'.repeat(MAX_CONTEXT_CHARACTERS + 1),
      }).success,
    ).toBe(false);
  });

  it('migrates exact old defaults while preserving custom tasks, references, and output budgets', () => {
    const migrated = safeSettings(
      { systemPrompt: LEGACY_TASK_PROMPT, autoPrompt: LEGACY_AUTO_PROMPT, maxOutputTokens: 4096 },
      DEFAULT_SETTINGS,
    );
    expect(migrated.systemPrompt).toBe(DEFAULT_SETTINGS.systemPrompt);
    expect(migrated.autoPrompt).toBe(DEFAULT_SETTINGS.autoPrompt);
    expect(migrated.maxOutputTokens).toBe(4096);
    expect(migrated.autoTriggerSource).toBe('system');
    const custom = {
      systemPrompt: 'Create documentation.',
      autoPrompt: 'When I describe a decision.',
      context: request.settings.context,
      maxOutputTokens: null,
      autoTriggerSource: 'either',
    };
    expect(safeSettings(custom, DEFAULT_SETTINGS)).toMatchObject(custom);
    expect(
      safeSettings({ maxOutputTokens: NaN, autoTriggerSource: 'invalid' }, DEFAULT_SETTINGS),
    ).toMatchObject({ maxOutputTokens: null, autoTriggerSource: 'system' });
  });
});
