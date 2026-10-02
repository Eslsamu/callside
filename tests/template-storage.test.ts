import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { Settings } from '../shared/types';

const { createTemplateStore } = createRequire(import.meta.url)('../desktop/template-store.cjs') as {
  createTemplateStore(
    file: string,
    defaults: Settings,
  ): {
    load(): Promise<Settings | null>;
    save(settings: unknown): Promise<void>;
    remove(): Promise<void>;
  };
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'callside-template-test-'));
  directories.push(directory);
  const file = join(directory, 'template.json');
  return { file, store: createTemplateStore(file, DEFAULT_SETTINGS) };
}

it('restores a long template from permanent storage, excludes other state, and resets it', async () => {
  const { file, store } = await fixture();
  expect(await store.load()).toBeNull();
  const saved = { ...DEFAULT_SETTINGS, context: 'Course facts. '.repeat(3000) };
  await store.save({ ...saved, apiKey: 'sk-synthetic-secret', transcript: ['private transcript'] });
  const reopened = createTemplateStore(file, DEFAULT_SETTINGS);
  expect(await reopened.load()).toEqual(saved);
  const raw = await readFile(file, 'utf8');
  expect(raw).not.toMatch(/sk-synthetic|private transcript|apiKey/);
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  await reopened.remove();
  expect(await createTemplateStore(file, DEFAULT_SETTINGS).load()).toBeNull();
});

it('preserves the last good template if a new save is invalid or too large', async () => {
  const { file, store } = await fixture();
  await store.save(DEFAULT_SETTINGS);
  const original = await readFile(file, 'utf8');
  await expect(store.save({ ...DEFAULT_SETTINGS, context: {} })).rejects.toThrow('Invalid');
  await expect(store.save({ ...DEFAULT_SETTINGS, autoCooldownMs: NaN })).rejects.toThrow('Invalid');
  await expect(store.save({ ...DEFAULT_SETTINGS, context: 'x'.repeat(1_000_001) })).rejects.toThrow(
    'too large',
  );
  expect(await readFile(file, 'utf8')).toBe(original);
});

it('reports corrupt storage without exposing or changing its contents', async () => {
  const { file, store } = await fixture();
  await writeFile(file, '{private broken data');
  await expect(store.load()).rejects.toThrow('The saved template is unreadable.');
  expect(await readFile(file, 'utf8')).toBe('{private broken data');
});
