import { access, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { ensureWindowsModel } from './windows-model.mjs';
const args = process.argv.slice(2);
const checkOnly = args.includes('--check-only');
if (!checkOnly && !args.includes('--test-package'))
  throw Error(
    'Use --test-package only when a shareable Windows preview has been requested. This does not create a version release.',
  );
await ensureWindowsModel();
await access('.local/windows-test-instructions.txt').catch(() =>
  copyFile('docs/windows-quick-check.txt', '.local/windows-test-instructions.txt'),
);
const env = { ...process.env, CALLSIDE_PREVIEW_ID: new Date().toISOString().replace(/[:.]/g, '-') };
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw Error(cmd + ' failed.');
};
run('node', ['scripts/windows-runtimes.mjs']);
run('node', ['scripts/windows-speakers-setup.mjs']);
run('npm', ['run', 'build']);
run('npx', [
  '--no-install',
  'electron-builder',
  '--config',
  'scripts/windows-preview.cjs',
  '--win',
  ...(checkOnly ? ['--dir'] : ['nsis', 'zip']),
  '--x64',
  '--publish',
  'never',
]);
