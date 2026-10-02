#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = resolve(root, '.local/cohere-venv/bin/python');
const modelPath = resolve(root, '.local/models/cohere-transcribe-mlx-4bit');
const metadata = {
  model: 'lyzgeorge/cohere-transcribe-03-2026-mlx-4bit',
  revision: 'f2f6d89b1a300c51f48ae1ecb8523dbb58636cb0',
  baseModel: 'CohereLabs/cohere-transcribe-03-2026',
  baseRevision: 'b1eacc2686a3d08ceaae5f24a88b1d519620bc09',
  runtime: 'mlx-audio 0.5.7',
  runtimeRevision: '94c7716212b2228f178d2f9c7619a591fd1b0b78',
  mlx: '0.32.3',
  quantization: '4-bit affine, group size 64; remaining tensors BF16',
  weightsSha256: '1032930782400476e56d4b852a750920ab49bd048f32eb68aeef5f651077e0a6',
};

function run(command, args) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        HF_HUB_DISABLE_TELEMETRY: '1',
        HF_HUB_DISABLE_XET: '1',
        DO_NOT_TRACK: '1',
      },
    });
    child.once('error', (error) => reject(error));
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`${command} exited with code ${code}.`)),
    );
  });
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This Cohere comparison runtime requires an Apple Silicon Mac.');
}
try {
  await run('uv', ['--version']);
} catch {
  throw new Error('Install uv first (brew install uv), then rerun npm run local:setup.');
}
await mkdir(resolve(root, '.local'), { recursive: true });
try {
  await access(python);
} catch {
  await run('uv', ['venv', '--python', '3.11', resolve(root, '.local/cohere-venv')]);
}
console.log('Installing the pinned local MLX runtime. No API key or paid service is used.');
await run('uv', [
  'pip',
  'sync',
  '--python',
  python,
  resolve(root, 'scripts/cohere-requirements.txt'),
]);
console.log('Downloading Cohere Transcribe community MLX 4-bit weights (about 1.51 GB, once).');
await run(python, [
  '-c',
  `
from huggingface_hub import snapshot_download
snapshot_download(${JSON.stringify(metadata.model)}, revision=${JSON.stringify(metadata.revision)}, local_dir=${JSON.stringify(modelPath)}, allow_patterns=["*.json", "*.safetensors", "*.model", "README.md", "LICENSE", "ATTRIBUTION.md", "demo/*.wav"], token=False)
`,
]);
console.log('Verifying the pinned weight checksum.');
const digest = createHash('sha256');
for await (const chunk of createReadStream(resolve(modelPath, 'model.safetensors')))
  digest.update(chunk);
if (digest.digest('hex') !== metadata.weightsSha256)
  throw new Error(
    'Cohere weights did not match the pinned checksum. Remove the incomplete model download and rerun setup.',
  );
// Only write the provenance marker after the complete pinned snapshot has downloaded.
await writeFile(
  resolve(modelPath, 'callside-model.json'),
  JSON.stringify(metadata, null, 2) + '\n',
);
console.log('Cohere is installed. Inference will run offline; audio stays in memory.');
