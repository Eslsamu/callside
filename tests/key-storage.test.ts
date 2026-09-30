import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { startServer, type RunningServer, type ServerOptions } from '../server/index';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { Bootstrap } from '../shared/types';

type Store = NonNullable<ServerOptions['keyStore']>;
const { createKeyStore } = createRequire(import.meta.url)('../desktop/key-store.cjs') as {
  createKeyStore(file: string, encryption: ReturnType<typeof cipher>, platform?: string): Store;
};
// Real authenticated ciphertext, but no OS keychain access or real provider key.
function cipher() {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (text: string) => {
      const iv = randomBytes(12),
        encryptor = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([encryptor.update(text, 'utf8'), encryptor.final()]);
      return Buffer.concat([iv, encryptor.getAuthTag(), data]);
    }),
    decryptStringAsync: vi.fn(async (data: Buffer) => {
      const decryptor = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decryptor.setAuthTag(data.subarray(12, 28));
      return {
        result: Buffer.concat([decryptor.update(data.subarray(28)), decryptor.final()]).toString(),
        shouldReEncrypt: false,
      };
    }),
  };
}
const directories: string[] = [],
  servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'callside-key-test-'));
  directories.push(directory);
  const file = join(directory, 'openai-key.enc'),
    encryption = cipher();
  return { file, encryption, store: createKeyStore(file, encryption, 'darwin') };
}
async function server(store?: Store) {
  const running = await startServer({
    port: 0,
    apiOnly: true,
    production: true,
    apiKey: '',
    keyStore: store,
  });
  servers.push(running);
  const bootstrap = (await (await fetch(`${running.url}/api/bootstrap`)).json()) as Bootstrap;
  return {
    ...running,
    bootstrap,
    post: (payload: unknown) =>
      fetch(`${running.url}/api/key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Callside-Token': bootstrap.token,
          Origin: running.url,
        },
        body: JSON.stringify(payload),
      }),
  };
}
describe('persistent API key', () => {
  it('saves only private ciphertext, restores after a server restart, and removes it permanently', async () => {
    const f = await fixture(),
      first = await server(f.store);
    expect(first.bootstrap.hasApiKey).toBe(false);
    const key = 'sk-synthetic-key-never-used-upstream';
    expect(await (await first.post({ apiKey: key, remember: true })).json()).toMatchObject({
      hasApiKey: true,
      keyStorage: { saved: true },
    });
    expect((await readFile(f.file)).toString()).not.toContain(key);
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    await first.close();
    const second = await server(createKeyStore(f.file, f.encryption, 'darwin'));
    expect(second.bootstrap).toMatchObject({ hasApiKey: true, keyStorage: { saved: true } });
    expect(JSON.stringify(second.bootstrap)).not.toContain(key);
    expect(await (await second.post({ apiKey: '' })).json()).toMatchObject({
      hasApiKey: false,
      keyStorage: { saved: false },
    });
    await second.close();
    expect((await server(f.store)).bootstrap.hasApiKey).toBe(false);
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('session-only replacement removes the old saved key and cannot reappear on restart', async () => {
    const f = await fixture();
    await f.store.save('sk-old-synthetic-key');
    const first = await server(f.store);
    expect(
      await (await first.post({ apiKey: 'sk-session-synthetic-key', remember: false })).json(),
    ).toMatchObject({ hasApiKey: true, keyStorage: { saved: false } });
    await first.close();
    expect((await server(f.store)).bootstrap.hasApiKey).toBe(false);
  });
  it('refuses insecure Linux storage and retains the previous ciphertext on encryption failure', async () => {
    const f = await fixture();
    await f.store.save('sk-old-synthetic-key');
    const original = await readFile(f.file);
    f.encryption.getSelectedStorageBackend.mockReturnValue('basic_text');
    await expect(
      createKeyStore(f.file, f.encryption, 'linux').save('sk-new-synthetic-key'),
    ).rejects.toThrow('unavailable');
    f.encryption.encryptStringAsync.mockRejectedValue(new Error('sk-new-synthetic-key'));
    const running = await server(f.store);
    const response = await running.post({ apiKey: 'sk-new-synthetic-key', remember: true });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('sk-new');
    expect(await readFile(f.file)).toEqual(original);
  });
  it('a corrupt saved key does not prevent startup and can be removed', async () => {
    const f = await fixture();
    await writeFile(f.file, Buffer.from('corrupt ciphertext'));
    const running = await server(f.store);
    expect(running.bootstrap).toMatchObject({
      hasApiKey: false,
      keyStorage: { saved: true, error: expect.any(String) },
    });
    expect((await running.post({ apiKey: '' })).status).toBe(200);
    expect(await f.store.load()).toBeNull();
  });
  it('requires authorization and refuses browser persistence without a secure store', async () => {
    const f = await fixture(),
      running = await server(f.store);
    expect(
      (
        await fetch(`${running.url}/api/key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: 'sk-synthetic-key', remember: true }),
        })
      ).status,
    ).toBe(403);
    expect(await f.store.load()).toBeNull();
    const browser = await server();
    expect((await browser.post({ apiKey: 'sk-synthetic-key', remember: true })).status).toBe(400);
  });
});
