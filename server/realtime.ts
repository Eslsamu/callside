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
            ...(config.prompt ? { prompt: config.prompt } : {}),
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
        fail('Die Verbindung ist zu langsam. Bitte Aufnahme neu starten.', 'backpressure');
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
      () =>
        fail('OpenAI-Transkription konnte nicht rechtzeitig gestartet werden.', 'setup_timeout'),
      25000,
    );
    const sessionTimeout = setTimeout(
      () =>
        fail('Die Sitzung hat zwei Stunden erreicht. Bitte Aufnahme neu starten.', 'session_limit'),
      2 * 60 * 60 * 1000,
    );

    client.on('message', (raw, binary) => {
      if (ended) return;
      if (binary) {
        fail('Ungültiges Nachrichtenformat.', 'invalid_message');
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        fail('Ungültiges JSON.', 'invalid_message');
        return;
      }
      if (!configured) {
        const config = configureSchema.safeParse(event);
        if (!config.success) {
          fail(
            'Ungültiges Transkriptionsmodell, Sprache oder Konfiguration.',
            'invalid_configuration',
          );
          return;
        }
        configured = true;
        const key = options.getApiKey();
        if (!key) {
          fail('Bitte zuerst einen OpenAI API-Key hinterlegen.', 'missing_key');
          return;
        }
        try {
          upstream = (options.connect ?? openRealtime)(key);
        } catch {
          fail('OpenAI-Verbindung konnte nicht gestartet werden.');
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
            fail('OpenAI lieferte eine ungültige Nachricht.');
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
            const error = message.error as { code?: unknown } | undefined;
            const code =
              typeof error?.code === 'string' && /^[\w-]{1,80}$/.test(error.code)
                ? error.code
                : 'transcription_error';
            fail(
              `OpenAI-Transkription fehlgeschlagen (${code}). Bitte Modellzugang, API-Guthaben und Sprache prüfen.`,
              code,
            );
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
          fail(
            'OpenAI-Verbindung fehlgeschlagen. Bitte API-Key, Netzwerk und Modellzugang prüfen.',
          ),
        );
        upstream.on('unexpected-response', (_request, response) => {
          response.resume();
          fail(
            `OpenAI hat die Verbindung abgelehnt (HTTP ${response.statusCode ?? 0}). Bitte API-Key, Guthaben und Modellzugang prüfen.`,
          );
        });
        upstream.on('close', () => {
          if (!ended)
            fail('OpenAI hat die Transkriptionsverbindung beendet. Bitte Aufnahme neu starten.');
        });
        return;
      }
      if (!ready || !upstream || upstream.readyState !== WebSocket.OPEN) {
        fail('Audio wurde vor der bestätigten Sitzung gesendet.', 'not_ready');
        return;
      }
      const parsed = audioEventSchema.safeParse(event);
      if (!parsed.success) {
        fail('Ungültiges Audioereignis.', 'invalid_audio');
        return;
      }
      if (parsed.data.type === 'input_audio_buffer.append') {
        const bytes = Buffer.from(parsed.data.audio, 'base64');
        if (bytes.length % 2 || bytes.toString('base64') !== parsed.data.audio) {
          fail('Audio muss PCM16 sein.', 'invalid_audio');
          return;
        }
        if (Date.now() - windowStart > 10000) {
          windowStart = Date.now();
          audioBytesThisWindow = 0;
        }
        audioBytesThisWindow += bytes.length;
        audioBytesThisTurn += bytes.length;
        if (audioBytesThisWindow > 960000 || audioBytesThisTurn > 2880000) {
          fail('Audiopuffer zu groß. Bitte Aufnahme neu starten.', 'audio_limit');
          return;
        }
      } else {
        if (audioBytesThisTurn < 4800) {
          fail('Audioabschnitt muss mindestens 100 ms enthalten.', 'audio_too_short');
          return;
        }
        audioBytesThisTurn = 0;
      }
      // WebSocket buffers only short bursts. Never keep an unbounded offline audio queue.
      if (upstream.bufferedAmount > 1_000_000) {
        fail('OpenAI-Verbindung zu langsam. Bitte Aufnahme neu starten.', 'backpressure');
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
