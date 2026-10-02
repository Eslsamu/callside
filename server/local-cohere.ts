import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { LocalEngine, LocalTranscription } from '../shared/local-test.js';

const supportedLanguages = new Set([
  'ar',
  'de',
  'el',
  'en',
  'es',
  'fr',
  'it',
  'ja',
  'ko',
  'nl',
  'pl',
  'pt',
  'vi',
  'zh',
]);

/** Cohere's model runs in an offline Python/MLX child with private stdio, never a public port. */
export async function startLocalCohere(
  modelPath = process.env.COHERE_MODEL_PATH || '.local/models/cohere-transcribe-mlx-4bit',
): Promise<LocalEngine & { close(): Promise<void> }> {
  const python = resolve(process.env.COHERE_PYTHON || '.local/cohere-venv/bin/python');
  const worker = resolve('scripts/cohere-worker.py');
  modelPath = resolve(modelPath);
  try {
    await Promise.all([access(python), access(worker), access(resolve(modelPath, 'config.json'))]);
  } catch {
    throw new Error(
      'Local Cohere is not installed. Run npm run local:setup on an Apple Silicon Mac.',
    );
  }
  let details: Record<string, string | number | boolean> = {
    runtime: 'MLX Audio (offline local worker)',
    modelDirectory: basename(modelPath),
    maxGeneratedTokensPerChunk: 256,
    nativeStreaming: false,
  };
  try {
    const saved: unknown = JSON.parse(
      await readFile(resolve(modelPath, 'callside-model.json'), 'utf8'),
    );
    if (saved && typeof saved === 'object') {
      details = {
        ...details,
        ...Object.fromEntries(
          Object.entries(saved).filter(([, value]) =>
            ['string', 'number', 'boolean'].includes(typeof value),
          ),
        ),
      };
    }
  } catch {
    details.provenance = 'Custom model directory; revision not recorded by setup';
  }

  let child: ChildProcessWithoutNullStreams | undefined;
  let closed = false;
  let busy = false;
  let requestId = 0;
  let pending:
    | {
        id: number;
        owner: ChildProcessWithoutNullStreams;
        resolve(value: LocalTranscription): void;
        reject(error: Error): void;
      }
    | undefined;
  let starting: Promise<void> | undefined;
  let shutdown: Promise<void> = Promise.resolve();

  function stopWorker(target = child): Promise<void> {
    if (child === target) child = undefined;
    if (!target || !target.pid || target.exitCode !== null || target.signalCode !== null)
      return shutdown;
    const stopped = new Promise<void>((done) => {
      const timer = setTimeout(() => target.kill('SIGKILL'), 2000);
      const finish = () => {
        clearTimeout(timer);
        target.removeListener('exit', finish);
        target.removeListener('close', finish);
        done();
      };
      target.once('exit', finish);
      target.once('close', finish);
      target.kill('SIGTERM');
    });
    shutdown = Promise.all([shutdown, stopped]).then(() => {});
    return shutdown;
  }

  async function ensureWorker(signal?: AbortSignal): Promise<void> {
    await shutdown;
    signal?.throwIfAborted();
    if (closed) throw new Error('Local Cohere is closed. Restart the local test.');
    if (starting) return starting;
    if (child && child.exitCode === null && child.signalCode === null) return;
    starting = new Promise<void>((ready, reject) => {
      const current = spawn(python, ['-u', worker, modelPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          DO_NOT_TRACK: '1',
        },
      });
      child = current;
      let initialized = false;
      let dead = false;
      let buffer = '';
      const startupTimer = setTimeout(() => {
        failed(new Error('Local Cohere took too long to load. Close other heavy apps and retry.'));
      }, 120_000);
      current.stderr.resume(); // Consume diagnostics without logging audio or transcripts.
      current.stdin.on('error', () => {}); // Exit handles a broken input pipe.
      function failed(error: Error) {
        if (dead) return;
        dead = true;
        clearTimeout(startupTimer);
        // Drain this specific worker before ensureWorker can launch a replacement.
        void stopWorker(current);
        if (!initialized) reject(error);
        if (pending?.owner === current) {
          pending.reject(error);
          pending = undefined;
        }
      }
      current.once('error', () =>
        failed(new Error('Could not start local Cohere. Run npm run local:setup.')),
      );
      current.once('exit', () =>
        failed(new Error('Local Cohere stopped. Retry the test or run npm run local:setup.')),
      );
      current.stdout.setEncoding('utf8');
      current.stdout.on('data', (chunk: string) => {
        if (dead) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 128_000) {
          failed(new Error('Local Cohere returned an oversized response.'));
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== 'object') throw new Error('Invalid response');
            const response = value as Record<string, unknown>;
            if (!initialized && response.ready === true) {
              initialized = true;
              clearTimeout(startupTimer);
              ready();
            } else if (pending?.owner === current && response.id === pending.id) {
              const active = pending;
              pending = undefined;
              if (
                typeof response.peakMemoryBytes === 'number' &&
                Number.isFinite(response.peakMemoryBytes) &&
                response.peakMemoryBytes >= 0
              ) {
                details.lastInferenceMlxPeakMemoryBytes = response.peakMemoryBytes;
              }
              if (typeof response.error === 'string')
                active.reject(new Error(response.error.slice(0, 300)));
              else if (
                typeof response.text === 'string' &&
                response.text.length <= 16_000 &&
                typeof response.processingMs === 'number' &&
                Number.isFinite(response.processingMs) &&
                response.processingMs >= 0
              ) {
                active.resolve({ text: response.text.trim(), processingMs: response.processingMs });
              } else active.reject(new Error('Local Cohere returned an invalid transcript.'));
            }
          } catch {
            failed(new Error('Local Cohere returned an invalid response.'));
            return;
          }
        }
      });
    }).finally(() => {
      starting = undefined;
    });
    return starting;
  }

  try {
    await ensureWorker();
  } catch (error) {
    await shutdown;
    throw error;
  }
  return {
    model: 'Cohere Transcribe 03-2026 (MLX 4-bit)',
    details,
    async transcribe(audio, language, signal) {
      signal.throwIfAborted();
      if (!supportedLanguages.has(language))
        throw new Error(
          'Choose a supported Cohere language; automatic language detection is unavailable.',
        );
      if (audio.byteLength > 1_000_000)
        throw new Error('Local Cohere accepts audio chunks up to 30 seconds.');
      if (busy) throw new Error('Local Cohere is busy. Stop the other test and retry.');
      busy = true;
      const combined = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
      let stopping: Promise<void> | undefined;
      const abort = () => {
        pending?.reject(new DOMException('Local Cohere transcription cancelled.', 'AbortError'));
        pending = undefined;
        // MLX kernels are not cooperatively cancellable; terminate the process and reload next use.
        stopping = stopWorker();
      };
      combined.addEventListener('abort', abort, { once: true });
      try {
        await ensureWorker(combined);
        combined.throwIfAborted();
        return await new Promise<LocalTranscription>((done, reject) => {
          const id = ++requestId;
          pending = { id, owner: child!, resolve: done, reject };
          child!.stdin.write(
            `${JSON.stringify({ id, language, audio: Buffer.from(audio).toString('base64') })}\n`,
            (error) => {
              if (error && pending?.id === id) {
                pending = undefined;
                reject(new Error('Could not send audio to local Cohere. Retry the test.'));
              }
            },
          );
        });
      } finally {
        combined.removeEventListener('abort', abort);
        await stopping;
        await shutdown;
        busy = false;
      }
    },
    async close() {
      closed = true;
      await stopWorker();
    },
  };
}
