import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/defaults';
const { createTestStateStore } = createRequire(import.meta.url)('../desktop/test-state.cjs');
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'callside-checkpoint-'));
  directories.push(directory);
  const file = join(directory, 'test.json');
  return { file, store: createTestStateStore(file, DEFAULT_SETTINGS) };
}
const checkpoint = () => ({
  schemaVersion: 2,
  savedAt: '2026-10-03T00:00:00.000Z',
  checks: {
    mic: { state: 'pass', text: 'Test sentence', peak: 0.1 },
    restart: { state: 'pending' },
  },
  preferences: { output: 'speakers', model: 'gpt-6-luna' },
  notes: '',
  restartCheckpoint: {
    sessionId: 'first-process',
    nonce: 'test-nonce',
    expected: {
      language: 'de',
      captureMic: true,
      captureSystem: true,
      answerBilling: 'chatgpt',
      model: 'gpt-6-luna',
    },
    chatgptWasConnected: true,
    previousTemplate: { ...DEFAULT_SETTINGS, context: 'Prior template retained locally' },
  },
});
it('restores checkpoints from disk after recreation, preserves template backup and serializes saves', async () => {
  const { file, store } = await fixture();
  expect(await store.load()).toBe(null);
  const first = checkpoint(),
    second = { ...checkpoint(), notes: 'Latest change' };
  await Promise.all([store.save(first), store.save(second)]);
  const restored = await createTestStateStore(file, DEFAULT_SETTINGS).load();
  expect(restored).toEqual(second);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(second);
});
it('strips accidental account credentials, audio and device identifiers from persisted checks', async () => {
  const { file, store } = await fixture();
  const value: any = checkpoint();
  value.token = 'private-token';
  value.accounts = [{ email: 'private@example.com' }];
  value.checks.mic.audio = 'data:audio';
  value.checks.mic.deviceId = 'private-device';
  value.restartCheckpoint.previousTemplate.apiKey = 'private-key';
  await store.save(value);
  expect(await readFile(file, 'utf8')).not.toMatch(
    /private-token|private-key|private-device|private@example|data:audio/,
  );
});
it('rejects corrupted or oversized checkpoints without replacing the last useful result', async () => {
  const { file, store } = await fixture();
  await store.save(checkpoint());
  expect(() => store.save({ ...checkpoint(), notes: 'x'.repeat(300000) })).toThrow('too large');
  expect(() => store.save({ ...checkpoint(), schemaVersion: 999 })).toThrow('invalid');
  expect(await store.load()).toEqual(checkpoint());
  await writeFile(file, '{broken');
  await expect(createTestStateStore(file, DEFAULT_SETTINGS).load()).rejects.toThrow(
    'could not be restored',
  );
  expect(await readFile(file, 'utf8')).toBe('{broken');
});
