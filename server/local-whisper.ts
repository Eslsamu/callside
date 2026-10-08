import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { access, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { LocalEngine } from '../shared/local-test.js';

export class WhisperStartupError extends Error {}
export class WhisperInferenceError extends Error {}

async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((done, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', done);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port.');
  await new Promise<void>((done) => socket.close(() => done()));
  return address.port;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited;
  clearTimeout(timer);
}

/** Persistent local inference. The private engine URL never reaches the renderer. */
export async function startLocalWhisper(
  modelPath: string,
  bundledBinary?: string,
  options: { cpuOnly?: boolean } = {},
): Promise<LocalEngine & { close(): Promise<void> }> {
  try {
    await access(modelPath);
  } catch {
    throw new WhisperStartupError(
      'The local Whisper model is missing or unreadable. Extract the complete test package and retry.',
    );
  }
  let binary = bundledBinary || process.env.WHISPER_SERVER_BIN;
  if (!binary && process.platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server']) {
      try {
        await access(candidate);
        binary = candidate;
        break;
      } catch {
        /* Try PATH next. */
      }
    }
  }
  const port = await unusedPort();
  const privatePath = `/${randomBytes(32).toString('hex')}`;
  // whisper-server otherwise serves a public form and /load endpoint. Put every route
  // behind an unguessable process-local path and serve no static files.
  const publicDir = resolve(dirname(modelPath), 'empty-public');
  await mkdir(publicDir, { recursive: true });
  const base = `http://127.0.0.1:${port}${privatePath}`;
  const child = spawn(
    binary || 'whisper-server',
    [
      ...(options.cpuOnly ? ['--no-gpu'] : []),
      '--model',
      resolve(modelPath),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--request-path',
      privatePath,
      '--public',
      publicDir,
      '--threads',
      '4',
      '--best-of',
      '1',
      '--beam-size',
      '1',
      '--no-fallback',
      '--no-timestamps',
      '--suppress-nst',
      '--language',
      'de',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  let failed = '';
  let diagnostics = '';
  child.on('error', (error) => {
    failed = error.message;
  });
  // Consume native diagnostics without recording audio, transcripts, or the private URL.
  child.stderr?.on('data', (data: Buffer) => {
    diagnostics = (diagnostics + data.toString()).slice(-2000);
  });
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    if (failed || child.exitCode !== null || child.signalCode !== null) break;
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (health.ok) {
        ready = true;
        break;
      }
    } catch {
      /* wait for native model initialization */
    }
    await delay(150);
  }
  if (!ready) {
    const nativeExit = child.exitCode;
    await terminate(child);
    if (bundledBinary)
      throw new WhisperStartupError(
        failed
          ? 'The included Whisper program could not launch. Extract the entire ZIP to a writable folder; check whether Windows security blocked the executable.'
          : nativeExit !== null
            ? `The included Whisper program exited during startup (code ${nativeExit}). This Windows preview requires an Intel/AMD x64 CPU with AVX2, FMA and F16C. Save the test report.`
            : 'The included Whisper model did not finish loading within 60 seconds. Close other demanding apps and retry, or save the test report.',
      );
    throw new Error(
      failed ||
        `Local Whisper could not start. Check the model and whisper-server installation. ${diagnostics.replaceAll(privatePath, '/[private]')}`,
    );
  }
  let busy = false;
  return {
    model: modelPath
      .split(/[\\/]/)
      .pop()!
      .replace(/^ggml-/, '')
      .replace(/\.bin$/, ''),
    async transcribe(audio, language, signal) {
      if (busy) throw new Error('Local Whisper is busy. Stop the other test and retry.');
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Local Whisper stopped. Restart npm run local:test.');
      busy = true;
      const started = performance.now();
      try {
        const body = new FormData();
        body.set('file', new Blob([Uint8Array.from(audio)], { type: 'audio/wav' }), 'speech.wav');
        body.set('language', language);
        body.set('response_format', 'json');
        body.set('temperature', '0');
        body.set('temperature_inc', '0');
        body.set('no_timestamps', 'true');
        const response = await fetch(`${base}/inference`, {
          method: 'POST',
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });
        if (!response.ok)
          throw new Error('Local Whisper could not process this audio. Stop and retry.');
        const result = (await response.json()) as { text?: unknown };
        if (typeof result.text !== 'string')
          throw new Error('Local Whisper returned an invalid transcript.');
        return { text: result.text.trim(), processingMs: Math.round(performance.now() - started) };
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError')
          throw new WhisperInferenceError(
            'Local Whisper exceeded 30 seconds for one phrase. Try one audio source and turn off local speaker labeling, or configure cloud transcription. No cloud fallback was used.',
          );
        throw error;
      } finally {
        busy = false;
      }
    },
    close: () => terminate(child),
  };
}
