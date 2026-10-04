import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw Error('The bundled local-audio installer currently targets Apple Silicon Macs.');
const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: '14.0' };
if (!env.DEVELOPER_DIR && existsSync('/Applications/Xcode.app/Contents/Developer'))
  env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
function run(bin, args) {
  const result = spawnSync(bin, args, { env, stdio: 'inherit' });
  if (result.status !== 0)
    throw Error(bin + ' failed. Install Xcode and CMake on the build machine.');
}
const source = resolve('.local/whisper-distribution'),
  revision = '306c88f4d1286aec1bf96e544632897886af5501';
if (!existsSync(source))
  run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    'v1.9.2',
    'https://github.com/ggml-org/whisper.cpp.git',
    source,
  ]);
const head = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (head.stdout.trim() !== revision) throw Error('Unexpected whisper.cpp source revision.');
run('cmake', [
  '-S',
  source,
  '-B',
  source + '/build-callside',
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0',
  '-DCMAKE_OSX_ARCHITECTURES=arm64',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DGGML_METAL=ON',
  '-DGGML_METAL_EMBED_LIBRARY=ON',
  '-DGGML_NATIVE=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_SERVER=ON',
]);
run('cmake', [
  '--build',
  source + '/build-callside',
  '--config',
  'Release',
  '--target',
  'whisper-server',
  '-j',
  '4',
]);
await mkdir('desktop/bin', { recursive: true });
await copyFile(source + '/build-callside/bin/whisper-server', 'desktop/bin/whisper-server');
await copyFile(source + '/LICENSE', 'desktop/bin/Whisper-LICENSE');
await copyFile(source + '/LICENSE', 'desktop/bin/GGML-LICENSE');
run(process.execPath, ['scripts/local-speakers-setup.mjs']);
await writeFile(
  'desktop/bin/provenance.json',
  JSON.stringify(
    {
      platform: 'darwin',
      arch: 'arm64',
      minimumOS: '14.0',
      whisperRevision: revision,
      fluidAudioRevision: '0b1f46289fe27d95b5e66ad8be46e64f5ee02ae7',
    },
    null,
    2,
  ) + '\n',
);
