import type { LocalMeasurement, LocalTranscription } from '../../shared/local-test.js';
import {
  concatPcm,
  encodeWav,
  floatToPcm16,
  rms,
  StreamingResampler,
  VoiceActivityDetector,
} from './dsp.js';

interface Job {
  id: string;
  audio: Int16Array;
  final: boolean;
  startedAt: number;
  speechAt: number;
  queuedAt: number;
}
export interface LocalTurn {
  id: string;
  text: string;
  final: boolean;
  measurement?: LocalMeasurement;
}
interface Callbacks {
  onTurn(turn: LocalTurn): void;
  onLevel(level: number): void;
  onStatus(status: string): void;
  onError(message: string): void;
}
type Transcribe = (audio: Int16Array, signal: AbortSignal) => Promise<LocalTranscription>;

/** Re-decode the current utterance, replacing its draft. Serialize GPU work and
 * coalesce stale drafts; final utterances are never silently dropped. */
export class LocalSpeechPipeline {
  private readonly vad = new VoiceActivityDetector({
    sampleRate: 16000,
    silenceMs: 500,
    maxTurnMs: 12000,
  });
  private chunks: Int16Array[] = [];
  private size = 0;
  private current?: { id: string; startedAt: number; speechAt: number };
  private lastDraft = 0;
  private sequence = 0;
  private queue: Job[] = [];
  private busy = false;
  private ended = false;
  private firstText = new Map<string, number>();
  private abort = new AbortController();
  private drained: (() => void)[] = [];

  constructor(
    private transcribe: Transcribe,
    private callbacks: Callbacks,
    private now = () => performance.now(),
  ) {}

  feed(samples: Int16Array) {
    if (this.ended) return;
    const level = rms(samples);
    this.callbacks.onLevel(level);
    const now = this.now();
    const activity = this.vad.feed(samples);
    if (activity.startedAtSample !== undefined) {
      const audioMs = activity.audio.reduce((n, part) => n + part.length, 0) / 16;
      this.current = { id: `turn-${++this.sequence}`, startedAt: now - audioMs, speechAt: now };
      this.lastDraft = now;
      this.callbacks.onStatus('Listening');
    }
    if (!this.current) return;
    if (level >= 0.008) this.current.speechAt = now;
    this.chunks.push(...activity.audio);
    this.size += activity.audio.reduce((n, part) => n + part.length, 0);
    if (activity.commit) this.commit();
    else if (this.size >= 19200 && now - this.lastDraft >= 800) this.enqueue(false);
  }

  private enqueue(final: boolean) {
    if (!this.current || !this.size) return;
    const queuedAt = this.now();
    const job: Job = { ...this.current, audio: concatPcm(this.chunks), final, queuedAt };
    this.lastDraft = queuedAt;
    this.queue = this.queue.filter((item) => item.id !== job.id);
    // Final turns take priority over drafts. The queue is bounded without hiding lost speech.
    if (final) {
      const draft = this.queue.findIndex((item) => !item.final);
      this.queue.splice(draft < 0 ? this.queue.length : draft, 0, job);
    } else this.queue.push(job);
    if (this.queue.filter((item) => item.final).length > 4) {
      this.fail(
        'Whisper cannot keep up on this device. Recording stopped. Try a smaller local model.',
      );
      return;
    }
    void this.pump();
  }

  private commit() {
    this.enqueue(true);
    this.chunks = [];
    this.size = 0;
    this.current = undefined;
  }

