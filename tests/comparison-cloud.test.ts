import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { replayCloudEngine, type CloudEngineId } from '../server/comparison-cloud.js';
import type { ComparisonEvent } from '../shared/comparison.js';
const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});
async function mock(id: CloudEngineId, fail = false) {
  const s = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(s);
  await new Promise<void>((resolve) => s.on('listening', resolve));
  const address = s.address();
  if (!address || typeof address === 'string') throw new Error('Invalid address');
  const received: Record<string, any>[] = [];
  let n = 0;
  s.on('connection', (ws) => {
    const send = (event: unknown) => ws.send(JSON.stringify(event));
    if (id === 'elevenlabs') send({ message_type: 'session_started' });
    ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString());
      received.push(e);
      if (e.type === 'session.update') send({ type: 'session.updated' });
      if (e.type === 'input_audio_buffer.commit' || e.commit) {
        if (fail) {
          send({
            message_type: 'auth_error',
            error: 'Missing speech_to_text permission for sk_testsecret',
          });
          return;
        }
        const item_id = String(++n);
        if (id === 'openai') {
          send({ type: 'input_audio_buffer.committed', item_id });
          send({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id,
            delta: 'Hallo',
          });
          send({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id,
            transcript: 'Hallo Welt',
          });
        } else {
          send({ message_type: 'partial_transcript', text: 'Hallo' });
          send({ message_type: 'committed_transcript', text: 'Hallo Welt' });
        }
      }
    });
  });
  return { received, factory: () => new WebSocket(`ws://127.0.0.1:${address.port}`) };
}
describe('native streaming comparison', () => {
  for (const id of ['openai', 'elevenlabs'] as const) {
    it(`${id}: paces identical speech, flushes the last phrase, scores finals and excludes secrets`, async () => {
      const mockServer = await mock(id);
      const events: ComparisonEvent[] = [];
      const result = await replayCloudEngine(
        id,
        'secret-test-key',
        new Int16Array(4800).fill(3000),
        'de',
        'Hallo Welt',
        new AbortController().signal,
        (e) => events.push(e),
        mockServer.factory,
      );
      expect(result.error).toBeUndefined();
      expect(result.transcript).toBe('Hallo Welt');
      expect(result.metrics.wer).toBe(0);
      expect(result.metrics.wallMs).toBeGreaterThanOrEqual(290);
      expect(result.metrics.finalTurns).toBe(1);
      expect(result.details?.processingMetricsAvailable).toBe(false);
      expect(events.some((e) => e.type === 'turn' && !e.final)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('secret-test-key');
      const audio = mockServer.received.filter((e) => e.audio || e.audio_base_64);
      expect(audio.length).toBeGreaterThan(1);
      if (id === 'openai')
        expect(mockServer.received[0].session.audio.input.transcription).toEqual({
          model: 'gpt-live-transcribe',
          languages: ['de'],
          delay: 'low',
        });
      else expect(audio.every((e) => e.sample_rate === 16000)).toBe(true);
    });
  }
  it('marks upstream errors as failed instead of reporting success', async () => {
    const server = await mock('elevenlabs', true);
    const result = await replayCloudEngine(
      'elevenlabs',
      'key',
      new Int16Array(4800).fill(3000),
      'de',
      '',
      new AbortController().signal,
      () => {},
      server.factory,
    );
    expect(result.error).toContain('auth_error');
    expect(result.error).toContain('Missing speech_to_text permission');
    expect(result.error).toContain('Speech to Text access');
    expect(result.error).not.toContain('sk_testsecret');
    expect(result.metrics.finalTurns).toBe(0);
  });
  it('cancels setup promptly without sending audio', async () => {
    const server = await mock('openai');
    const abort = new AbortController();
    abort.abort();
    await expect(
      replayCloudEngine(
        'openai',
        'key',
        new Int16Array(4800),
        'de',
        '',
        abort.signal,
        () => {},
        server.factory,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.received).toHaveLength(0);
  });
});
