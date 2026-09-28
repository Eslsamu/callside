import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { startServer, type RunningServer } from '../server/index.js';
import { transcriptionSession } from '../server/realtime.js';

const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];
const upstreamServers: WebSocketServer[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const server of upstreamServers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function setup() {
  const upstreamServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  upstreamServers.push(upstreamServer);
  await once(upstreamServer, 'listening');
  const address = upstreamServer.address();
  if (typeof address === 'string' || !address) throw new Error('Missing fixture port');
  const connect = vi.fn(() => new WebSocket(`ws://127.0.0.1:${address.port}`));
  const server = await startServer({
    port: 0,
    apiOnly: true,
    apiKey: 'test-key-not-sent-upstream',
    realtimeFactory: connect,
  });
  servers.push(server);
  const { token } = (await (await fetch(`${server.url}/api/bootstrap`)).json()) as {
    token: string;
  };
  const wsUrl = `${server.url.replace('http:', 'ws:')}/api/realtime?token=${token}&source=mic`;
  const client = new WebSocket(wsUrl, { origin: server.url });
  sockets.push(client);
  const received: Record<string, unknown>[] = [];
  client.on('message', (data) => received.push(JSON.parse(data.toString())));
  await once(client, 'open');
  return { server, wsUrl, upstreamServer, client, received, connect };
}

describe('Realtime proxy with a local provider fixture', () => {
  it('configures GA transcription and waits for session.updated before signaling ready', async () => {
    const fixture = await setup();
    const connected = once(fixture.upstreamServer, 'connection');
    fixture.client.send(
      JSON.stringify({
        type: 'configure',
        model: 'gpt-live-transcribe',
        language: 'de',
        prompt: 'Sales call',
      }),
    );
    const [upstream] = (await connected) as [WebSocket];
    const [raw] = await once(upstream, 'message');
    expect(JSON.parse(String(raw))).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: null,
            transcription: {
              model: 'gpt-live-transcribe',
              languages: ['de'],
              prompt: 'Sales call',
              delay: 'low',
            },
          },
        },
      },
    });
    upstream.send(JSON.stringify({ type: 'session.created' }));
    expect(fixture.received).toEqual([]);
    upstream.send(JSON.stringify({ type: 'session.updated' }));
    await vi.waitFor(() => expect(fixture.received).toContainEqual({ type: 'ready' }));
    const audio = Buffer.alloc(4800).toString('base64');
    const audioReceived = once(upstream, 'message');
    fixture.client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
    expect(JSON.parse(String((await audioReceived)[0]))).toEqual({
      type: 'input_audio_buffer.append',
      audio,
    });
    const committed = once(upstream, 'message');
    fixture.client.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    expect(JSON.parse(String((await committed)[0]))).toEqual({ type: 'input_audio_buffer.commit' });
    upstream.send(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'Good morning',
      }),
    );
    await vi.waitFor(() =>
      expect(fixture.received).toContainEqual({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'Good morning',
      }),
    );
  });

  it('rejects foreign origins before any upstream connection', async () => {
    const fixture = await setup();
    const rejected = new WebSocket(fixture.wsUrl, { origin: 'https://evil.example' });
    sockets.push(rejected);
    rejected.on('error', () => {});
    const response = await new Promise<number | undefined>((resolve) =>
      rejected.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve(res.statusCode);
        rejected.terminate();
      }),
    );
    expect(response).toBe(403);
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it('surfaces upstream errors without forwarding credential-containing details', async () => {
    const fixture = await setup();
    const connected = once(fixture.upstreamServer, 'connection');
    fixture.client.send(
      JSON.stringify({ type: 'configure', model: 'gpt-live-transcribe', language: 'de' }),
    );
    const [upstream] = (await connected) as [WebSocket];
    await once(upstream, 'message');
    const closed = once(fixture.client, 'close');
    upstream.send(
      JSON.stringify({
        type: 'error',
        error: { code: 'invalid_api_key', message: 'secret-key-do-not-expose' },
      }),
    );
    await closed;
    expect(fixture.received).toEqual([
      {
        type: 'error',
        error: { code: 'invalid_api_key', message: expect.stringContaining('invalid_api_key') },
      },
    ]);
    expect(JSON.stringify(fixture.received)).not.toContain('secret-key-do-not-expose');
  });

  it('closes on pre-ready audio rather than losing queued samples silently', async () => {
    const fixture = await setup();
    const connected = once(fixture.upstreamServer, 'connection');
    fixture.client.send(JSON.stringify({ type: 'configure', model: 'gpt-live-transcribe' }));
    const [upstream] = (await connected) as [WebSocket];
    await once(upstream, 'message');
    const closed = once(fixture.client, 'close');
    fixture.client.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.alloc(4800).toString('base64'),
      }),
    );
    await closed;
    expect(fixture.received).toContainEqual({
      type: 'error',
      error: { code: 'not_ready', message: expect.any(String) },
    });
  });

  it('uses the correct language field for both model generations', () => {
    const legacy = transcriptionSession({
      type: 'configure',
      model: 'gpt-4o-mini-transcribe',
      language: 'de',
      prompt: '',
    });
    expect(legacy.session.audio.input.transcription).toEqual({
      model: 'gpt-4o-mini-transcribe',
      language: 'de',
    });
    const modern = transcriptionSession({
      type: 'configure',
      model: 'gpt-transcribe',
      language: 'de',
      prompt: '',
    });
    expect(modern.session.audio.input.transcription).toEqual({
      model: 'gpt-transcribe',
      languages: ['de'],
    });
  });
});
