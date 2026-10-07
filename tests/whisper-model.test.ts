import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  ensureWhisperModel,
  hasWhisperModel,
  WHISPER_MODEL_NAME,
} from '../server/whisper-model.js';

it('reuses a previously downloaded model across preparations without network access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'callside-model-reuse-'));
  const network = vi.fn(() => {
    throw new Error('Unexpected model download');
  });
  vi.stubEnv('WHISPER_MODEL_PATH', '');
  vi.stubGlobal('fetch', network);
  try {
    expect(await hasWhisperModel(directory)).toBe(false);
    const file = join(directory, WHISPER_MODEL_NAME);
    await writeFile(file, 'existing model fixture');
    expect(await hasWhisperModel(directory)).toBe(true);
    expect(await ensureWhisperModel(directory)).toBe(file);
    expect(await ensureWhisperModel(directory)).toBe(file);
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
