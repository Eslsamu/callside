/** LS-EEND's streaming logmel23_cummn frontend, using bounded audio/feature buffers.
 * The upstream Python frontend rounds win_length=200 up to FFT=256; the export's
 * n_fft=1024 metadata is not used by its reference feature extractor.
 * See native/windows/diarization/README.md for pinned sources and verification.
 */
const FFT = 256,
  WINDOW = 200,
  HOP = 80,
  MELS = 23,
  CONTEXT = 7,
  SUBSAMPLE = 10;
const hzToMel = (hz: number) =>
  hz < 1000 ? hz / (200 / 3) : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27);
const melToHz = (mel: number) =>
  mel < 15 ? mel * (200 / 3) : 1000 * Math.exp((mel - 15) * (Math.log(6.4) / 27));
const edges = Array.from({ length: MELS + 2 }, (_, i) => melToHz((hzToMel(4000) * i) / (MELS + 1)));
const weights = Array.from({ length: MELS }, (_, mel) =>
  Float32Array.from({ length: FFT / 2 + 1 }, (_, bin) => {
    const hz = (bin * 8000) / FFT;
    return (
      (Math.max(
        0,
        Math.min(
          (hz - edges[mel]) / (edges[mel + 1] - edges[mel]),
          (edges[mel + 2] - hz) / (edges[mel + 2] - edges[mel + 1]),
        ),
      ) *
        2) /
      (edges[mel + 2] - edges[mel])
    );
  }),
);
const window = Float64Array.from({ length: FFT }, (_, i) =>
  i < 28 || i >= 228 ? 0 : 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - 28)) / WINDOW),
);

function spectrum(samples: Float32Array): Float64Array {
  const real = Float64Array.from(samples, (x, i) => x * window[i]);
  const imaginary = new Float64Array(FFT);
  for (let i = 1, j = 0; i < FFT; i++) {
    let bit = FFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let size = 2; size <= FFT; size *= 2) {
    const angle = (-2 * Math.PI) / size;
    for (let start = 0; start < FFT; start += size) {
      for (let j = 0; j < size / 2; j++) {
        const even = start + j,
          odd = even + size / 2;
        const c = Math.cos(angle * j),
          s = Math.sin(angle * j);
        const r = real[odd] * c - imaginary[odd] * s,
          im = real[odd] * s + imaginary[odd] * c;
        real[odd] = real[even] - r;
        imaginary[odd] = imaginary[even] - im;
        real[even] += r;
        imaginary[even] += im;
      }
    }
  }
  return Float64Array.from({ length: FFT / 2 + 1 }, (_, i) => {
    // Match complex64 STFT and float32 magnitude/power used by librosa.
    const r = Math.fround(real[i]),
      im = Math.fround(imaginary[i]);
    const magnitude = Math.fround(Math.hypot(r, im));
    return Math.fround(magnitude * magnitude);
  });
}

export class SpeakerFeatures {
  private audio = new Float32Array(0);
  private audioStart = 0;
  private totalSamples = 0;
  private nextStft = 0;
  private nextModel = 0;
  private featureStart = 0;
  private features: Float32Array[] = [];
  private sums = new Float64Array(MELS);
  private finished = false;

  push(samples: Float32Array, final = false): Float32Array[] {
    if (this.finished) throw new Error('Speaker frontend is already finalized.');
    this.finished = final;
    const joined = new Float32Array(this.audio.length + samples.length);
    joined.set(this.audio);
    joined.set(samples, this.audio.length);
    this.audio = joined;
    this.totalSamples += samples.length;
    const usable = final ? Math.floor(this.totalSamples / 800) * 800 : this.totalSamples;
    const target = final
      ? Math.max(0, Math.floor(usable / HOP) - 1)
      : Math.max(0, Math.floor((usable - FFT / 2) / HOP) + 1);
    while (this.nextStft < target) {
      const start = this.nextStft * HOP - FFT / 2;
      const frame = new Float32Array(FFT);
      for (let i = 0; i < FFT; i++) {
        const sample = start + i;
        if (sample >= 0 && sample < usable) frame[i] = this.audio[sample - this.audioStart];
      }
      const power = spectrum(frame),
        feature = new Float32Array(MELS);
      for (let mel = 0; mel < MELS; mel++) {
        let energy = 0;
        for (let bin = 0; bin < power.length; bin++) energy += power[bin] * weights[mel][bin];
        const value = Math.fround(Math.log10(Math.max(Math.fround(energy), 1e-10)));
        this.sums[mel] += value;
        feature[mel] = value - this.sums[mel] / (this.nextStft + 1);
      }
      this.features.push(feature);
      this.nextStft++;
    }
    const keepAudio = Math.min(this.totalSamples, Math.max(0, this.nextStft * HOP - FFT / 2));
    this.audio = this.audio.slice(keepAudio - this.audioStart);
    this.audioStart = keepAudio;
    const output: Float32Array[] = [];
    while (
      final
        ? this.nextModel < Math.ceil(target / SUBSAMPLE)
        : this.nextModel * SUBSAMPLE + CONTEXT < this.nextStft
    ) {
      const center = this.nextModel * SUBSAMPLE;
      const feature = new Float32Array(MELS * (2 * CONTEXT + 1));
      for (let offset = -CONTEXT; offset <= CONTEXT; offset++) {
        const index = center + offset;
        if (index >= 0 && index < this.nextStft) {
          const source = this.features[index - this.featureStart];
          if (!source) throw new Error('Speaker feature buffer underflow.');
          feature.set(source, (offset + CONTEXT) * MELS);
        }
      }
      output.push(feature);
      this.nextModel++;
    }
    const keepFeature = Math.min(this.nextStft, Math.max(0, this.nextModel * SUBSAMPLE - CONTEXT));
    this.features.splice(0, keepFeature - this.featureStart);
    this.featureStart = keepFeature;
    return output;
  }
}

/** Fixed 24 kHz -> 8 kHz low-pass FIR resampler. Centered taps avoid timestamp
 * drift. Only 31 input samples of look-ahead are retained between chunks. */
export class SpeakerResampler {
  private buffer: number[] = [];
  private start = 0;
  private total = 0;
  private next = 0;
  private readonly taps = (() => {
    const taps = Array.from({ length: 63 }, (_, i) => {
      const x = i - 31,
        cutoff = 0.15;
      return (
        (x ? Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x) : 2 * cutoff) *
        (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / 62))
      );
    });
    const sum = taps.reduce((a, b) => a + b, 0);
    return taps.map((v) => v / sum);
  })();
  push(pcm: Int16Array, final = false): Float32Array {
    for (const value of pcm) this.buffer.push(value / 32768);
    this.total += pcm.length;
    const result: number[] = [];
    while (final ? this.next < this.total : this.next + 31 < this.total) {
      let value = 0;
      for (let i = 0; i < this.taps.length; i++) {
        const sample = this.next + i - 31;
        if (sample >= 0 && sample < this.total)
          value += this.buffer[sample - this.start] * this.taps[i];
      }
      result.push(value);
      this.next += 3;
    }
    const keep = Math.min(this.total, Math.max(0, this.next - 31));
    this.buffer.splice(0, keep - this.start);
    this.start = keep;
    return Float32Array.from(result);
  }
}
