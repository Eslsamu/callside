import { createHash } from 'node:crypto';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname } from 'node:path';
export const WHISPER_MODEL_NAME = 'ggml-large-v3-turbo-q5_0.bin';
export const WHISPER_MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
export interface ModelProgress {
  phase: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  percent?: number;
  message: string;
}
export async function hasWhisperModel(directory = '.local/models'): Promise<boolean> {
  try {
    await access(resolve(process.env.WHISPER_MODEL_PATH || `${directory}/${WHISPER_MODEL_NAME}`));
    return true;
  } catch {
    return false;
  }
}
export async function ensureWhisperModel(
  directory = '.local/models',
  progress?: (value: ModelProgress) => void,
): Promise<string> {
  const model = resolve(process.env.WHISPER_MODEL_PATH || `${directory}/${WHISPER_MODEL_NAME}`);
  try {
    await access(model);
  } catch {
    if (process.env.WHISPER_MODEL_PATH) throw new Error(`Local model not found: ${model}`);
    await mkdir(dirname(model), { recursive: true });
    console.log(
      'Downloading Whisper large-v3-turbo Q5 (574 MB). This happens once; inference stays local.',
    );
    progress?.({ phase: 'downloading', percent: 0, message: 'Downloading Whisper model' });
    const response = await fetch(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/${WHISPER_MODEL_NAME}`,
      { signal: AbortSignal.timeout(300000) },
    );
    if (!response.ok || !response.body)
      throw new Error('Model download failed. Retry npm run local:test.');
    const hash = createHash('sha256');
    let received = 0;
    const total = Number(response.headers.get('content-length'));
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        hash.update(chunk);
        progress?.({
          phase: 'downloading',
          ...(total > 0 ? { percent: Math.min(100, (received / total) * 100) } : {}),
          message: 'Downloading Whisper model',
        });
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(`${model}.part`, { mode: 0o600 }),
      );
      if (
        received !== 574041195 ||
        hash.digest('hex') !== '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
      )
        throw Error('Whisper model verification failed. Retry the download.');
      await rename(`${model}.part`, model);
    } catch (error) {
      await rm(`${model}.part`, { force: true });
      throw error;
    }
  }

  progress?.({ phase: 'loading', message: 'Loading Whisper model' });
  return model;
}
