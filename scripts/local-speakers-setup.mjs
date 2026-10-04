import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, copyFile, chmod, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
if (process.platform !== 'darwin')
  throw new Error('Local LS-EEND currently requires macOS 14+ on Apple Silicon.');
const env = { ...process.env };
// Do not change the user's system-wide Xcode selection.
if (!env.DEVELOPER_DIR && existsSync('/Applications/Xcode.app/Contents/Developer'))
  env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
const args = [
  'build',
  '--package-path',
  'native/diarization',
  '-c',
  'release',
  '--product',
  'CallsideDiarizer',
  '-j',
  '4',
];
const build = spawnSync('swift', args, { env, stdio: 'inherit' });
if (build.status !== 0)
  throw new Error(
    'Install Xcode / Swift development tools and retry npm run local:speakers:setup.',
  );
const directory = resolve('desktop/bin');
await mkdir(directory, { recursive: true });
const target = resolve(directory, 'callside-diarizer');
await copyFile('native/diarization/.build/release/CallsideDiarizer', target);
await chmod(target, 0o755);
await rm(resolve(directory, 'FluidAudio-LICENSE'), { force: true });
await copyFile(
  'native/diarization/.build/checkouts/FluidAudio/LICENSE',
  resolve(directory, 'FluidAudio-LICENSE'),
);
console.log(
  'Local speaker runtime ready. Model weights download once on first use; call audio stays local.',
);
