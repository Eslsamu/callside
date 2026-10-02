import { startServer } from './index.js';
import { startLocalWhisper } from './local-whisper.js';
import { startLocalCohere } from './local-cohere.js';
import { ensureWhisperModel, WHISPER_MODEL_REVISION } from './whisper-model.js';
import { encodeWav } from '../src/audio/dsp.js';

let whisper: Awaited<ReturnType<typeof startLocalWhisper>> | undefined;
let cohere: Awaited<ReturnType<typeof startLocalCohere>> | undefined;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server?.close();
  await Promise.allSettled([whisper?.close(), cohere?.close()]);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void close().then(() => process.exit(0));
  });
try {
  const modelPath = await ensureWhisperModel();
  console.log(
    'Loading local models. No microphone is active and no audio is sent to a cloud service.',
  );
  whisper = await startLocalWhisper(modelPath);
  whisper.details = {
    runtime: 'whisper.cpp / Metal on supported macOS',
    modelRevision: process.env.WHISPER_MODEL_PATH ? 'custom model path' : WHISPER_MODEL_REVISION,
    quantization: process.env.WHISPER_MODEL_PATH ? 'custom model' : 'Q5_0',
    decoding: 'greedy, temperature 0, no fallback',
  };
  cohere = await startLocalCohere();
  if (closing) throw new Error('Comparison startup cancelled.');
  console.log('Warming both local models before measuring.');
  const silence = encodeWav(new Int16Array(16000), 16000);
  await whisper.transcribe(silence, 'en', AbortSignal.timeout(120000));
  await cohere.transcribe(silence, 'en', AbortSignal.timeout(120000));
  const port = Number(process.env.LOCAL_COMPARE_PORT ?? 4321);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid LOCAL_COMPARE_PORT.');
  server = await startServer({
    port,
    apiKey: '',
    comparisonEngines: { whisper, cohere },
    production: process.env.NODE_ENV === 'production',
  });
  console.log(`Cohere vs Whisper test ready: ${server.url}/local-compare`);
  console.log(
    'Record once, stop, then compare the same recording. Keep this process running. Ctrl+C unloads both models.',
  );
} catch (error) {
  await close();
  throw error;
}
