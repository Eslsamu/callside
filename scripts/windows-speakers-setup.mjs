import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Public MIT model; no authentication or paid API. Model downloads happen during
// packaging, never on the tester's machine or during a call.
const revision = 'cc40a1e1242c148fbbc15c132e43b8ac15056e53';
const root = resolve('.local/windows-diarization');
const files = {
  'ls_eend_ami_step.onnx': '5a2b813ffe41170e40d0fc08a6eb1699e579e377af30c7962d07885608a6aa77',
  'ls_eend_ami_step.json': '47f29718254995ec017636d5ff31fef8b20bf47dca30d883edcb91e022dc3353',
};
await mkdir(root, { recursive: true });
for (const [name, expected] of Object.entries(files)) {
  const file = resolve(root, name);
  const valid = (bytes) => createHash('sha256').update(bytes).digest('hex') === expected;
  try {
    if (valid(await readFile(file))) continue;
  } catch {
    /* First preparation. */
  }
  const response = await fetch(
    `https://huggingface.co/GradientDescent2718/LS-EEND-ONNX/resolve/${revision}/AMI/${name}`,
    { signal: AbortSignal.timeout(180000) },
  );
  if (!response.ok) throw new Error(`Speaker model download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes)) throw new Error(`Speaker model checksum failed: ${name}.`);
  const temp = file + '.download';
  await writeFile(temp, bytes);
  try {
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
for (const name of ['LS-EEND-LICENSE.txt', 'README.md', 'frontend-NOTICE.txt']) {
  await copyFile(resolve('native/windows/diarization', name), resolve(root, name));
}
await writeFile(
  resolve(root, 'provenance.json'),
  JSON.stringify(
    {
      model: 'LS-EEND AMI',
      repository: 'GradientDescent2718/LS-EEND-ONNX',
      revision,
      files,
      runtime: 'onnxruntime-web 1.30.0, CPU WASM, one worker thread',
      maxSpeakers: 4,
      networkInference: false,
      license: 'MIT',
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Portable speaker model verified. All inference stays local; no tester setup is required.',
);
