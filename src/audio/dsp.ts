/** Small, stateful audio primitives shared by live capture and its offline tests. */
export class StreamingResampler {
  private pending = new Float32Array(0);
  private position = 0;
  private readonly ratio: number;
  private readonly filter: Float64Array;
  private readonly delay: Float32Array;
  private delayPosition = 0;

  constructor(
    readonly inputRate: number,
    readonly outputRate = 24_000,
  ) {
    if (
      !Number.isFinite(inputRate) ||
      inputRate <= 0 ||
      !Number.isFinite(outputRate) ||
      outputRate <= 0
    ) {
      throw new Error('Audio sample rates must be positive.');
    }
    this.ratio = inputRate / outputRate;
    // A small streaming low-pass prevents high frequencies folding into the speech band.
    const taps = this.ratio > 1 ? 31 : 0;
    this.filter = new Float64Array(taps);
    this.delay = new Float32Array(taps);
    const cutoff = 0.45 / this.ratio;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const centered = i - (taps - 1) / 2;
      const sinc =
        centered === 0
          ? 2 * cutoff
          : Math.sin(2 * Math.PI * cutoff * centered) / (Math.PI * centered);
      this.filter[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
      sum += this.filter[i];
    }
    for (let i = 0; i < taps; i++) this.filter[i] /= sum;
  }

  process(input: Float32Array): Float32Array {
    if (this.inputRate === this.outputRate) return input.slice();
    if (this.filter.length) {
      const filtered = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        this.delay[this.delayPosition] = input[i];
        let sample = 0;
        for (let tap = 0; tap < this.filter.length; tap++) {
          sample +=
            this.filter[tap] *
            this.delay[(this.delayPosition - tap + this.delay.length) % this.delay.length];
        }
        filtered[i] = sample;
        this.delayPosition = (this.delayPosition + 1) % this.delay.length;
      }
      input = filtered;
    }
    const joined = new Float32Array(this.pending.length + input.length);
    joined.set(this.pending);
    joined.set(input, this.pending.length);
    const output: number[] = [];
    // Preserve a sample across packets. Fractional phase must never reset at a packet boundary.
    while (this.position + 1 < joined.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      output.push(joined[index] * (1 - fraction) + joined[index + 1] * fraction);
      this.position += this.ratio;
    }
    const consumed = Math.min(Math.floor(this.position), joined.length);
    this.pending = joined.slice(consumed);
    this.position -= consumed;
    return Float32Array.from(output);
  }
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  return Int16Array.from(samples, (sample) => {
    const bounded = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
    return Math.round(bounded * (bounded < 0 ? 32768 : 32767));
  });
}

export function rms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let energy = 0;
  for (const sample of samples) energy += (sample / 32768) ** 2;
  return Math.sqrt(energy / samples.length);
}

export function concatPcm(chunks: Int16Array[]): Int16Array {
  const output = new Int16Array(chunks.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of chunks) {
    output.set(part, position);
    position += part.length;
  }
  return output;
}

export function pcmBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return bytes;
}

export function encodeWav(samples: Int16Array, sampleRate = 24_000): Uint8Array {
  const data = pcmBytes(samples);
  const result = new Uint8Array(44 + data.byteLength);
  const view = new DataView(result.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) result[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + data.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, data.byteLength, true);
  result.set(data, 44);
  return result;
}

export interface VadResult {
  audio: Int16Array[];
  /** Position in the original input timeline, including the retained pre-roll. */
  startedAtSample?: number;
  commit: boolean;
}

interface VadOptions {
  sampleRate?: number;
  threshold?: number;
  preRollMs?: number;
  silenceMs?: number;
  minSpeechMs?: number;
  maxTurnMs?: number;
}

/** Energy VAD is intentionally local and transparent. It does not identify a person's voice. */
export class VoiceActivityDetector {
  private readonly rate: number;
  private readonly threshold: number;
  private readonly preRoll: number;
  private readonly silenceLimit: number;
  private readonly minimumSpeech: number;
  private readonly maximumTurn: number;
  private history: { samples: Int16Array; start: number }[] = [];
  private historySize = 0;
  private total = 0;
  private active = false;
  private onset = 0;
  private silence = 0;
  private turnSize = 0;

  constructor(options: VadOptions = {}) {
    this.rate = options.sampleRate ?? 24_000;
    this.threshold = options.threshold ?? 0.008;
    this.preRoll = (this.rate * (options.preRollMs ?? 250)) / 1000;
    this.silenceLimit = (this.rate * (options.silenceMs ?? 650)) / 1000;
    this.minimumSpeech = (this.rate * (options.minSpeechMs ?? 100)) / 1000;
    this.maximumTurn = (this.rate * (options.maxTurnMs ?? 15_000)) / 1000;
  }

  feed(samples: Int16Array): VadResult {
    const start = this.total;
    this.total += samples.length;
    const speech = rms(samples) >= this.threshold;
    if (!this.active) {
      this.history.push({ samples, start });
      this.historySize += samples.length;
      this.onset = speech ? this.onset + samples.length : 0;
      // Keep pre-roll plus the short onset confirmation, without unbounded silence buffering.
      const keep = this.preRoll + this.minimumSpeech;
      while (this.history.length > 1 && this.historySize - this.history[0].samples.length >= keep) {
        this.historySize -= this.history.shift()!.samples.length;
      }
      if (this.onset < this.minimumSpeech) return { audio: [], commit: false };
      this.active = true;
      this.silence = 0;
      this.turnSize = this.historySize;
      const result = {
        audio: this.history.map((part) => part.samples),
        startedAtSample: this.history[0].start,
        commit: false,
      };
      this.history = [];
      this.historySize = 0;
      return result;
    }
    this.turnSize += samples.length;
    this.silence = speech ? 0 : this.silence + samples.length;
    const commit = this.silence >= this.silenceLimit || this.turnSize >= this.maximumTurn;
    if (commit) this.resetTurn();
    return { audio: [samples], commit };
  }

  flush(): boolean {
    const shouldCommit = this.active && this.turnSize >= this.rate / 10;
    this.resetTurn();
    this.history = [];
    this.historySize = 0;
    return shouldCommit;
  }

  private resetTurn(): void {
    this.active = false;
    this.onset = 0;
    this.silence = 0;
    this.turnSize = 0;
  }
}
