import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { startLocalWhisper } from '../server/local-whisper.js';
import { WHISPER_MODEL_NAME } from '../server/whisper-model.js';
vi.mock('../server/local-whisper.js', async (original) => ({
  ...(await original<typeof import('../server/local-whisper.js')>()),
  startLocalWhisper: vi.fn(async () => ({
    model: 'small-q5_1',
    transcribe: vi.fn(),
    close: vi.fn(),
  })),
}));
it('production preparation uses the bundled model even when an older cached model exists', async () => {
  vi.stubEnv('WHISPER_MODEL_PATH', '');
  const directory = await mkdtemp(join(tmpdir(), 'callside-upgrade-'));
  const old = join(directory, WHISPER_MODEL_NAME),
    bundled = join(directory, 'ggml-small-q5_1.bin');
  await writeFile(old, 'old large model');
  await writeFile(bundled, 'new small model');
  const server = await startServer({
    port: 0,
    apiOnly: true,
    apiKey: '',
    localModelDirectory: directory,
    bundledWhisperModel: bundled,
    localWhisperBinary: 'included-binary',
  });
  try {
    const { token } = await fetch(`${server.url}/api/bootstrap`).then((r) => r.json());
    const response = await fetch(`${server.url}/api/local/prepare`, {
      method: 'POST',
      headers: { 'X-Callside-Token': token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: 'small-q5_1' });
    expect(startLocalWhisper).toHaveBeenCalledWith(bundled, 'included-binary');
    expect(await readFile(old, 'utf8')).toBe('old large model');
    expect(
      await fetch(`${server.url}/api/local/status`, {
        headers: { 'X-Callside-Token': token },
      }).then((r) => r.json()),
    ).toMatchObject({
      message: 'Whisper ready (small-q5_1)',
      downloaded: true,
    });
  } finally {
    await server.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
