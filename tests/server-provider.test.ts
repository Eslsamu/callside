import { describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ responses: vi.fn(), transcriptions: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create: mocked.responses };
    audio = { transcriptions: { create: mocked.transcriptions } };
  },
  toFile: async (data: Buffer, name: string, options: { type: string }) => ({
    data,
    name,
    type: options.type,
  }),
}));
import { OpenAIProvider, publicError } from '../server/provider.js';
import { decodeWav } from '../server/validation.js';

function wav() {
  const buffer = Buffer.alloc(44 + 4800);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(4800, 40);
  return buffer;
}
describe('OpenAI provider contract (no upstream network)', () => {
  it('uses the Responses stream with store:false and propagates the abort signal', async () => {
    mocked.responses.mockResolvedValue(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'Hello' };
        yield { type: 'response.completed' };
      })(),
    );
    const signal = new AbortController().signal;
    const provider = new OpenAIProvider('not-a-real-key');
    const received = [];
    for await (const event of provider.answer(
      {
        model: 'gpt-6-luna',
        reasoningEffort: 'none',
        fastMode: false,
        instructions: 'Help',
        referenceMaterial: 'Reference facts',
        modeInstructions: 'Manual mode',
        input: '{}',
        maxOutputTokens: 300,
      },
      signal,
    ))
      received.push(event);
    expect(mocked.responses).toHaveBeenLastCalledWith(
      {
        model: 'gpt-6-luna',
        reasoning: { effort: 'none' },
        service_tier: 'default',
        input: [
          { role: 'developer', content: 'Help' },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({ referenceMaterial: 'Reference facts' }),
                prompt_cache_breakpoint: { mode: 'explicit' },
              },
            ],
          },
          { role: 'developer', content: 'Manual mode' },
          { role: 'user', content: '{}' },
        ],
        prompt_cache_options: { mode: 'explicit', ttl: '30m' },
        max_output_tokens: 300,
        store: false,
        stream: true,
      },
      { signal },
    );
    expect(received).toEqual([{ type: 'delta', text: 'Hello' }, { type: 'done' }]);
  });
  it.each([false, true])(
    'supports Fast mode %s without API-only controls for ChatGPT plan requests',
    async (fastMode) => {
      mocked.responses.mockResolvedValue(
        (async function* () {
          yield { type: 'response.output_text.delta', delta: 'Plan suggestion' };
          yield { type: 'response.completed' };
        })(),
      );
      const received = [];
      for await (const event of new OpenAIProvider('fake-oauth', 'chatgpt').answer(
        {
          model: 'gpt-6.1-sol',
          reasoningEffort: 'none',
          fastMode,
          instructions: 'Configured task',
          referenceMaterial: 'Course context',
          modeInstructions: 'Manual',
          input: 'Transcript',
          maxOutputTokens: 64,
        },
        new AbortController().signal,
      ))
        received.push(event);
      const payload = mocked.responses.mock.lastCall![0];
      expect(payload).toMatchObject({ store: false, stream: true, reasoning: { effort: 'none' } });
      expect(payload.service_tier).toBe(fastMode ? 'priority' : 'default');
      for (const field of ['max_output_tokens', 'prompt_cache_options'])
        expect(payload).not.toHaveProperty(field);
      expect(JSON.stringify(payload)).not.toContain('prompt_cache_breakpoint');
      expect(JSON.stringify(payload)).toContain('Course context');
      expect(received.at(-1)).toEqual({ type: 'done' });
    },
  );
  it('fails on incomplete streams instead of presenting an empty success', async () => {
    mocked.responses.mockResolvedValue(
      (async function* () {
        yield { type: 'response.incomplete' };
      })(),
    );
    const provider = new OpenAIProvider('not-a-real-key');
    await expect(
      (async () => {
        for await (const _ of provider.answer(
          {
            model: 'gpt-6-luna',
            reasoningEffort: 'none',
            fastMode: false,
            instructions: '',
            referenceMaterial: '',
            modeInstructions: '',
            input: '',
            maxOutputTokens: 64,
          },
          new AbortController().signal,
        )) {
          /* consume */
        }
      })(),
    ).rejects.toThrow('output limit');
  });
  it('sends diarized_json and scopes each speaker to its source and independent chunk', async () => {
    mocked.transcriptions.mockResolvedValue({
      segments: [{ speaker: 'A', text: ' Good morning ', start: 1.25 }],
    });
    const provider = new OpenAIProvider('not-a-real-key');
    const signal = new AbortController().signal;
    const first = await provider.diarize(
      { audio: wav(), source: 'system', chunkId: 'one', timestamp: 10000, language: 'de' },
      signal,
    );
    const second = await provider.diarize(
      { audio: wav(), source: 'system', chunkId: 'two', timestamp: 20000, language: 'de' },
      signal,
    );
    expect(mocked.transcriptions).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o-transcribe-diarize',
        response_format: 'diarized_json',
        chunking_strategy: 'auto',
        language: 'de',
      }),
      { signal },
    );
    expect(first).toEqual([
      {
        id: 'system:one:0',
        source: 'system',
        speaker: 'system:one:A',
        text: 'Good morning',
        timestamp: 11250,
        final: true,
      },
    ]);
    expect(second[0].speaker).toBe('system:two:A');
    expect(first[0].speaker).not.toBe(second[0].speaker);
  });
  it('rejects malformed and non-PCM WAV data before upload', () => {
    expect(decodeWav(wav().toString('base64')).length).toBe(4844);
    const invalid = wav();
    invalid.writeUInt16LE(3, 20);
    expect(() => decodeWav(invalid.toString('base64'))).toThrow('Invalid audio');
    expect(() => decodeWav(Buffer.from('RIFFnot-a-valid-wav').toString('base64'))).toThrow();
  });
  it('passes reference names and WAV data URLs to OpenAI and retains segment ends', async () => {
    mocked.transcriptions.mockResolvedValue({
      segments: [{ speaker: 'speaker_1', text: 'Hello again', start: 0.5, end: 2.75 }],
    });
    const provider = new OpenAIProvider('not-a-real-key');
    const reference = wav().toString('base64');
    const entries = await provider.diarize(
      {
        audio: wav(),
        source: 'system',
        chunkId: 'known',
        timestamp: 1000,
        language: '',
        knownSpeakers: [{ name: 'speaker_1', audio: reference }],
      },
      new AbortController().signal,
    );
    expect(mocked.transcriptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        known_speaker_names: ['speaker_1'],
        known_speaker_references: [`data:audio/wav;base64,${reference}`],
      }),
      expect.anything(),
    );
    expect(entries[0]).toMatchObject({
      timestamp: 1500,
      endTimestamp: 3750,
      speaker: 'system:known:speaker_1',
    });
  });
});

