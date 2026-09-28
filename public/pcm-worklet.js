/* This worklet only downmixes and batches audio. Resampling and VAD live in tested TypeScript. */
class CallsidePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batchSize = Math.max(128, Math.round(sampleRate / 20));
    this.buffer = new Float32Array(this.batchSize);
    this.offset = 0;
    this.firstFrame = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'flush') {
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  flush() {
    if (!this.offset) return;
    const samples = this.buffer.slice(0, this.offset);
    this.port.postMessage({ type: 'pcm', samples: samples.buffer, startFrame: this.firstFrame }, [
      samples.buffer,
    ]);
    this.offset = 0;
  }
  process(inputs, outputs) {
    // Connect to the output to keep the processor running, but never play captured audio.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame++) {
      if (this.offset === 0) this.firstFrame = currentFrame + frame;
      let sample = 0;
      for (const channel of channels) sample += channel[frame] || 0;
      this.buffer[this.offset++] = sample / channels.length;
      if (this.offset === this.batchSize) this.flush();
    }
    return true;
  }
}
registerProcessor('callside-pcm', CallsidePcmProcessor);
