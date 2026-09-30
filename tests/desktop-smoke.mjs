import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This deliberately avoids the user's foreground, keys, devices, and real API access.
const profile = await mkdtemp(join(tmpdir(), 'callside-smoke-'));
const args = ['.', '--smoke-test', `--user-data-dir=${profile}`];
const app = await electron.launch({
  ...(process.env.CALLSIDE_EXECUTABLE
    ? { executablePath: process.env.CALLSIDE_EXECUTABLE, args: args.slice(1) }
    : { args }),
  env: { ...process.env, OPENAI_API_KEY: '' },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('button', { name: 'Try demo', exact: true })).toBeEnabled();
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
  ).toBe(false);
  const captureConfig = await app.evaluate(({ app }) => ({
    platform: process.platform,
    packaged: app.isPackaged,
    disabledFeatures: app.commandLine.getSwitchValue('disable-features'),
  }));
  if (captureConfig.platform === 'darwin')
    expect(captureConfig.disabledFeatures.includes('MacCatapLoopbackAudioForScreenShare')).toBe(
      !captureConfig.packaged,
    );
  expect(await page.evaluate(() => typeof window.callsideDesktop?.onAnswer)).toBe('function');
  expect(await page.evaluate(() => window.callsideDesktop.getShortcutStatus())).toEqual([
    { accelerator: 'F8', registered: false },
    { accelerator: 'CommandOrControl+Shift+Space', registered: false },
  ]);
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await expect(page.getByTestId('transcript-entry').nth(4)).toBeVisible();
  // Exercise the exact IPC event issued by a registered native global shortcut.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('callside:answer'),
  );
  await expect(page.getByTestId('suggestion')).toContainText('Demo suggestion');
  await expect(page.getByRole('button', { name: /^Suggest answer/ })).toBeEnabled();
  await page.evaluate(() => window.callsideDesktop.setAlwaysOnTop(true));
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()),
  ).toBe(true);
  await page.evaluate(() => window.callsideDesktop.setAlwaysOnTop(false));
  expect(errors).toEqual([]);
  console.log(
    'Desktop smoke passed: hidden production window, preload IPC, demo, answer shortcut event, always-on-top.',
  );
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
