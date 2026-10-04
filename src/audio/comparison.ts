import { concatPcm, encodeWav, floatToPcm16, rms, StreamingResampler } from './dsp';

export const MAX_COMPARISON_SECONDS = 60;
const RATE = 16000;
const MAX_SAMPLES = MAX_COMPARISON_SECONDS * RATE;

export interface ComparisonAudio {
  wav: Uint8Array;
  duration: number;
  name: string;
}

export function comparisonAudio(samples: Int16Array, name: string): ComparisonAudio {
  if (samples.length < RATE / 2) throw new Error('Record at least half a second of audio.');
  if (samples.length > MAX_SAMPLES) throw new Error('Choose audio no longer than 60 seconds.');
  return { wav: encodeWav(samples, RATE), duration: samples.length / RATE, name };
}

export function audioBase64(audio: ComparisonAudio): string {
  let binary = '';
  for (let offset = 0; offset < audio.wav.length; offset += 8192)
    binary += String.fromCharCode(...audio.wav.subarray(offset, offset + 8192));
  return btoa(binary);
}

export async function decodeComparisonFile(file: File): Promise<ComparisonAudio> {
  if (file.size > 30 * 1024 * 1024) throw new Error('Choose a WAV file smaller than 30 MB.');
  if (!/\.wav$/i.test(file.name)) throw new Error('Choose a WAV audio file.');
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (buffer.duration > MAX_COMPARISON_SECONDS)
      throw new Error('Choose audio no longer than 60 seconds.');
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < mono.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    return comparisonAudio(
      floatToPcm16(new StreamingResampler(buffer.sampleRate, RATE).process(mono)),
      file.name,
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'EncodingError')
      throw new Error('This WAV file could not be decoded. Export it as uncompressed PCM WAV.');
    throw error;
  } finally {
    await context.close();
  }
}

export interface ComparisonRecording {
  stop(): Promise<ComparisonAudio>;
  cancel(): void;
}

/** A bounded, memory-only recording. The worklet outputs silence; audio is never monitored. */
export async function recordComparisonAudio(
  deviceId: string,
  signal: AbortSignal,
  callbacks: {
    onLevel(level: number): void;
    onDuration(seconds: number): void;
    onComplete(audio: ComparisonAudio): void;
    onError(message: string): void;
  },
): Promise<ComparisonRecording> {
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let stream: MediaStream | undefined;
  let released = false;
  let stopping: Promise<ComparisonAudio> | undefined;
  let flushDone: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let samples = 0;
  const chunks: Int16Array[] = [];

  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    node?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (context && context.state !== 'closed') void context.close();
    callbacks.onLevel(0);
  };
  const cancel = () => {
    release();
    chunks.length = 0;
    flushDone?.();
  };
  const stop = () =>
    (stopping ??= (async () => {
      if (!released && node) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 250);
          flushDone = () => {
            clearTimeout(timeout);
            resolve();
          };
          node!.port.postMessage({ type: 'flush' });
        });
      }
      release();
      if (signal.aborted) throw new DOMException('Recording cancelled.', 'AbortError');
      const audio = comparisonAudio(concatPcm(chunks), 'Microphone recording');
      chunks.length = 0;
      return audio;
    })());
  const finish = () => {
    void stop()
      .then(callbacks.onComplete)
      .catch((error: unknown) => {
        if (!signal.aborted)
          callbacks.onError(error instanceof Error ? error.message : 'Could not finish recording.');
      });
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new DOMException('Recording cancelled.', 'AbortError');
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode)
      throw new Error('Open this page on localhost in a current browser to record audio.');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    // Permission prompts cannot be dismissed programmatically. Release a late grant immediately.
    if (signal.aborted || released) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException('Recording cancelled.', 'AbortError');
    }
    context = new AudioContext({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule('/pcm-worklet.js');
    if (signal.aborted || released) throw new DOMException('Recording cancelled.', 'AbortError');
    node = new AudioWorkletNode(context, 'callside-pcm', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    source = context.createMediaStreamSource(stream);
    const resampler = new StreamingResampler(context.sampleRate, RATE);
    node.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'flushed') {
        flushDone?.();
        return;
      }
      if (released || event.data?.type !== 'pcm') return;
      const pcm = floatToPcm16(resampler.process(new Float32Array(event.data.samples))).subarray(
        0,
        MAX_SAMPLES - samples,
      );
      chunks.push(pcm);
      samples += pcm.length;
      callbacks.onLevel(rms(pcm));
      callbacks.onDuration(samples / RATE);
      if (samples >= MAX_SAMPLES) finish();
    };
    stream.getTracks().forEach((track) => {
      track.onended = () => {
        cancel();
        callbacks.onError('Microphone disconnected. Choose an input and record again.');
      };
    });
    source.connect(node);
    node.connect(context.destination);
    await context.resume();
    if (signal.aborted || released) throw new DOMException('Recording cancelled.', 'AbortError');
    timer = setTimeout(finish, MAX_COMPARISON_SECONDS * 1000);
    return { stop, cancel };
  } catch (error) {
    cancel();
    if (error instanceof Error && error.name === 'NotAllowedError')
      throw new Error(
        'Microphone access was denied. Allow access in your browser or macOS settings, then try again.',
      );
    throw error;
  }
}

export async function* streamComparison<T extends { type: string }>(
  token: string,
  audio: ComparisonAudio,
  language: string,
  reference: string,
  signal: AbortSignal,
  options: { engines?: string[]; openaiKey?: string; elevenlabsKey?: string } = {},
): AsyncGenerator<T> {
  const response = await fetch('/api/comparison/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
    body: JSON.stringify({ audio: audioBase64(audio), language, reference, ...options }),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Comparison failed (${response.status}).`);
  }
  if (!response.body) throw new Error('Could not read comparison results.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const data = buffer
          .slice(0, end)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        buffer = buffer.slice(end + 2);
        if (!data) continue;
        const event = JSON.parse(data) as T;
        if (event.type === 'complete' || event.type === 'error') terminal = true;
        yield event;
      }
      if (done) break;
    }
    if (!terminal && !signal.aborted)
      throw new Error('The comparison connection was interrupted. Run the test again.');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