describe('GPT-6 model parameters', () => {
  it.each(['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra'])(
    'sends reasoning and Fast parameters for %s',
    async (model) => {
      mocked.responses.mockResolvedValue(
        (async function* () {
          yield { type: 'response.completed' };
        })(),
      );
      const provider = new OpenAIProvider('not-a-real-key');
      for await (const _ of provider.answer(
        {
          model,
          reasoningEffort: 'high',
          fastMode: true,
          instructions: 'Help',
          referenceMaterial: 'Reference facts',
          modeInstructions: 'Manual mode',
          input: '{}',
          maxOutputTokens: 4096,
        },
        new AbortController().signal,
      )) {
        /* consume */
      }
      expect(mocked.responses).toHaveBeenLastCalledWith(
        expect.objectContaining({
          model,
          reasoning: { effort: 'high' },
          service_tier: 'priority',
          max_output_tokens: 4096,
        }),
        expect.anything(),
      );
    },
  );
});

import { settingsSchema } from '../server/validation.js';
import { DEFAULT_SETTINGS } from '../shared/defaults.js';
it('rejects unsupported answer models and Astra without reasoning before provider use', () => {
  expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, model: 'retired-model' }).success).toBe(
    false,
  );
  expect(
    settingsSchema.safeParse({ ...DEFAULT_SETTINGS, model: 'gpt-6-astra', reasoningEffort: 'none' })
      .success,
  ).toBe(false);
  expect(
    settingsSchema.safeParse({ ...DEFAULT_SETTINGS, model: 'gpt-6-astra', reasoningEffort: 'max' })
      .success,
  ).toBe(true);
});

it('accepts GPT-6.1 Sol with supported reasoning and rejects none', () => {
  for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    expect(
      settingsSchema.safeParse({ ...DEFAULT_SETTINGS, model: 'gpt-6.1-sol', reasoningEffort })
        .success,
    ).toBe(true);
  }
  expect(
    settingsSchema.safeParse({ ...DEFAULT_SETTINGS, model: 'gpt-6.1-sol', reasoningEffort: 'none' })
      .success,
  ).toBe(false);
});

it('omits a custom output cap and reports actual token and cache usage', async () => {
  mocked.responses.mockResolvedValue(
    (async function* () {
      yield { type: 'response.output_text.delta', delta: 'Try a smaller example.' };
      yield {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 10500,
            output_tokens: 130,
            input_tokens_details: { cached_tokens: 10000, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 100 },
          },
        },
      };
    })(),
  );
  const result = [];
  for await (const event of new OpenAIProvider('not-a-real-key').answer(
    {
      model: 'gpt-6.1-sol',
      reasoningEffort: 'low',
      fastMode: false,
      instructions: 'Help with the task',
      referenceMaterial: 'Course notes',
      modeInstructions: 'Manual mode',
      input: '{}',
      maxOutputTokens: null,
    },
    new AbortController().signal,
  ))
    result.push(event);
  expect(mocked.responses.mock.lastCall?.[0]).not.toHaveProperty('max_output_tokens');
  expect(result.at(-1)).toEqual({
    type: 'done',
    usage: {
      inputTokens: 10500,
      outputTokens: 130,
      cachedInputTokens: 10000,
      cacheWriteTokens: 0,
      reasoningTokens: 100,
    },
  });
});

it('reports safe connection codes and service status without exposing raw error details', () => {
  expect(publicError({ status: 503, message: 'sk-private' })).toContain('HTTP 503');
  expect(
    publicError(new Error('secret URL', { cause: { code: 'ECONNRESET', apiKey: 'private' } })),
  ).toContain('ECONNRESET');
  expect(publicError(new Error('sk-private', { cause: { code: 'unknown-secret' } }))).not.toContain(
    'secret',
  );
});
