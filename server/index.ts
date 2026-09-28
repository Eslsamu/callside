import { ANSWER_MODELS } from '../shared/models.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ViteDevServer } from 'vite';
import type { AnswerEvent } from '../shared/types.js';
import { answerSchema, decodeWav, diarizeSchema, keySchema } from './validation.js';
import {
  AutoGate,
  buildAnswerInput,
  demoAnswer,
  OpenAIProvider,
  publicError,
  PublicError,
  type AiProvider,
} from './provider.js';
import { attachRealtime, type RealtimeFactory } from './realtime.js';

export interface ServerOptions {
  port?: number;
  production?: boolean;
  /** API-only and dependency injection allow tests without upstream calls. */
  apiOnly?: boolean;
  apiKey?: string;
  providerFactory?: (apiKey: string) => AiProvider;
  realtimeFactory?: RealtimeFactory;
}
export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

function equalToken(candidate: unknown, token: string): boolean {
  if (typeof candidate !== 'string') return false;
  const value = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

/** A local process, deliberately bound to IPv4 loopback, not a hosted multi-user API. */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  // Both the CLI and Electron call this entrypoint. Fixtures pass apiKey explicitly.
  if (options.apiKey === undefined) {
    const dotenv = await import('dotenv');
    dotenv.config({ quiet: true });
  }
  const app = express();
  const server = createServer(app);
  server.requestTimeout = 90000;
  server.headersTimeout = 10000;
  const token = randomBytes(32).toString('hex');
  let url = '';
  let authority = '';
  let inMemoryKey: string | undefined = options.apiKey;
  const getApiKey = () => inMemoryKey ?? process.env.OPENAI_API_KEY?.trim() ?? '';
  const provider = () =>
    (options.providerFactory ?? ((key) => new OpenAIProvider(key)))(getApiKey());
  const active = new Set<AbortController>();
  let answerCount = 0;
  let diarizeCount = 0;
  const recent = { answer: [] as number[], diarize: [] as number[] };
  let vite: ViteDevServer | undefined;
  const production = options.production ?? process.env.NODE_ENV === 'production';

  const validOrigin = (req: IncomingMessage, required = false) =>
    req.headers.host === authority &&
    (req.headers.origin === undefined ? !required : req.headers.origin === url) &&
    !['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site'] ?? ''));

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'microphone=(self), display-capture=(self), camera=()');
    if (production)
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    if (!validOrigin(req)) {
      res.status(403).json({ error: 'Only the local Callside origin is allowed.' });
      return;
    }
    next();
  });
  app.get('/api/bootstrap', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      token,
      hasApiKey: Boolean(getApiKey()),
      models: [...ANSWER_MODELS],
    });
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!equalToken(req.headers['x-callside-token'], token)) {
      res.status(403).json({ error: 'Invalid local session. Reload the page.' });
      return;
    }
    if (req.method === 'POST' && !req.is('application/json')) {
      res.status(415).json({ error: 'JSON required.' });
      return;
    }
    next();
  });
  app.use('/api', express.json({ limit: '5mb', strict: true }));

  app.post('/api/key', (req, res) => {
    const parsed = keySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid API key.' });
      return;
    }
    inMemoryKey = parsed.data.apiKey;
    res.json({ hasApiKey: Boolean(getApiKey()) });
  });

  function limited(kind: 'answer' | 'diarize', res: Response): boolean {
    const now = Date.now();
    const window = recent[kind];
    while (window.length && window[0] < now - 60000) window.shift();
    if (
      (kind === 'answer' ? answerCount >= 2 : diarizeCount >= 4) ||
      window.length >= (kind === 'answer' ? 60 : 120)
    ) {
      res.setHeader('Retry-After', '3');
      res.status(429).json({ error: 'Too many concurrent requests. Wait a moment.' });
      return true;
    }
    window.push(now);
    return false;
  }
  function requestController(res: Response, timeoutMs: number) {
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cancel = () => controller.abort();
    res.on('close', cancel);
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        res.off('close', cancel);
        active.delete(controller);
      },
    };
  }

  app.post('/api/answer', async (req, res) => {
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid settings or conversation data.' });
      return;
    }
    const request = parsed.data;
    if (!request.demo && !getApiKey()) {
      res.status(401).json({ error: 'Add an OpenAI API key first.' });
      return;
    }
    if (limited('answer', res)) return;
    answerCount++;
    const { signal, cleanup } = requestController(res, 65000);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: AnswerEvent) => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keepalive\n\n');
    }, 15000);
    const gate = request.mode === 'auto' ? new AutoGate() : undefined;
    let complete = false;
    let outputSize = 0;
    let hasText = false;
    try {
      const stream = request.demo
        ? demoAnswer(request, signal)
        : provider().answer(buildAnswerInput(request), signal);
      for await (const event of stream) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (event.type === 'delta') {
          outputSize += event.text.length;
          if (outputSize > 24000)
            throw new PublicError('The answer is too long. Use a shorter prompt.');
          const text = gate ? gate.push(event.text) : event.text;
          if (text) {
            send({ type: 'delta', text });
            hasText = true;
          }
        } else complete = true;
      }
      if (!complete) throw new PublicError('The answer stream ended unexpectedly.');
      const tail = gate?.finish();
      if (tail?.skip) send({ type: 'skip' });
      else {
        if (tail?.text) {
          send({ type: 'delta', text: tail.text });
          hasText = true;
        }
        if (!hasText)
          throw new PublicError('The model returned no text. Check the model or output limit.');
        send({ type: 'done' });
      }
    } catch (error) {
      send({ type: 'error', message: publicError(error) });
    } finally {
      clearInterval(heartbeat);
      cleanup();
      answerCount--;
      res.end();
    }
  });

  app.post('/api/diarize', async (req, res) => {
    const parsed = diarizeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid audio chunk.' });
      return;
    }
    let audio: Buffer;
    try {
      audio = decodeWav(parsed.data.audio);
    } catch {
      res.status(400).json({
        error: 'Invalid WAV audio. Expected mono PCM16, 24 kHz, up to 60 seconds.',
      });
      return;
    }
    if (!getApiKey()) {
      res.status(401).json({ error: 'Add an OpenAI API key first.' });
      return;
    }
    if (limited('diarize', res)) return;
    diarizeCount++;
    const { signal, cleanup } = requestController(res, 65000);
    try {
      const entries = await provider().diarize({ ...parsed.data, audio }, signal);
      if (!res.destroyed) res.json({ entries });
    } catch (error) {
      if (!res.destroyed) res.status(502).json({ error: publicError(error) });
    } finally {
      cleanup();
      diarizeCount--;
    }
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const tooLarge =
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large';
    res
      .status(tooLarge ? 413 : 400)
      .json({ error: tooLarge ? 'Request too large.' : 'Invalid request.' });
  });

  const detachRealtime = attachRealtime(server, {
    getApiKey,
    isAuthorized: (req, candidate) => validOrigin(req, true) && equalToken(candidate, token),
    connect: options.realtimeFactory,
  });

  if (!options.apiOnly) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(moduleDir, import.meta.url.endsWith('.ts') ? '..' : '../..');
    if (production) {
      const dist = resolve(projectRoot, 'dist');
      app.use(express.static(dist, { index: false }));
      app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
    } else {
      const { createServer: createViteServer } = await import('vite');
      vite = await createViteServer({
        root: projectRoot,
        server: { middlewareMode: true, hmr: { server } },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    }
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4317, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind loopback server.');
  authority = `127.0.0.1:${address.port}`;
  url = `http://${authority}`;
  let closed = false;
  return {
    url,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const controller of active) controller.abort();
      detachRealtime();
      await vite?.close();
      const closing = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      server.closeAllConnections();
      await closing;
      inMemoryKey = '';
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dotenv = await import('dotenv');
  dotenv.config({ quiet: true });
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('PORT must be between 0 and 65535.');
  const running = await startServer({
    port,
    production: process.env.NODE_ENV === 'production' || import.meta.url.endsWith('.js'),
  });
  console.log(`Callside is running locally: ${running.url}`);
  const shutdown = () => {
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
