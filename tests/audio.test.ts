import { describe, expect, it } from 'vitest';
import {
  concatPcm,
  encodeWav,
  floatToPcm16,
  StreamingResampler,
  VoiceActivityDetector,
} from '../src/audio/dsp.js';
import { TranscriptAssembler } from '../src/audio/transcript.js';
import type { TranscriptEntry } from '../shared/types.js';

describe('streaming audio conversion', () => {
  it('preserves fractional resampling phase across arbitrary 44.1kHz packet boundaries', () => {
    const input = Float32Array.from({ length: 44_100 }, (_, index) =>
      Math.sin((2 * Math.PI * 440 * index) / 44_100),
    );
    const expected = new StreamingResampler(44_100).process(input);
    const resampler = new StreamingResampler(44_100);
    const actual: number[] = [];
    for (let offset = 0; offset < input.length; offset += 127)
      actual.push(...resampler.process(input.subarray(offset, offset + 127)));
    expect(actual.length).toBe(24_000);
    expect(expected.length).toBe(actual.length);
    expect(
      Math.max(...actual.map((sample, index) => Math.abs(sample - expected[index]))),
    ).toBeLessThan(0.00001);
  });

  it('downsamples one second of 48kHz input without duration drift', () => {
    const resampler = new StreamingResampler(48_000);
    let sampleCount = 0;
    for (let i = 0; i < 375; i++)
      sampleCount += resampler.process(new Float32Array(128).fill(0.25)).length;
    expect(sampleCount).toBe(24_000);
  });

  it('attenuates frequencies above the new Nyquist limit instead of aliasing into speech', () => {
    const input = Float32Array.from({ length: 48_000 }, (_, index) =>
      Math.sin((2 * Math.PI * 18_000 * index) / 48_000),
    );
    const output = new StreamingResampler(48_000).process(input).subarray(100);
    const amplitude = Math.sqrt(
      output.reduce((sum, sample) => sum + sample * sample, 0) / output.length,
    );
    expect(amplitude).toBeLessThan(0.015);
  });

  it('clips samples and writes canonical little endian mono WAV', () => {
    const pcm = floatToPcm16(Float32Array.from([-2, -1, 0, 1, 2, Number.NaN]));
    expect([...pcm]).toEqual([-32768, -32768, 0, 32767, 32767, 0]);
    const wav = encodeWav(pcm);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
    expect(view.getInt16(44, true)).toBe(-32768);
  });
});

describe('client voice activity detection', () => {
  const silence = () => new Int16Array(1200);
  const speech = () => new Int16Array(1200).fill(4000);

  it('ignores silence, retains pre-roll, and commits exactly once after trailing silence', () => {
    const vad = new VoiceActivityDetector();
    for (let i = 0; i < 40; i++) expect(vad.feed(silence())).toEqual({ audio: [], commit: false });
    expect(vad.feed(speech()).audio.length).toBe(0);
    const onset = vad.feed(speech());
    expect(onset.startedAtSample).toBe(42 * 1200 - 8400);
    expect(concatPcm(onset.audio).length).toBe(8400);
    let commits = 0;
    for (let i = 0; i < 20; i++) if (vad.feed(silence()).commit) commits++;
    expect(commits).toBe(1);
    expect(vad.flush()).toBe(false);
  });

  it('flushes an unfinished phrase once and bounds a long uninterrupted turn', () => {
    const vad = new VoiceActivityDetector({ maxTurnMs: 1000 });
    let commits = 0;
    for (let i = 0; i < 21; i++) if (vad.feed(speech()).commit) commits++;
    expect(commits).toBe(1);
    vad.feed(speech());
    expect(vad.flush()).toBe(true);
    expect(vad.flush()).toBe(false);
  });

  it('does not submit a lone click as a speech turn', () => {
    const vad = new VoiceActivityDetector();
    expect(vad.feed(speech()).audio).toEqual([]);
    expect(vad.feed(silence()).audio).toEqual([]);
    expect(vad.flush()).toBe(false);
  });
});

describe('transcript ordering', () => {
  it('uses capture timestamps even when the second turn completes first', () => {
    const received: TranscriptEntry[] = [];
    const assembler = new TranscriptAssembler('system', 'Gegenüber', (entry) =>
      received.push(entry),
    );
    assembler.beginTurn(1000);
    assembler.accept({ type: 'input_audio_buffer.committed', item_id: 'a' });
    assembler.beginTurn(5000);
    assembler.accept({ type: 'input_audio_buffer.committed', item_id: 'b', previous_item_id: 'a' });
    assembler.accept({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'b',
      transcript: 'Second',
    });
    assembler.accept({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      delta: 'Fir',
    });
    assembler.accept({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'First',
    });
    assembler.accept({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      delta: 'late',
    });
    expect(received.map((entry) => [entry.id, entry.timestamp, entry.text])).toEqual([
      ['system:b', 5000, 'Second'],
      ['system:a', 1000, 'Fir'],
      ['system:a', 1000, 'First'],
    ]);
    expect(assembler.pending).toBe(0);
  });
});
