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
  const captureConfig = await app.evaluate(({ app, systemPreferences }) => ({
    platform: process.platform,
    disabledFeatures: app.commandLine.getSwitchValue('disable-features'),
    nativeAudio: process.argv.includes('--native-audio'),
    screenPermission:
      process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('screen')
        : 'not-applicable',
  }));
  if (captureConfig.platform === 'darwin')
    expect(captureConfig.disabledFeatures.includes('MacCatapLoopbackAudioForScreenShare')).toBe(
      !captureConfig.nativeAudio,
    );
  console.log('Desktop capture configuration:', captureConfig);
  expect(
    await app.evaluate(({ safeStorage }) => ({
      encrypt: typeof safeStorage.encryptStringAsync,
      decrypt: typeof safeStorage.decryptStringAsync,
    })),
  ).toEqual({ encrypt: 'function', decrypt: 'function' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Remember API key on this device')).toBeChecked();
  await expect(page.getByLabel('Identify call speakers in the background')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Save API key', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Workshop', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Automatic trigger source', exact: true }),
  ).toHaveValue('either');
  await expect(page.getByRole('combobox', { name: 'Output token limit', exact: true })).toHaveValue(
    'model',
  );
  await expect(page.getByLabel('Task instructions', { exact: true })).toHaveValue(
    /Participants may move between topics/,
  );
  if (process.env.CALLSIDE_SMOKE_SCREENSHOT) {
    await page
      .locator('.prompt-settings')
      .screenshot({ path: process.env.CALLSIDE_SMOKE_SCREENSHOT });
  }
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.getByLabel('Command', { exact: true })).not.toBeVisible();
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
  await expect(page.getByRole('button', { name: /^Help now/ })).toBeEnabled();
  if (process.env.CALLSIDE_SMOKE_CONTROLS_SCREENSHOT) {
    await page
      .locator('.answer-controls')
      .screenshot({ path: process.env.CALLSIDE_SMOKE_CONTROLS_SCREENSHOT });
  }
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
