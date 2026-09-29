import { access, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { startServer } from './index.js';
import { startLocalWhisper } from './local-whisper.js';
import { encodeWav } from '../src/audio/dsp.js';

const modelName = 'ggml-large-v3-turbo-q5_0.bin';
const revision = '5359861c739e955e79d9a303bcbc70fb988958b1';
const model = resolve(process.env.WHISPER_MODEL_PATH || `.local/models/${modelName}`);
try {
  await access(model);
} catch {
  if (process.env.WHISPER_MODEL_PATH) throw new Error(`Local model not found: ${model}`);
  await mkdir(resolve('.local/models'), { recursive: true });
  console.log(
    'Downloading Whisper large-v3-turbo Q5 (574 MB). This happens once; inference stays local.',
  );
  const response = await fetch(
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/${revision}/${modelName}`,
    { signal: AbortSignal.timeout(300000) },
  );
  if (!response.ok || !response.body)
    throw new Error('Model download failed. Retry npm run local:test.');
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(`${model}.part`, { mode: 0o600 }),
    );
    await rename(`${model}.part`, model);
  } catch (error) {
    await rm(`${model}.part`, { force: true });
    throw error;
  }
}

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
