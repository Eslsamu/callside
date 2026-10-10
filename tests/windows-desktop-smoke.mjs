import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../dist-server/shared/defaults.js';

// Hidden Electron instances, no device access, OS credential prompt, or upstream calls.
const profile = await mkdtemp(join(tmpdir(), 'callside-windows-desktop-'));
async function launch() {
  const instance = await electron.launch({
    args: ['.', '--smoke-test', `--user-data-dir=${profile}`],
    env: { ...process.env, OPENAI_API_KEY: '' },
  });
  await instance.evaluate(({ safeStorage }) => {
    // Validate the real IPC/persistence flow without touching the host's keychain.
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    safeStorage.encryptStringAsync = async (value) => Buffer.from('test-only:' + value);
    safeStorage.decryptStringAsync = async (value) => ({
      result: value.toString().slice(10),
      shouldReEncrypt: false,
    });
  });
  const page = await instance.firstWindow();
  await page.goto(new URL('/windows-check', page.url()).href);
  await expect(page.getByRole('heading', { name: 'Windows guided test' })).toBeVisible();
  return { instance, page };
}
let current;
try {
  current = await launch();
  const { page, instance } = current;
  expect(
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
  ).toBe(false);
  await expect
    .poll(() => page.evaluate(() => window.callsideDesktop.loadTestState()))
    .not.toBeNull();
  const first = await page.evaluate(() => window.callsideDesktop.getTestDiagnostics());
  expect(first.secureStorage).toBe(true);
  expect(first.secureStorageRestart).toBe(null);
  const previous = { ...DEFAULT_SETTINGS, context: 'Previous private context never exported' };
  const expected = {
    language: 'de',
    captureMic: true,
    captureSystem: true,
    answerBilling: 'chatgpt',
    model: 'gpt-6-luna',
  };
  const checkpoint = {
    schemaVersion: 2,
    savedAt: new Date().toISOString(),
    buildId: first.buildId || 'development',
    checks: {
      mic: { state: 'pass', text: 'Synthetic test', message: 'Confirmed' },
      restart: { state: 'running', message: 'Awaiting app restart.' },
    },
    preferences: { output: 'speakers', model: 'gpt-6-luna' },
    notes: 'Native restart test',
    restartCheckpoint: {
      sessionId: first.sessionId,
      nonce: 'restart-sentinel',
      expected,
      chatgptWasConnected: false,
      previousTemplate: previous,
    },
  };
  await page.evaluate(
    async ({ checkpoint, settings }) => {
      await window.callsideDesktop.saveTemplate(settings);
      await window.callsideDesktop.saveTestState(checkpoint);
      await window.callsideDesktop.setSessionActive(true);
      let rejected = false;
      try {
        await window.callsideDesktop.relaunchTest();
      } catch {
        rejected = true;
      }
      if (!rejected) throw Error('Active test was allowed to restart');
      await window.callsideDesktop.setSessionActive(false);
    },
    { checkpoint, settings: { ...DEFAULT_SETTINGS, ...expected, context: 'restart-sentinel' } },
  );
  await instance.close();
  current = await launch();
  const second = await current.page.evaluate(() => window.callsideDesktop.getTestDiagnostics());
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(second.secureStorageRestart).toBe(true);
  await expect(
    current.page.getByText(
      'The app restarted. Saved settings and encrypted storage survived. Previous settings were restored.',
    ),
  ).toBeVisible();
  expect(await current.page.evaluate(() => window.callsideDesktop.loadTemplate())).toEqual(
    previous,
  );
  const reportPath = join(profile, 'exported-report.json');
  await current.instance.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, reportPath);
  await current.page.getByRole('button', { name: 'Download test report', exact: true }).click();
  await expect(current.page.getByText('Report saved. Send the JSON file back.')).toBeVisible();
  const result = JSON.parse(await readFile(reportPath, 'utf8'));
  expect(result.checks.mic.state).toBe('pass');
  expect(result.checks.restart).toMatchObject({
    state: 'pass',
    settingsMatch: true,
    secureStoragePersisted: true,
  });
  expect(JSON.stringify(result)).not.toContain(previous.context);
  await current.page.goto(new URL('/', current.page.url()).href);
  expect(
    await current.page.evaluate(async () => {
      try {
        await window.callsideDesktop.loadTestState();
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  console.log(
    'Hidden Electron check passed: guarded IPC, process restart, persisted checkpoints/settings/storage, template restoration, clean report. Encryption mocked; Windows hardware remains untested.',
  );
} finally {
  await current?.instance.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
