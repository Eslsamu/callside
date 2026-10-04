import type { ModelProgress } from './whisper-model.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Express } from 'express';
import { z } from 'zod';

export interface LocalSpeakerResult {
  from: number;
  through: number;
  segments: Array<{ start: number; end: number; speaker: number }>;
}
export interface LocalSpeakerWorker {
  request(audio?: string, final?: boolean): Promise<LocalSpeakerResult>;
  close(): void;
}
export async function startSpeakerWorker(
  binary?: string,
  onProgress?: (value: ModelProgress) => void,
  portableModel?: string,
): Promise<LocalSpeakerWorker> {
  if (portableModel) return startPortableSpeakerWorker(portableModel, onProgress);
  const file =
    binary || process.env.CALLSIDE_DIARIZER_BIN || resolve('desktop/bin/callside-diarizer');
  await access(file);
  const child = spawn(file, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.on('data', () => {});
  let sequence = 0;
  let pending:
    | {
        id?: number;
        resolve(value: any): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const fail = () => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Local speaker runtime stopped.'));
      pending = undefined;
    }
  };
  child.stdin.on('error', fail);
  child.on('error', fail);
  child.on('exit', fail);
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.length > 1_500_000) {
      fail();
      child.kill();
      return;
    }
    try {
      const result = JSON.parse(line);
      if (result.progress) {
        onProgress?.({
          phase: 'downloading',
          percent: Math.max(0, Math.min(100, Number(result.percent) || 0)),
          message: String(result.message),
        });
        return;
      }
      if (result.error) {
        fail();
        return;
      }
      if (pending && (result.ready || result.id === pending.id)) {
        clearTimeout(pending.timer);
        pending.resolve(result);
        pending = undefined;
      }
    } catch {
      /* Library messages are not protocol responses. */
    }
  });
  const wait = (id?: number) =>
    new Promise<any>((resolve, reject) => {
      if (pending) {
        reject(new Error('Local speaker runtime is busy.'));
        return;
      }
      pending = {
        id,
        resolve,
        reject,
        timer: setTimeout(
          () => {
            fail();
            child.kill();
          },
          id === undefined ? 600000 : 30000,
        ),
      };
    });
  try {
    await wait();
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    async request(audio, final = false) {
      const id = ++sequence,
        result = wait(id);
      child.stdin.write(JSON.stringify({ id, audio, final }) + '\n');
      return result;
    },
    close() {
      fail();
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

export async function startPortableSpeakerWorker(
  model: string,
  onProgress?: (value: ModelProgress) => void,
): Promise<LocalSpeakerWorker> {
  await access(model);
  onProgress?.({ phase: 'loading', message: 'Loading the included speaker model' });
  const worker = new Worker(new URL('./portable-speaker-worker.js', import.meta.url), {
    workerData: { model },
    execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
  });
  let sequence = 0,
    closed = false;
  let pending:
    | {
        id?: number;
        resolve(value: LocalSpeakerResult): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const fail = () => {
    closed = true;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Local speaker runtime stopped.'));
      pending = undefined;
    }
    void worker.terminate();
  };
  const wait = (id?: number) =>
    new Promise<LocalSpeakerResult>((resolve, reject) => {
      if (closed || pending) {
        reject(new Error('Local speaker runtime is unavailable.'));
        return;
      }
      pending = { id, resolve, reject, timer: setTimeout(fail, id === undefined ? 60000 : 30000) };
    });
  const valid = (value: any): value is LocalSpeakerResult =>
    Number.isFinite(value?.from) &&
    Number.isFinite(value?.through) &&
    value.from >= 0 &&
    value.through >= value.from &&
    Array.isArray(value.segments) &&
    value.segments.length <= 5000 &&
    value.segments.every(
      (segment: any) =>
        Number.isFinite(segment?.start) &&
        Number.isFinite(segment?.end) &&
        segment.start >= value.from &&
        segment.end <= value.through &&
        segment.end > segment.start &&
        Number.isInteger(segment.speaker) &&
        segment.speaker >= 0 &&
        segment.speaker < 4,
    );
  worker.on('error', fail);
  worker.on('exit', fail);
  worker.on('message', (message) => {
    if (message?.error) {
      fail();
      return;
    }
    if (!pending) return;
    if (
      pending.id === undefined
        ? message?.ready === true
        : message?.id === pending.id && valid(message)
    ) {
      clearTimeout(pending.timer);
      pending.resolve(message);
      pending = undefined;
    } else fail();
  });
  try {
    await wait();
  } catch (error) {
    fail();
    throw error;
  }
  return {
    request(audio, final = false) {
      if (closed || pending)
        return Promise.reject(new Error('Local speaker runtime is unavailable.'));
      const id = ++sequence,
        response = wait(id);
      worker.postMessage({ id, audio, final });
      return response;
    },
    close: fail,
  };
}

export function attachLocalSpeakers(
  app: Express,
  factory: (progress: (value: ModelProgress) => void) => Promise<LocalSpeakerWorker>,
) {
  let progress: ModelProgress = {
    phase: 'idle',
    message: 'Speaker model downloads on first setup',
  };
  app.get('/api/local-speakers/status', (_req, res) => res.json(progress));
  let current:
    { id: string; worker: LocalSpeakerWorker; timer: ReturnType<typeof setTimeout> } | undefined;
  let starting = false,
    busy = false,
    closed = false;
  const close = () => {
    if (current) {
      clearTimeout(current.timer);
      current.worker.close();
      current = undefined;
    }
  };
  app.post('/api/local-speakers/start', async (_req, res) => {
    if (starting || current || closed) {
      res
        .status(409)
        .json({ error: 'Local speaker analysis is already in use. End the other call first.' });
      return;
    }
    starting = true;
    try {
      progress = { phase: 'loading', message: 'Loading speaker model' };
      const worker = await factory((value) => {
        progress = value;
      });
      progress = { phase: 'ready', percent: 100, message: 'Speaker model ready' };
      if (closed || res.destroyed) {
        worker.close();
        return;
      }
      current = { id: randomUUID(), worker, timer: setTimeout(close, 120000) };
      res.json({ session: current.id, model: 'LS-EEND AMI', maxSpeakers: 4 });
    } catch {
      progress = {
        phase: 'error',
        message: 'Speaker setup failed. Check your connection and retry.',
      };
      res.status(503).json({
        error:
          'Speaker labeling could not start. Check your internet connection and available disk space, then retry local audio setup. Source installations also need npm run local:speakers:setup. No API fallback was used.',
      });
    } finally {
      starting = false;
    }
  });
  const schema = z.object({
    session: z.string().uuid(),
    audio: z
      .string()
      .max(512000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .optional(),
    final: z.boolean().default(false),
  });
  app.post('/api/local-speakers/audio', async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid local speaker audio.' });
      return;
    }
    const { session, audio, final } = parsed.data;
    if (!current || current.id !== session) {
      res.status(409).json({ error: 'Local speaker session expired. Restart the call.' });
      return;
    }
    if (busy) {
      res.status(429).json({ error: 'Local speaker analysis is busy.' });
      return;
    }
    const pcm = Buffer.from(audio ?? '', 'base64');
    if (pcm.length % 2 || pcm.length > 384000 || (audio && pcm.toString('base64') !== audio)) {
      res.status(400).json({ error: 'Invalid PCM audio.' });
      return;
    }
    clearTimeout(current.timer);
    current.timer = setTimeout(close, 120000);
    busy = true;
    try {
      const result = await current.worker.request(audio, final);
      res.json(result);
    } catch {
      close();
      res.status(502).json({
        error:
          'Local speaker labeling failed. Transcription continues; no cloud fallback was used.',
      });
    } finally {
      busy = false;
      if (final) close();
    }
  });
  return () => {
    closed = true;
    close();
  };
}
