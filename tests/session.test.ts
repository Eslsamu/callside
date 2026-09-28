import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamAnswer } from '../src/api';
import { safeSettings, sessionMarkdown } from '../src/session';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AnswerRequest } from '../shared/types';

afterEach(() => vi.unstubAllGlobals());
const request: AnswerRequest = {
  settings: DEFAULT_SETTINGS,
  transcript: [],
  question: 'Test',
  previousSuggestions: [],
  mode: 'manual',
};
function mockStream(chunks: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    ),
  );
}
describe('answer stream integrity', () => {
  it('handles events fragmented over arbitrary transport boundaries', async () => {
    mockStream(['data: {"type":"delta","text":"Hel', 'lo"}\n\ndata: {"type":"done"}\n', '\n']);
    const events = [];
    for await (const event of streamAnswer(request, 'test-token', new AbortController().signal))
      events.push(event);
    expect(events).toEqual([{ type: 'delta', text: 'Hello' }, { type: 'done' }]);
  });
  it('does not silently accept a response interrupted before its completion marker', async () => {
    mockStream(['data: {"type":"delta","text":"Incomplete"}\n\n']);
    const read = async () => {
      for await (const _event of streamAnswer(
        request,
        'test-token',
        new AbortController().signal,
      )) {
        /* drain */
      }
    };
    await expect(read()).rejects.toThrow('interrupted');
  });
  it('recognizes an intentional automatic skip', async () => {
    mockStream(['data: {"type":"skip"}\n\n']);
    const events = [];
    for await (const event of streamAnswer(request, 'test-token', new AbortController().signal))
      events.push(event);
    expect(events).toEqual([{ type: 'skip' }]);
  });
});
describe('session data', () => {
  it('bounds persisted settings and rejects injected keys or wrong types', () => {
    const restored = safeSettings(
      { apiKey: 'secret', maxOutputTokens: 100000, captureMic: 'yes', captureMode: 'invalid' },
      DEFAULT_SETTINGS,
    );
    expect(restored.maxOutputTokens).toBe(32768);
    expect(restored.captureMic).toBe(true);
    expect(restored.captureMode).toBe('realtime');
    expect(restored).not.toHaveProperty('apiKey');
  });
  it('exports partial transcript text and makes synthetic sessions explicit', () => {
    const markdown = sessionMarkdown(
      [{ id: '1', source: 'mic', speaker: 'Me', text: 'Hello', timestamp: 0, final: false }],
      [],
      true,
    );
    expect(markdown).toContain('synthetic sample conversation');
    expect(markdown).toContain('Hello [partial]');
  });
});

describe('GPT-6 settings migration', () => {
  it('replaces unsupported saved answer models and keeps custom prompts', () => {
    const restored = safeSettings(
      { model: 'retired-model', systemPrompt: 'My custom prompt' },
      DEFAULT_SETTINGS,
    );
    expect(restored.model).toBe('gpt-6-luna');
    expect(restored.systemPrompt).toBe('My custom prompt');
    expect(restored.fastMode).toBe(false);
  });
  it('moves unsupported Astra reasoning to low', () => {
    expect(
      safeSettings({ model: 'gpt-6-astra', reasoningEffort: 'none' }, DEFAULT_SETTINGS)
        .reasoningEffort,
    ).toBe('low');
  });
});
