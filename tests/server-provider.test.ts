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
import { OpenAIProvider } from '../server/provider.js';
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
      { model: 'gpt-4.1-mini', instructions: 'Help', input: '{}', maxOutputTokens: 300 },
      signal,
    ))
      received.push(event);
    expect(mocked.responses).toHaveBeenLastCalledWith(
      {
        model: 'gpt-4.1-mini',
        instructions: 'Help',
        input: '{}',
        max_output_tokens: 300,
        store: false,
        stream: true,
      },
      { signal },
    );
    expect(received).toEqual([{ type: 'delta', text: 'Hello' }, { type: 'done' }]);
  });
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
          { model: 'gpt-4.1-mini', instructions: '', input: '', maxOutputTokens: 64 },
          new AbortController().signal,
        )) {
          /* consume */
        }
      })(),
    ).rejects.toThrow('Ausgabelimit');
  });
  it('sends diarized_json and scopes each speaker to its source and independent chunk', async () => {
    mocked.transcriptions.mockResolvedValue({
      segments: [{ speaker: 'A', text: ' Guten Tag ', start: 1.25 }],
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
        text: 'Guten Tag',
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
    expect(() => decodeWav(invalid.toString('base64'))).toThrow('Ungültiges Audio');
    expect(() => decodeWav(Buffer.from('RIFFnot-a-valid-wav').toString('base64'))).toThrow();
  });
});
