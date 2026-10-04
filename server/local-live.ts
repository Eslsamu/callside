import { access, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WHISPER_MODEL_NAME } from './whisper-model.js';
import type { Express } from 'express';
import { z } from 'zod';
import type { LocalEngine } from '../shared/local-test.js';
import { startLocalWhisper, WhisperStartupError } from './local-whisper.js';
import { ensureWhisperModel, type ModelProgress } from './whisper-model.js';
import { decodeLocalWav } from './local-test-routes.js';

/** Lazy local runtime shared by microphone and system audio, with bounded serialized work. */
export function attachLocalLive(
  app: Express,
  directory?: string,
  supplied?: LocalEngine,
  binary?: string,
  bundledModel?: string,
) {
  let progress: ModelProgress = {
    phase: 'idle',
    message: 'Whisper model downloads on first setup',
  };
  app.get('/api/local/status', (_req, res) => res.json(progress));
  let engine: (LocalEngine & { close?(): Promise<void> }) | undefined = supplied;
  let loading: Promise<LocalEngine> | undefined;
  let closed = false;
  let queued = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const prepare = () => {
    if (closed) return Promise.reject(new Error('Server closed'));
    if (engine) {
      progress = { phase: 'ready', percent: 100, message: 'Whisper ready' };
      return Promise.resolve(engine);
    }
    return (loading ??= (async () => {
      if (bundledModel && directory && !process.env.WHISPER_MODEL_PATH) {
        const target = join(directory, WHISPER_MODEL_NAME);
        try {
          await access(target);
        } catch {
          progress = { phase: 'loading', message: 'Preparing the included Whisper model' };
          await mkdir(directory, { recursive: true });
          try {
            await copyFile(bundledModel, target + '.part');
            await rename(target + '.part', target);
          } catch (error) {
            await rm(target + '.part', { force: true });
            throw error;
          }
        }
      }
      const model = await ensureWhisperModel(directory, (value) => {
        progress = value;
      });
      engine = await startLocalWhisper(model, binary);
      if (closed) {
        await engine.close?.();
        throw new Error('Server closed');
      }
      progress = { phase: 'ready', percent: 100, message: 'Whisper ready' };
      return engine;
    })().finally(() => {
      loading = undefined;
    }));
  };
  app.post('/api/local/prepare', async (_req, res) => {
    try {
      res.json({ ready: true, model: (await prepare()).model });
    } catch (error) {
      progress = {
        phase: 'error',
        message:
          error instanceof WhisperStartupError
            ? error.message
            : bundledModel
              ? 'The included model could not be prepared. Check free disk space and extract the complete ZIP.'
              : 'Whisper setup failed. Check your connection and retry.',
      };
      res.status(503).json({
        error:
          error instanceof WhisperStartupError || bundledModel
            ? progress.message
            : binary
              ? 'Whisper could not start. Check your internet connection and available disk space, then retry local audio setup. No cloud fallback was used.'
              : 'Local Whisper could not start. Install whisper.cpp (on macOS: brew install whisper-cpp), or set WHISPER_SERVER_BIN. The first start also needs internet to download the 574 MB model. No cloud fallback was used.',
      });
    }
  });
  const schema = z.object({
    audio: z.string().max(900000),
    language: z.string().regex(/^(auto|[a-z]{2,3})$/),
  });
  app.post('/api/local/transcribe', async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid local transcription request.' });
      return;
    }
    let audio: Buffer;
    try {
      audio = decodeLocalWav(parsed.data.audio);
    } catch {
      res.status(400).json({ error: 'Invalid local WAV audio.' });
      return;
    }
    if (!engine) {
      res.status(503).json({ error: 'Prepare the local model before recording.' });
      return;
    }
    if (queued >= 8) {
      res.status(429).json({
        error: 'Local transcription cannot keep up. Stop and retry with fewer audio sources.',
      });
      return;
    }
    queued++;
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const job = tail
      .catch(() => undefined)
      .then(async () => {
        if (abort.signal.aborted || closed) throw new Error('Cancelled');
        return engine!.transcribe(audio, parsed.data.language, abort.signal);
      });
    tail = job;
    try {
      res.json(await job);
    } catch {
      if (!res.destroyed)
        res.status(502).json({
          error:
            'Local transcription failed. Restart recording. No audio was sent to a cloud provider.',
        });
    } finally {
      queued--;
    }
  });
  return async () => {
    closed = true;
    await engine?.close?.();
  };
}
