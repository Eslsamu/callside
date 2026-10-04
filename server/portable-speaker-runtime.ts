import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-web/wasm';
import { SpeakerFeatures, SpeakerResampler } from './speaker-features.js';
import type { LocalSpeakerResult } from './local-speakers.js';

// Single-threaded WASM runs on the dedicated worker thread. No GPU, native DLL,
// Python, network request, or worker pool competes with the transcription engine.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
const shapes: Record<string, number[]> = {
  enc_ret_kv: [4, 1, 4, 64, 64],
  enc_ret_scale: [4, 1, 4],
  enc_conv_cache: [4, 1, 15, 256],
  dec_ret_kv: [2, 6, 4, 64, 64],
  dec_ret_scale: [2, 6, 4],
  top_buffer: [1, 19, 256],
};

export class PortableSpeakerRuntime {
  private features = new SpeakerFeatures();
  private resampler = new SpeakerResampler();
  private state: Record<string, ort.Tensor> = {};
  private received = 0;
  private fed = 0;
  private emitted = 0;
  private finalized = false;
  private history: Array<{ frame: number; active: boolean[] }> = [];
  private constructor(private session: ort.InferenceSession) {
    for (const [name, dims] of Object.entries(shapes))
      this.state[name] = new ort.Tensor(
        'float32',
        new Float32Array(dims.reduce((a, b) => a * b, 1)),
        dims,
      );
  }
  static async create(model: string) {
    const bytes = await readFile(model);
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return new PortableSpeakerRuntime(session);
  }
  private async step(feature: Float32Array, ingest: boolean, decode: boolean) {
    const frame = new ort.Tensor('float32', feature, [1, 1, 345]);
    const ingestTensor = new ort.Tensor('float32', [Number(ingest)], [1]);
    const decodeTensor = new ort.Tensor('float32', [Number(decode)], [1]);
    let prediction: ort.InferenceSession.ReturnType;
    try {
      prediction = await this.session.run({
        ...this.state,
        frame,
        ingest: ingestTensor,
        decode: decodeTensor,
      });
    } finally {
      frame.dispose();
      ingestTensor.dispose();
      decodeTensor.dispose();
    }
    for (const name of Object.keys(shapes)) {
      this.state[name].dispose();
      this.state[name] = prediction[name + '_out'];
    }
    if (decode) {
      const logits = prediction.full_logits.data as Float32Array;
      if (logits.length !== 6 || !logits.every(Number.isFinite))
        throw new Error('Invalid speaker model output.');
      // Slots 0 and 5 are boundary/dummy speakers, not real people.
      this.history.push({
        frame: this.emitted++,
        active: Array.from(logits.slice(1, 5), (value) => value > 0),
      });
    }
    prediction.full_logits.dispose();
  }
  async request(audio?: string, final = false): Promise<LocalSpeakerResult> {
    if (this.finalized) throw new Error('Speaker session already finalized.');
    const bytes = Buffer.from(audio ?? '', 'base64');
    if (bytes.length > 384000 || bytes.length % 2) throw new Error('Invalid PCM audio.');
    const pcm = new Int16Array(bytes.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
    this.received += pcm.length;
    const frames = this.features.push(this.resampler.push(pcm, final), final);
    for (const feature of frames) {
      await this.step(feature, true, this.fed >= 9);
      this.fed++;
    }
    if (final) {
      while (this.emitted < this.fed) await this.step(new Float32Array(345), false, true);
      this.finalized = true;
    }
    // Report only committed history. Recent, undecoded audio remains pending in
    // the transcript instead of being overwritten with provisional identities.
    const through = Math.min(this.received / 24000, this.emitted / 10);
    const from = Math.max(0, through - 60);
    this.history = this.history.filter(({ frame }) => frame / 10 >= from - 0.2);
    const segments: LocalSpeakerResult['segments'] = [];
    for (let speaker = 0; speaker < 4; speaker++) {
      let start: number | undefined;
      for (const row of this.history) {
        if (row.frame / 10 < from) continue;
        if (row.active[speaker] && start === undefined) start = row.frame / 10;
        if (!row.active[speaker] && start !== undefined) {
          segments.push({ start, end: row.frame / 10, speaker });
          start = undefined;
        }
      }
      if (start !== undefined && through > start) segments.push({ start, end: through, speaker });
    }
    return {
      from,
      through,
      segments: segments.sort((a, b) => a.start - b.start || a.speaker - b.speaker),
    };
  }
  async close() {
    for (const value of Object.values(this.state)) value.dispose();
    this.state = {};
    await this.session.release();
  }
}
