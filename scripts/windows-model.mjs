import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const WINDOWS_WHISPER_MODEL = 'ggml-small-q5_1.bin';
const revision = '5359861c739e955e79d9a303bcbc70fb988958b1';
const digest = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb';
export async function ensureWindowsModel() {
  const target = `.local/models/${WINDOWS_WHISPER_MODEL}`;
  await mkdir('.local/models', { recursive: true });
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    if (hash.digest('hex') === digest) return target;
    throw Error('Existing Windows model checksum mismatch. Remove it and retry.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/${revision}/${WINDOWS_WHISPER_MODEL}`,
    { signal: AbortSignal.timeout(300000) },
  );
  if (!response.ok || !response.body) throw Error('Windows model download failed.');
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, encoding, done) {
          size += chunk.length;
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(`${target}.part`),
    );
    if (size !== 190085487 || hash.digest('hex') !== digest)
      throw Error('Windows model verification failed.');
    await rename(`${target}.part`, target);
  } catch (error) {
    await rm(`${target}.part`, { force: true });
    throw error;
  }
  return target;
}
