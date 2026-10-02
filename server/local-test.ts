import { startServer } from './index.js';
import { startLocalWhisper } from './local-whisper.js';
import { ensureWhisperModel } from './whisper-model.js';
import { encodeWav } from '../src/audio/dsp.js';

const model = await ensureWhisperModel();

console.log('Loading local Whisper and warming the GPU. No microphone is active.');
const engine = await startLocalWhisper(model);
let running: Awaited<ReturnType<typeof startServer>> | undefined;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await running?.close();
  await engine.close();
}
process.once('SIGINT', () => {
  void close().then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
try {
  await engine.transcribe(
    encodeWav(new Int16Array(16000), 16000),
    'de',
    AbortSignal.timeout(30000),
  );
  const port = Number(process.env.LOCAL_TEST_PORT ?? 4320);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid LOCAL_TEST_PORT.');
  running = await startServer({
    port,
    apiKey: '',
    localEngine: engine,
    production: process.env.NODE_ENV === 'production',
  });
  console.log(`Local microphone test is ready: ${running.url}/local-test`);
  console.log(
    'Click Start microphone in the page. Audio is processed in memory; only timing measurements are retained locally until exit.',
  );
} catch (error) {
  await close();
  throw error;
}
