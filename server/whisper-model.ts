import { access, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
export const WHISPER_MODEL_NAME = 'ggml-large-v3-turbo-q5_0.bin';
export const WHISPER_MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
export async function ensureWhisperModel(): Promise<string> {
  const model = resolve(process.env.WHISPER_MODEL_PATH || `.local/models/${WHISPER_MODEL_NAME}`);
  try {
    await access(model);
  } catch {
    if (process.env.WHISPER_MODEL_PATH) throw new Error(`Local model not found: ${model}`);
    await mkdir(resolve('.local/models'), { recursive: true });
    console.log(
      'Downloading Whisper large-v3-turbo Q5 (574 MB). This happens once; inference stays local.',
    );
    const response = await fetch(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/${WHISPER_MODEL_NAME}`,
      { signal: AbortSignal.timeout(300000) },
    );
    if (!response.ok || !response.body)
      throw new Error('Model download failed. Retry npm run local:test.');
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(`${model}.part`, { mode: 0o600 }),
      );
      await rename(`${model}.part`, model);
    } catch (error) {
      await rm(`${model}.part`, { force: true });
      throw error;
    }
  }

  return model;
}
