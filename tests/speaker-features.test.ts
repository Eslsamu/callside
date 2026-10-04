import { expect, it } from 'vitest';
import { SpeakerFeatures, SpeakerResampler } from '../server/speaker-features';

it('matches the pinned LS-EEND Python/librosa frontend values', () => {
  const frontend = new SpeakerFeatures();
  const audio = Float32Array.from(
    { length: 8000 },
    (_, i) => 0.2 * Math.sin(i * 0.117) + 0.05 * Math.cos(i * 0.039),
  );
  const frames = [...frontend.push(audio), ...frontend.push(new Float32Array(0), true)];
  expect(frames).toHaveLength(10);
  // Reference: StreamingFeatureExtractor at cc40a1e, librosa 0.11.0, float32.
  const reference = [
    [0, 161, 0],
    [0, 300, 0.049020953476428986],
    [1, 7, -1.6221036911010742],
    [1, 199, -0.7412775158882141],
    [3, 33, -0.3015911281108856],
    [3, 223, -0.2644535303115845],
    [8, 76, -0.06112470105290413],
    [9, 150, 0.08172305673360825],
    [9, 344, -0.08229467272758484],
  ];
  for (const [frame, feature, expected] of reference)
    expect(frames[frame][feature]).toBeCloseTo(expected, 5);
});

it('preserves the same resampling, features, and final tail across arbitrary PCM chunks', () => {
  const audio = Int16Array.from({ length: 24211 }, (_, i) =>
    Math.round(9000 * Math.sin(i * 0.22) + 3000 * Math.cos(i * 0.003)),
  );
  const run = (size: number) => {
    const resampler = new SpeakerResampler(),
      frontend = new SpeakerFeatures();
    const samples: number[] = [],
      frames: Float32Array[] = [];
    for (let i = 0; i < audio.length; i += size) {
      const resampled = resampler.push(audio.subarray(i, i + size));
      samples.push(...resampled);
      frames.push(...frontend.push(resampled));
    }
    const tail = resampler.push(new Int16Array(0), true);
    samples.push(...tail);
    frames.push(...frontend.push(tail, true));
    return { samples, frames };
  };
  const whole = run(audio.length),
    split = run(337);
  expect(split.samples).toHaveLength(Math.ceil(audio.length / 3));
  expect(split).toEqual(whole);
  expect(split.frames).toHaveLength(10);
});

it('finishes empty or sub-frame sessions without fabricated speaker features', () => {
  for (const length of [0, 1, 79, 799]) {
    const frontend = new SpeakerFeatures();
    const frames = frontend.push(new Float32Array(length), true);
    expect(frames).toEqual([]);
    expect(() => frontend.push(new Float32Array(1))).toThrow('finalized');
  }
});
