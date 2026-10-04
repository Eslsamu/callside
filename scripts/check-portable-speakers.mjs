// Optional actual-inference gate. Run after npm run build and
// node scripts/windows-speakers-setup.mjs. Uses only bundled, licensed test audio.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startPortableSpeakerWorker } from '../dist-server/server/local-speakers.js';

const model = resolve('.local/windows-diarization/ls_eend_ami_step.onnx');
const wav = await readFile('public/windows-speakers-test.wav');
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
let pcm;
for (let offset = 12; offset + 8 <= wav.length;) {
  const type = wav.toString('ascii', offset, offset + 4),
    length = wav.readUInt32LE(offset + 4);
  assert.ok(offset + 8 + length <= wav.length, 'WAV chunk exceeds file length');
  if (type === 'fmt ') {
    assert.equal(wav.readUInt16LE(offset + 8), 1);
    assert.equal(wav.readUInt16LE(offset + 10), 1);
    assert.equal(wav.readUInt32LE(offset + 12), 24000);
    assert.equal(wav.readUInt16LE(offset + 22), 16);
  }
  if (type === 'data') pcm = wav.subarray(offset + 8, offset + 8 + length);
  offset += 8 + length + (length % 2);
}
assert.ok(pcm?.length);
const before = performance.now();
const worker = await startPortableSpeakerWorker(model);
const loaded = performance.now();
let final;
try {
  for (let offset = 0; offset < pcm.length; offset += 192000) {
    const chunk = pcm.subarray(offset, offset + 192000);
    const result = await worker.request(chunk.toString('base64'));
    assert.ok(result.through <= (offset + chunk.length) / 48000);
    assert.ok(result.segments.every((segment) => segment.end <= result.through));
  }
  final = await worker.request(undefined, true);
  assert.equal(final.through, 50, 'The final speaker tail must be retained.');
  assert.equal(new Set(final.segments.map((segment) => segment.speaker)).size, 4);
  const dominant = (from, through) => {
    const scores = new Map();
    for (const segment of final.segments) {
      const overlap = Math.max(0, Math.min(through, segment.end) - Math.max(from, segment.start));
      scores.set(segment.speaker, (scores.get(segment.speaker) || 0) + overlap);
    }
    return [...scores].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  assert.equal(
    dominant(0, 5),
    dominant(44.6, 47.3),
    'The returning voice should retain its label.',
  );
  assert.notEqual(
    dominant(18.5, 20.5),
    dominant(26, 31),
    'Distinct long turns must have different labels.',
  );
} finally {
  worker.close();
}
await assert.rejects(worker.request(), /unavailable/);
const inferenceMs = performance.now() - loaded;
const silent = await startPortableSpeakerWorker(model);
try {
  const result = await silent.request(Buffer.alloc(192000).toString('base64'), true);
  assert.deepEqual(result.segments, [], 'Silence should not invent speakers.');
} finally {
  silent.close();
}
const cancelled = await startPortableSpeakerWorker(model);
const pending = cancelled.request(pcm.subarray(0, 192000).toString('base64'));
const rejected = assert.rejects(pending, /stopped/);
cancelled.close();
await rejected;
await assert.rejects(startPortableSpeakerWorker(model + '.missing'));
const report = {
  platform: process.platform,
  arch: process.arch,
  node: process.versions.node,
  ...(process.versions.electron ? { electron: process.versions.electron } : {}),
  checks: [
    'real four-speaker inference',
    'stable returning voice',
    'final tail',
    'silence',
    'closed-worker rejection',
    'in-flight cancellation',
    'missing model',
  ],
  fixture: 'AMI ES2004a 570–620s, CC BY 4.0',
  modelLoadMs: loaded - before,
  inferenceMs,
  audioSeconds: 50,
  speakerCount: new Set(final.segments.map((segment) => segment.speaker)).size,
  inferenceToAudioRatio: inferenceMs / 50000,
};
await writeFile(
  '.local/windows-diarization/worker-check.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
