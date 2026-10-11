import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { cpus, totalmem, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WHISPER_MODEL_NAME } from '../server/whisper-model.js';
import { startServer } from '../server/index.js';
import { StreamingResampler, floatToPcm16, encodeWav } from '../src/audio/dsp.js';

// Exercise the actual native executable and production HTTP serialization with public
// fixture audio. No microphone, credentials, cloud fallback, or model download.
const windows = process.platform === 'win32';
const root = resolve('.local/windows-preview/win-unpacked');
const binary = windows
  ? `${root}/resources/app.asar.unpacked/desktop/bin/windows/whisper-server.exe`
  : process.env.WHISPER_SERVER_BIN;
const model = windows
  ? `${root}/resources/models/ggml-small-q5_1.bin`
  : process.env.WHISPER_MODEL_PATH || '.local/models/ggml-small-q5_1.bin';
if (binary) await access(binary);
await access(model);
const wav = await readFile('public/windows-system-test.wav');
assert.equal(wav.toString('ascii', 36, 40), 'data');
assert.equal(wav.readUInt16LE(22), 1);
assert.equal(wav.readUInt16LE(34), 16);
const samples = Float32Array.from(
  { length: (wav.length - 44) / 2 },
  (_, i) => wav.readInt16LE(44 + i * 2) / 32768,
);
const pcm = floatToPcm16(new StreamingResampler(wav.readUInt32LE(24), 16000).process(samples));
const audio = Buffer.from(encodeWav(pcm, 16000)).toString('base64');
const report: Record<string, unknown> = {
  platform: process.platform,
  cpu: cpus()[0]?.model,
  cpuThreads: cpus().length,
  ramGB: Math.round(totalmem() / 1024 ** 3),
  cpuOnly: true,
  packagedRuntime: windows,
  fixture: 'public/windows-system-test.wav',
  audioMs: pcm.length / 16,
  limits:
    'Fixture inference and serialization only; not physical microphone, loopback, or OAuth verification.',
};
const requests: Array<Record<string, unknown>> = [];
report.requests = requests;
const modelDirectory = await mkdtemp(resolve(tmpdir(), 'callside-upgrade-'));
const legacyModel = resolve(modelDirectory, WHISPER_MODEL_NAME);
await writeFile(legacyModel, 'Old cached model sentinel: must never be loaded or overwritten');
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let failure: unknown;
try {
  const start = performance.now();
  server = await startServer({
    port: 0,
    apiOnly: true,
    apiKey: '',
    localModelDirectory: modelDirectory,
    localWhisperBinary: binary,
    bundledWhisperModel: resolve(model),
    providerFactory: () => {
      throw Error('Cloud access forbidden in native inference check');
    },
  });
  const bootstrap = await fetch(`${server.url}/api/bootstrap`).then((response) => response.json());
  const headers = { 'Content-Type': 'application/json', 'X-Callside-Token': bootstrap.token };
  const prepared = await fetch(`${server.url}/api/local/prepare`, { method: 'POST', headers });
  const preparation = await prepared.json();
  assert.equal(prepared.status, 200, JSON.stringify(preparation));
  assert.equal(preparation.model, 'small-q5_1');
  report.model = preparation.model;
  report.loadMs = Math.round(performance.now() - start);
  assert.equal(
    await readFile(legacyModel, 'utf8'),
    'Old cached model sentinel: must never be loaded or overwritten',
  );
  report.cachedOldModelPreserved = true;
  report.productionPreparationPath = true;
  const check = async (name: string) => {
    const start = performance.now();
    const response = await fetch(`${server!.url}/api/local/transcribe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ audio, language: 'en' }),
      signal: AbortSignal.timeout(75000),
    });
    const result = await response.json();
    requests.push({
      name,
      status: response.status,
      elapsedMs: Math.round(performance.now() - start),
      ...result,
      contentChecks: {
        currencyRecognized: /pounds/i.test(result.text || ''),
        questionRetained: /ideas/i.test(result.text || ''),
      },
    });
    assert.equal(response.status, 200, `${name}: ${result.error || 'inference failed'}`);
    // Keep the precise fixture text and content checks for qualitative review. A model's
    // known recognition error is distinct from a broken executable or empty response.
    assert.match(result.text, /actually know/i, `${name}: missing the main spoken clause`);
    assert.match(result.text, /ideas/i, `${name}: missing the final question`);
  };
  await check('cold request');
  await check('warm request');
  await Promise.all([check('concurrent microphone request'), check('concurrent system request')]);
  report.passed = true;
} catch (error) {
  failure = error;
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await server?.close();
  await rm(modelDirectory, { recursive: true, force: true });
  await mkdir('.local/windows-qa', { recursive: true });
  await writeFile(
    '.local/windows-qa/native-inference.json',
    JSON.stringify(report, null, 2) + '\n',
  );
}
console.log(JSON.stringify(report, null, 2));
if (failure) process.exitCode = 1;
