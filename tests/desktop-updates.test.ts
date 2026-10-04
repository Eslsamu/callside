import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';
const { createUpdates } = createRequire(import.meta.url)('../desktop/updates.cjs');
describe('desktop updates', () => {
  it('requires a downloaded update and an idle session before restarting', async () => {
    const updater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    });
    let idle = false;
    const updates = createUpdates(updater, {
      enabled: true,
      version: '0.6.0',
      canInstall: () => idle,
    });
    expect(() => updates.install()).toThrow('No downloaded update');
    updater.emit('update-downloaded', { version: '0.6.1' });
    expect(() => updates.install()).toThrow('Finish your call');
    idle = true;
    updates.install();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect((updater as any).autoInstallOnAppQuit).toBe(false);
    updates.close();
  });
  it('does not check from development builds and does not expose feed errors', async () => {
    const updater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    });
    const updates = createUpdates(updater, {
      enabled: false,
      version: '0.6.0',
      canInstall: () => true,
    });
    await updates.check();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    updater.emit('error', new Error('https://private.example/token-secret'));
    expect(updates.status().message).not.toContain('token-secret');
    updates.close();
  });
});
