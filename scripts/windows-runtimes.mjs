import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, copyFile, writeFile, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
const env = { ...process.env };
if (
  process.platform === 'darwin' &&
  !env.DEVELOPER_DIR &&
  existsSync('/Applications/Xcode.app/Contents/Developer')
)
  env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { env, stdio: 'inherit' });
  if (r.status !== 0) throw Error(cmd + ' failed while building the Windows runtime.');
};
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
if (
  spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() !==
  revision
)
  throw Error('Unexpected whisper.cpp revision.');
const native = process.platform === 'win32';
const build = source + (native ? '/build-windows-msvc' : '/build-windows');
run('cmake', [
  '-S',
  source,
  '-B',
  build,
  ...(native
    ? ['-A', 'x64', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded']
    : ['-DCMAKE_TOOLCHAIN_FILE=' + resolve('native/windows/mingw.cmake')]),
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DGGML_NATIVE=OFF',
  '-DGGML_METAL=OFF',
  '-DGGML_OPENMP=OFF',
  '-DGGML_AVX=ON',
  '-DGGML_AVX2=ON',
  '-DGGML_FMA=ON',
  '-DGGML_F16C=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_SERVER=ON',
]);
run('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-server', '-j', '4']);
await mkdir('desktop/bin/windows', { recursive: true });
await copyFile(
  build + (native ? '/bin/Release/whisper-server.exe' : '/bin/whisper-server.exe'),
  'desktop/bin/windows/whisper-server.exe',
);
await copyFile(source + '/LICENSE', 'desktop/bin/windows/Whisper-GGML-LICENSE');
await copyFile('desktop/THIRD_PARTY_NOTICES.txt', 'desktop/bin/windows/THIRD_PARTY_NOTICES.txt');
await writeFile(
  'desktop/bin/windows/provenance.json',
  JSON.stringify(
    {
      revision,
      arch: 'x64',
      cpuRequirement: 'AVX2/FMA/F16C',
      runtime: native ? 'MSVC static' : 'MinGW static',
      component: 'Whisper transcription only; speaker runtime is bundled separately',
    },
    null,
    2,
  ),
);

if (!native)
  await cp('native/windows/licenses', 'desktop/bin/windows/licenses', { recursive: true });
