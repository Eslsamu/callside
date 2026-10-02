import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { audioEventSchema, configureSchema, type RealtimeConfig } from './validation.js';

export const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
export type RealtimeFactory = (apiKey: string) => WebSocket;
export const openRealtime: RealtimeFactory = (apiKey) =>
  new WebSocket(REALTIME_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: 15000,
    maxPayload: 1_000_000,
  });

export function transcriptionSession(config: RealtimeConfig) {
  const live = config.model === 'gpt-live-transcribe';
  const modern = live || config.model === 'gpt-transcribe';
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: null,
          transcription: {
            model: config.model,
            ...(config.language
              ? modern
                ? { languages: [config.language] }
                : { language: config.language }
              : {}),
            ...(live ? { delay: 'low' } : {}),
          },
        },
      },
    },
  };
}

function transcriptionErrorMessage(code: string, param: unknown): string {
  const prefix = `OpenAI transcription failed (${code}).`;
  if (code === 'string_above_max_length') {
    const promptFields = [
      'session.audio.input.transcription.prompt',
      'audio.input.transcription.prompt',
      'session.input_audio_transcription.prompt',
    ];
    const field =
      typeof param === 'string' && promptFields.includes(param)
        ? 'the transcription prompt'
        : 'a transcription configuration field';
    return `${prefix} OpenAI rejected ${field} because it is too long. This is separate from the Reference material limit. Update Callside and restart recording; your reference material can stay unchanged.`;
  }
  if (code === 'invalid_api_key') return `${prefix} Check or replace your OpenAI API key.`;
  if (code === 'insufficient_quota')
    return `${prefix} Check the API project's available credits and usage limit.`;
  if (code === 'rate_limit_exceeded')
    return `${prefix} Too many requests. Wait briefly and restart recording.`;
  if (code === 'model_not_found')
    return `${prefix} Check access to the selected transcription model or choose another model.`;
  return `${prefix} Check the transcription model and language settings, then restart recording.`;
}

export interface RealtimeProxyOptions {
  getApiKey: () => string;
  isAuthorized: (req: IncomingMessage, token: string | null) => boolean;
  connect?: RealtimeFactory;
}

