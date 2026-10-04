import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { ensureWhisperModel } from '../server/whisper-model';
it('reports progress and rejects an incomplete model without leaving a usable cache file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'callside-model-test-'));
  const progress: any[] = [];
  vi.stubEnv('WHISPER_MODEL_PATH', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('invalid model', { headers: { 'content-length': '13' } })),
  );
  try {
    await expect(ensureWhisperModel(directory, (p) => progress.push(p))).rejects.toThrow(
      'verification failed',
    );
    expect(progress.some((p) => p.phase === 'downloading' && p.percent === 100)).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