  private async pump() {
    if (this.busy || this.abort.signal.aborted) return;
    const job = this.queue.shift();
    if (!job) {
      this.drained.splice(0).forEach((done) => done());
      return;
    }
    this.busy = true;
    const requestedAt = this.now();
    // While the GPU was occupied, more speech may have arrived. Decode the newest
    // available draft instead of starting work on a stale snapshot.
    if (!job.final && this.current?.id === job.id) {
      job.audio = concatPcm(this.chunks);
      job.speechAt = this.current.speechAt;
      job.queuedAt = requestedAt;
      this.lastDraft = requestedAt;
    }
    this.callbacks.onStatus(job.final ? 'Finalizing a phrase' : 'Updating live text');
    try {
      const result = await this.transcribe(job.audio, this.abort.signal);
      if (this.abort.signal.aborted) return;
      const displayedAt = this.now();
      const text = result.text.trim();
      let measurement: LocalMeasurement | undefined;
      if (text) {
        if (!this.firstText.has(job.id)) this.firstText.set(job.id, displayedAt - job.startedAt);
        measurement = {
          turnId: job.id,
          final: job.final,
          audioMs: job.audio.length / 16,
          processingMs: result.processingMs,
          requestMs: displayedAt - requestedAt,
          queueMs: requestedAt - job.queuedAt,
          speechToTextMs: displayedAt - job.speechAt,
          firstTextMs: this.firstText.get(job.id)!,
        };
      }
      this.callbacks.onTurn({ id: job.id, text, final: job.final, measurement });
      if (job.final) this.firstText.delete(job.id);
    } catch (error) {
      if (!this.abort.signal.aborted)
        this.fail(error instanceof Error ? error.message : 'Local transcription failed.');
    } finally {
      this.busy = false;
      if (this.queue.length && !this.abort.signal.aborted) void this.pump();
      else {
        this.callbacks.onStatus(this.ended ? 'Stopped' : 'Listening');
        this.drained.splice(0).forEach((done) => done());
      }
    }
  }

  private fail(message: string) {
    this.cancel();
    this.callbacks.onError(message);
  }

  async finish() {
    if (!this.ended) {
      this.ended = true;
      if (this.vad.flush()) this.commit();
    }
    if (this.busy || this.queue.length) await new Promise<void>((done) => this.drained.push(done));
  }

  cancel() {
    this.ended = true;
    this.abort.abort();
    this.queue = [];
    this.chunks = [];
    this.current = undefined;
    this.drained.splice(0).forEach((done) => done());
  }
}

export interface LocalCapture {
  stop(): Promise<void>;
  cancel(): void;
}

export async function startLocalCapture(
  token: string,
  language: string,
  deviceId: string,
  callbacks: Callbacks,
): Promise<LocalCapture> {
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let stream: MediaStream | undefined;
  let stopping: Promise<void> | undefined;
  let flushDone: (() => void) | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    node?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (context && context.state !== 'closed') void context.close();
    callbacks.onLevel(0);
  };
  const pipeline = new LocalSpeechPipeline(
    async (samples, signal) => {
      const wav = encodeWav(samples, 16000);
      let binary = '';
      for (let offset = 0; offset < wav.length; offset += 8192)
        binary += String.fromCharCode(...wav.subarray(offset, offset + 8192));
      const response = await fetch('/api/local-test/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
        body: JSON.stringify({ audio: btoa(binary), language }),
        signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Local transcription failed.');
      return result as LocalTranscription;
    },
    {
      ...callbacks,
      onError: (message) => {
        release();
        callbacks.onError(message);
      },
    },
  );
  const stop = () =>
    (stopping ??= (async () => {
      if (!released && node)
        await new Promise<void>((done) => {
          const timer = setTimeout(done, 300);
          flushDone = () => {
            clearTimeout(timer);
            done();
          };
          node!.port.postMessage({ type: 'flush' });
        });
      release();
      await pipeline.finish();
    })());
  const cancel = () => {
    pipeline.cancel();
    release();
    flushDone?.();
  };
  try {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode)
      throw new Error('Open this page in a current browser on localhost to use the microphone.');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    context = new AudioContext({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule('/pcm-worklet.js');
    node = new AudioWorkletNode(context, 'callside-pcm', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    source = context.createMediaStreamSource(stream);
    const resampler = new StreamingResampler(context.sampleRate, 16000);
    node.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'flushed') {
        flushDone?.();
        return;
      }
      if (!released && event.data?.type === 'pcm')
        pipeline.feed(floatToPcm16(resampler.process(new Float32Array(event.data.samples))));
    };
    stream.getTracks().forEach((track) => {
      track.onended = () => {
        pipeline.cancel();
        release();
        callbacks.onError('Microphone disconnected. Choose an input and start again.');
      };
    });
    source.connect(node);
    node.connect(context.destination);
    await context.resume();
    callbacks.onStatus('Listening');
    return { stop, cancel };
  } catch (error) {
    cancel();
    if (error instanceof Error && error.name === 'NotAllowedError')
      throw new Error(
        'Microphone access was denied. Allow it in your browser and macOS settings, then start again.',
      );
    throw error;
  }
}