export function attachRealtime(server: Server, options: RealtimeProxyOptions): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 280000, perMessageDeflate: false });
  const connections = new Set<WebSocket>();
  const attempts: number[] = [];

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/realtime') return;
    if (
      !options.isAuthorized(req, url.searchParams.get('token')) ||
      !['mic', 'system'].includes(url.searchParams.get('source') ?? '')
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const now = Date.now();
    while (attempts.length && attempts[0] < now - 60000) attempts.shift();
    if (connections.size >= 4 || attempts.length >= 12) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    attempts.push(now);
    wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client));
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (client) => {
    connections.add(client);
    let upstream: WebSocket | undefined;
    let configured = false;
    let ready = false;
    let ended = false;
    let audioBytesThisTurn = 0;
    let audioBytesThisWindow = 0;
    let windowStart = Date.now();
    const send = (event: unknown) => {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1_000_000)
        client.send(JSON.stringify(event));
      else if (client.readyState === WebSocket.OPEN)
        fail('The connection is too slow. Restart recording.', 'backpressure');
    };
    const fail = (message: string, code = 'connection_error') => {
      if (ended) return;
      ended = true;
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'error', error: { message, code } }));
        client.close(1011, code);
      }
      upstream?.terminate();
    };
    const setupTimeout = setTimeout(
      () => fail('OpenAI transcription did not start in time.', 'setup_timeout'),
      25000,
    );
    const sessionTimeout = setTimeout(
      () => fail('The session has reached two hours. Restart recording.', 'session_limit'),
      2 * 60 * 60 * 1000,
    );

    client.on('message', (raw, binary) => {
      if (ended) return;
      if (binary) {
        fail('Invalid message format.', 'invalid_message');
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        fail('Invalid JSON.', 'invalid_message');
        return;
      }
      if (!configured) {
        const config = configureSchema.safeParse(event);
        if (!config.success) {
          fail('Invalid transcription model, language, or configuration.', 'invalid_configuration');
          return;
        }
        configured = true;
        const key = options.getApiKey();
        if (!key) {
          fail('Add an OpenAI API key first.', 'missing_key');
          return;
        }
        try {
          upstream = (options.connect ?? openRealtime)(key);
        } catch {
          fail('Could not connect to OpenAI.');
          return;
        }
        upstream.on('open', () => {
          if (!ended) upstream?.send(JSON.stringify(transcriptionSession(config.data)));
        });
        upstream.on('message', (rawEvent) => {
          if (ended) return;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(rawEvent.toString()) as Record<string, unknown>;
          } catch {
            fail('OpenAI returned an invalid message.');
            return;
          }
          if (message.type === 'session.updated') {
            clearTimeout(setupTimeout);
            if (!ready) {
              ready = true;
              send({ type: 'ready' });
            }
          } else if (
            message.type === 'error' ||
            message.type === 'conversation.item.input_audio_transcription.failed'
          ) {
            const error = message.error as { code?: unknown; param?: unknown } | undefined;
            const code =
              typeof error?.code === 'string' && /^[\w-]{1,80}$/.test(error.code)
                ? error.code
                : 'transcription_error';
            fail(transcriptionErrorMessage(code, error?.param), code);
          } else if (
            typeof message.type === 'string' &&
            [
              'conversation.item.input_audio_transcription.delta',
              'conversation.item.input_audio_transcription.completed',
              'input_audio_buffer.committed',
            ].includes(message.type)
          )
            send(message);
        });
        upstream.on('error', () =>
          fail('OpenAI connection failed. Check your API key, network, and model access.'),
        );
        upstream.on('unexpected-response', (_request, response) => {
          response.resume();
          fail(
            `OpenAI rejected the connection (HTTP ${response.statusCode ?? 0}). Check your API key, balance, and model access.`,
          );
        });
        upstream.on('close', () => {
          if (!ended) fail('OpenAI closed the transcription connection. Restart recording.');
        });
        return;
      }
      if (!ready || !upstream || upstream.readyState !== WebSocket.OPEN) {
        fail('Audio was sent before the session was ready.', 'not_ready');
        return;
      }
      const parsed = audioEventSchema.safeParse(event);
      if (!parsed.success) {
        fail('Invalid audio event.', 'invalid_audio');
        return;
      }
      if (parsed.data.type === 'input_audio_buffer.append') {
        const bytes = Buffer.from(parsed.data.audio, 'base64');
        if (bytes.length % 2 || bytes.toString('base64') !== parsed.data.audio) {
          fail('Audio must be PCM16.', 'invalid_audio');
          return;
        }
        if (Date.now() - windowStart > 10000) {
          windowStart = Date.now();
          audioBytesThisWindow = 0;
        }
        audioBytesThisWindow += bytes.length;
        audioBytesThisTurn += bytes.length;
        if (audioBytesThisWindow > 960000 || audioBytesThisTurn > 2880000) {
          fail('Audio buffer too large. Restart recording.', 'audio_limit');
          return;
        }
      } else {
        if (audioBytesThisTurn < 4800) {
          fail('Audio chunks must contain at least 100 ms.', 'audio_too_short');
          return;
        }
        audioBytesThisTurn = 0;
      }
      // WebSocket buffers only short bursts. Never keep an unbounded offline audio queue.
      if (upstream.bufferedAmount > 1_000_000) {
        fail('OpenAI connection too slow. Restart recording.', 'backpressure');
        return;
      }
      upstream.send(JSON.stringify(parsed.data));
    });
    const cleanup = () => {
      ended = true;
      clearTimeout(setupTimeout);
      clearTimeout(sessionTimeout);
      connections.delete(client);
      upstream?.terminate();
    };
    client.on('close', cleanup);
    client.on('error', cleanup);
  });
  return () => {
    server.off('upgrade', onUpgrade);
    for (const client of connections) client.terminate();
    wss.close();
  };
}
