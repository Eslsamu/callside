import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'node:http';
import { startServer, type RunningServer } from '../server/index.js';
import { WAIT_SENTINEL, type AiProvider, type AnswerInput } from '../server/provider.js';
import { DEFAULT_SETTINGS } from '../shared/defaults.js';
import type { AnswerRequest } from '../shared/types.js';

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
const body = (overrides: Partial<AnswerRequest> = {}): AnswerRequest => ({
  settings: { ...DEFAULT_SETTINGS },
  transcript: [],
  question: '',
  mode: 'manual',
  previousSuggestions: [],
  ...overrides,
});
async function running(provider?: AiProvider) {
  const server = await startServer({
    port: 0,
    apiOnly: true,
    production: true,
    apiKey: provider ? 'test-only-never-upstream' : '',
    providerFactory: () => {
      if (!provider) throw new Error('Demo must never construct a provider');
      return provider;
    },
  });
  servers.push(server);
  const bootstrapResponse = await fetch(`${server.url}/api/bootstrap`);
  const bootstrap = (await bootstrapResponse.json()) as { token: string; hasApiKey: boolean };
  const headers = {
    'Content-Type': 'application/json',
    'X-Callside-Token': bootstrap.token,
    Origin: server.url,
  };
  return {
    ...server,
    bootstrap,
    headers,
    post: (path: string, payload: unknown, extra?: RequestInit) =>
      fetch(`${server.url}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        ...extra,
      }),
  };
}
const simpleProvider = (chunks: string[]): AiProvider => ({
  async *answer() {
    for (const text of chunks) yield { type: 'delta', text };
    yield { type: 'done' };
  },
  async diarize() {
    return [];
  },
});
function events(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

describe('local HTTP API', () => {
  it('requires exact local host/origin and token, without CORS or credential exposure', async () => {
    const server = await running();
    expect(server.bootstrap).toEqual({
      token: expect.stringMatching(/^[a-f0-9]{64}$/),
      hasApiKey: false,
      models: expect.any(Array),
    });
    expect(
      (await fetch(`${server.url}/api/bootstrap`, { headers: { Origin: 'https://evil.example' } }))
        .status,
    ).toBe(403);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${server.url}/api/bootstrap`, { headers: { Host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(badHostStatus).toBe(403);
    expect(
      (await fetch(`${server.url}/api/bootstrap`, { headers: { 'Sec-Fetch-Site': 'cross-site' } }))
        .status,
    ).toBe(403);
    expect(
      (
        await fetch(`${server.url}/api/key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    const result = await server.post('/api/key', { apiKey: 'sk-this-is-a-local-test-key' });
    expect(await result.json()).toEqual({ hasApiKey: true });
    const bootstrap = await fetch(`${server.url}/api/bootstrap`);
    expect(bootstrap.headers.get('cache-control')).toBe('no-store');
    expect(bootstrap.headers.get('access-control-allow-origin')).toBeNull();
    expect(await bootstrap.text()).not.toContain('sk-this');
    expect(await (await server.post('/api/key', { apiKey: '' })).json()).toEqual({
      hasApiKey: false,
    });
  });

  it('validates before opening paid provider requests', async () => {
    const answer = vi.fn(simpleProvider([]).answer);
    const server = await running({ ...simpleProvider([]), answer });
    expect(
      (
        await server.post(
          '/api/answer',
          body({ settings: { ...DEFAULT_SETTINGS, model: '../../private' as never } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await server.post('/api/answer', body({ transcript: [{ id: 'bad' } as never] }))).status,
    ).toBe(400);
    expect(
      (
        await server.post('/api/diarize', {
          audio: Buffer.alloc(50).toString('base64'),
          source: 'system',
          chunkId: '1',
          timestamp: 100,
        })
      ).status,
    ).toBe(400);
    expect(answer).not.toHaveBeenCalled();
  });

  it('streams deterministic demo output without a key or provider call', async () => {
    const server = await running();
    expect((await server.post('/api/answer', body())).status).toBe(401);
    const response = await server.post('/api/answer', body({ demo: true }));
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const output = events(await response.text());
    expect(
      output
        .filter((event) => event.type === 'delta')
        .map((event) => event.text)
        .join(''),
    ).toContain('Demo suggestion');
    expect(output.at(-1)).toEqual({ type: 'done' });
  });

  it('hides a WAIT sentinel split across provider events and resumes ordinary streaming', async () => {
    const server = await running(simpleProvider([' ', '[[WA', 'IT', ']]', '\n']));
    expect(events(await (await server.post('/api/answer', body({ mode: 'auto' }))).text())).toEqual(
      [{ type: 'skip' }],
    );
    const ordinary = await running(simpleProvider(['How ', 'can we get started?']));
    expect(
      events(await (await ordinary.post('/api/answer', body({ mode: 'auto' }))).text()),
    ).toEqual([
      { type: 'delta', text: 'How ' },
      { type: 'delta', text: 'can we get started?' },
      { type: 'done' },
    ]);
    expect(WAIT_SENTINEL).toBe('[[WAIT]]');
  });

  it('caps the newest context and output budget, with quoted transcript data', async () => {
    let captured: AnswerInput | undefined;
    const server = await running({
      ...simpleProvider([]),
      async *answer(input) {
        captured = input;
        yield { type: 'delta', text: 'Antwort' };
        yield { type: 'done' };
      },
    });
    const transcript = Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      source: 'system' as const,
      speaker: 'Other speaker',
      text: `${i}: ` + 'x'.repeat(300),
      timestamp: i,
      final: true,
    }));
    await (
      await server.post(
        '/api/answer',
        body({ transcript, settings: { ...DEFAULT_SETTINGS, maxOutputTokens: 99000 } }),
      )
    ).text();
    expect(captured?.maxOutputTokens).toBe(32768);
    expect(captured?.instructions).toContain('untrusted');
    const context = JSON.parse(captured!.input).callTranscript as Array<{ text: string }>;
    expect(context.at(-1)?.text.startsWith('199:')).toBe(true);
    expect(context.some((entry) => entry.text.startsWith('0:'))).toBe(false);
    expect(context.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(24000);
  });

  it('sanitizes provider errors and never reports completion after failure', async () => {
    const server = await running({
      ...simpleProvider([]),
      async *answer() {
        throw new Error('sk-secret transcript-content');
      },
    });
    const text = await (await server.post('/api/answer', body())).text();
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('transcript-content');
    expect(events(text)).toEqual([{ type: 'error', message: expect.stringContaining('OpenAI') }]);
  });

  it('cancels upstream generation when the browser cancels a request', async () => {
    let signal: AbortSignal | undefined;
    const server = await running({
      ...simpleProvider([]),
      async *answer(_input, abort) {
        signal = abort;
        yield { type: 'delta', text: 'Start' };
        await new Promise((resolve) => abort.addEventListener('abort', resolve, { once: true }));
      },
    });
    const cancel = new AbortController();
    const response = await server.post('/api/answer', body(), { signal: cancel.signal });
    await response.body!.getReader().read();
    cancel.abort();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it('bounds concurrent answers and releases slots after cancellation', async () => {
    const server = await running({
      ...simpleProvider([]),
      async *answer(_input, abort) {
        yield { type: 'delta', text: 'Start' };
        await new Promise((resolve) => abort.addEventListener('abort', resolve, { once: true }));
      },
    });
    const one = new AbortController();
    const two = new AbortController();
    const first = await server.post('/api/answer', body(), { signal: one.signal });
    const second = await server.post('/api/answer', body(), { signal: two.signal });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await server.post('/api/answer', body())).status).toBe(429);
    one.abort();
    two.abort();
  });
});
