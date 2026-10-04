import { access, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
const args = process.argv.slice(2);
if (!args.includes('--test-package'))
  throw Error(
    'Use --test-package only when a shareable Windows preview has been requested. This does not create a version release.',
  );
await access('.local/windows-test-instructions.txt').catch(() =>
  copyFile('docs/windows-quick-check.txt', '.local/windows-test-instructions.txt'),
);
const hash = createHash('sha256');
for await (const chunk of createReadStream('.local/models/ggml-large-v3-turbo-q5_0.bin'))
  hash.update(chunk);
if (hash.digest('hex') !== '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2')
  throw Error('The bundled Whisper model does not match the pinned checksum.');
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
  'nsis',
  'zip',
  '--x64',
  '--publish',
  'never',
]);
