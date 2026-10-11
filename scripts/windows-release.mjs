import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { ensureWindowsModel } from './windows-model.mjs';

const args = process.argv.slice(2);
const version = args[args.indexOf('--version') + 1];
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (!args.includes('--version') || version !== manifest.version) {
  throw Error('Pass --version matching package.json for an explicitly approved Windows release.');
}
if (process.platform !== 'win32') throw Error('Build public Windows installers on Windows.');
// Validate signing before building or downloading runtimes. Never silently emit
// an unsigned installer when credentials are missing.
createRequire(import.meta.url)('./windows-release.cjs');
const existing = await readdir('.local/windows-release').catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
if (existing.some((name) => /\.(exe|zip|yml|blockmap)$/i.test(name))) {
  throw Error(
    'Windows release output already contains artifacts. Use a fresh checkout; never overwrite a distributed build.',
  );
}
const run = (command, argv) => execFileSync(command, argv, { stdio: 'inherit' });
await ensureWindowsModel();
run(process.execPath, ['scripts/windows-runtimes.mjs']);
run(process.execPath, ['scripts/windows-speakers-setup.mjs']);
// Use Node entrypoints so no secret or user-provided argument crosses a shell.
run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json']);
run(process.execPath, [
  'node_modules/electron-builder/cli.js',
  '--config',
  'scripts/windows-release.cjs',
  '--win',
  'nsis',
  'zip',
  '--x64',
  '--publish',
  'never',
]);
run('pwsh', [
  '-NoProfile',
  '-File',
  'scripts/windows-verify-signatures.ps1',
  '-PackageDirectory',
  '.local/windows-release',
  '-Version',
  version,
  '-Publisher',
  process.env.WINDOWS_PUBLISHER_NAME,
]);
