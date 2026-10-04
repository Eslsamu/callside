import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const community = args.includes('--community');
if (community && args.includes('--public'))
  throw Error('Choose either a community build or a notarized build.');
const index = args.indexOf('--version');
const version = index >= 0 ? args[index + 1] : undefined;
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
  throw Error(
    'Installer builds require an explicit release version: npm run desktop:dist -- --version 0.6.1. For development use npm run desktop or npm run desktop:pack.',
  );
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (manifest.version !== version)
  throw Error(
    `Requested version ${version} differs from package.json (${manifest.version}). Bump the version only when preparing an approved release.`,
  );
const directory = resolve('release', `v${version}`);
const files = await readdir(directory).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
if (files.some((file) => /\.(dmg|zip|exe|AppImage)$/.test(file)))
  throw Error(
    `Release ${version} already has distribution artifacts. Do not overwrite an existing release; use a new version.`,
  );
const env = { ...process.env };
if (community) {
  for (const name of Object.keys(env)) {
    if (name.startsWith('CSC_') || name.startsWith('APPLE_')) delete env[name];
  }
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}
const run = (command, argv) => execFileSync(command, argv, { stdio: 'inherit', env });
if (args.includes('--public')) run(process.execPath, ['scripts/release-preflight.mjs']);
run('npm', ['run', 'desktop:runtimes']);
run('npm', ['run', 'build']);
run('npx', [
  '--no-install',
  'electron-builder',
  ...(community ? ['--config', 'scripts/community-build.cjs'] : []),
  '--mac',
  '--arm64',
  '--publish',
  'never',
]);
