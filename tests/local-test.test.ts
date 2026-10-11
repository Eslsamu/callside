import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';
import { decodeLocalWav } from '../server/local-test-routes.js';
import { encodeWav } from '../src/audio/dsp.js';
import { LocalSpeechPipeline, type LocalTurn } from '../src/audio/local.js';

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('local Whisper test boundary', () => {
  it('serializes live microphone and call requests without a cloud key', async () => {
    let running = 0;
    let peak = 0;
    const server = await startServer({
      port: 0,
      apiOnly: true,
      apiKey: '',
      providerFactory: () => {
        throw new Error('Cloud access forbidden');
      },
      localEngine: {
        model: 'fixture',
        async transcribe() {
          running++;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 15));
          running--;
          return { text: 'Local speech', processingMs: 15 };
        },
      },
    });
    servers.push(server);
    const bootstrap = await fetch(`${server.url}/api/bootstrap`).then((r) => r.json());
    const headers = { 'Content-Type': 'application/json', 'X-Callside-Token': bootstrap.token };
    const post = (path: string, body: unknown) =>
      fetch(server.url + path, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post('/api/local/prepare', {})).status).toBe(200);
    const body = {
      audio: Buffer.from(encodeWav(new Int16Array(16000), 16000)).toString('base64'),
      language: 'auto',
    };
    const responses = await Promise.all([
      post('/api/local/transcribe', body),
      post('/api/local/transcribe', body),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(peak).toBe(1);
    expect((await post('/api/local/transcribe', { ...body, audio: 'invalid' })).status).toBe(400);
    expect(
      (
        await fetch(`${server.url}/api/local/prepare`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://untrusted.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });
  it('transcribes without constructing a cloud provider, and keeps timing history free of transcript text', async () => {
    const transcribe = vi.fn(async () => ({ text: 'A local phrase', processingMs: 123 }));
    const server = await startServer({
      port: 0,
      apiOnly: true,
      apiKey: '',
      localEngine: { model: 'test-model', transcribe },
      providerFactory: () => {
        throw new Error('Cloud access is forbidden');
      },
    });
    servers.push(server);
    const bootstrap = await fetch(`${server.url}/api/bootstrap`).then((r) => r.json());
    expect(bootstrap.hasApiKey).toBe(false);
    const headers = { 'Content-Type': 'application/json', 'X-Callside-Token': bootstrap.token };
    const payload = {
      audio: Buffer.from(encodeWav(new Int16Array(16000), 16000)).toString('base64'),
      language: 'de',
    };
    const post = (path: string, body: unknown, extra = {}) =>
      fetch(server.url + path, {
        method: 'POST',
        headers: { ...headers, ...extra },
        body: JSON.stringify(body),
      });
    expect(
      (await post('/api/local-test/transcribe', payload, { Origin: 'https://another.example' }))
        .status,
    ).toBe(403);
    expect(
      (await post('/api/local-test/transcribe', payload, { 'X-Callside-Token': 'wrong' })).status,
    ).toBe(403);
    expect(
      (await post('/api/local-test/transcribe', { ...payload, language: 'invalid' })).status,
    ).toBe(400);
    expect(await (await post('/api/local-test/transcribe', payload)).json()).toEqual({
      text: 'A local phrase',
      processingMs: 123,
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(
      await (
        await post('/api/local-test/measurements', {
          turnId: 'one',
          final: true,
          audioMs: 1000,
          processingMs: 123,
          requestMs: 130,
          queueMs: 0,
          speechToTextMs: 650,
          firstTextMs: 1650,
          transcript: 'Should not be retained',
        })
      ).json(),
    ).toEqual({ ok: true });
    const report = await fetch(`${server.url}/api/local-test/measurements`, { headers }).then((r) =>
      r.json(),
    );
    expect(report.measurements).toHaveLength(1);
    expect(JSON.stringify(report)).not.toMatch(/Should not|transcript/);
    await post('/api/local-test/measurements', { reset: true });
    expect(
      (await fetch(`${server.url}/api/local-test/measurements`, { headers }).then((r) => r.json()))
        .measurements,
    ).toEqual([]);
  });

  it('rejects malformed and oversized audio before invoking native code', () => {
    const wav = encodeWav(new Int16Array(1600), 16000);
    expect(decodeLocalWav(Buffer.from(wav).toString('base64')).length).toBe(wav.length);
    const badRate = encodeWav(new Int16Array(2400), 24000);
    expect(() => decodeLocalWav(Buffer.from(badRate).toString('base64'))).toThrow();
    expect(() =>
      decodeLocalWav(Buffer.from(encodeWav(new Int16Array(16000 * 14), 16000)).toString('base64')),
    ).toThrow();
    expect(() => decodeLocalWav('AAAA')).toThrow();
  });
});

describe('live local speech pipeline', () => {
  it('avoids repeated draft inference on CPUs and preserves more than four short queued phrases', async () => {
    let time = 0;
    let release!: () => void;
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const turns: LocalTurn[] = [];
    const onError = vi.fn();
    const transcribe = vi.fn(async () => {
      await blocked;
      return { text: 'phrase', processingMs: 100 };
    });
    const pipeline = new LocalSpeechPipeline(
      transcribe,
      {
        onTurn: (turn) => turns.push(turn),
        onError,
        onLevel: () => {},
        onStatus: () => {},
      },
      () => time,
      { drafts: false },
    );
    for (let phrase = 0; phrase < 8; phrase++) {
      for (let frame = 0; frame < 40; frame++) {
        time += 50;
        pipeline.feed(new Int16Array(800).fill(frame < 25 ? 3000 : 0));
      }
    }
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    const finished = pipeline.finish();
    release();
    await finished;
    expect(turns).toHaveLength(8);
    expect(turns.every((turn) => turn.final)).toBe(true);
  });

  it('drains queued speech after reaching the backlog limit instead of discarding it', async () => {
    let time = 0;
    let release!: () => void;
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const turns: LocalTurn[] = [];
    const onError = vi.fn();
    const pipeline = new LocalSpeechPipeline(
      async (_audio, signal) => {
        await blocked;
        expect(signal.aborted).toBe(false);
        return { text: 'captured speech', processingMs: 100 };
      },
      { onTurn: (turn) => turns.push(turn), onError, onLevel: () => {}, onStatus: () => {} },
      () => time,
      { drafts: false },
    );
    for (let i = 0; i < 2000; i++) {
      time += 50;
      pipeline.feed(new Int16Array(800).fill(3000));
    }
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toContain('finishing the captured speech');
    const finished = pipeline.finish();
    release();
    await finished;
    expect(turns.length).toBeGreaterThan(5);
    expect(turns.every((turn) => turn.final)).toBe(true);
  });

  it('coalesces drafts, preserves final turns under load, and drains the last words on stop', async () => {
    let time = 0;
    const pending: ((result: { text: string; processingMs: number }) => void)[] = [];
    const calls: number[] = [];
    const turns: LocalTurn[] = [];
    const onError = vi.fn();
    const pipeline = new LocalSpeechPipeline(
      async (samples) => {
        calls.push(samples.length);
        return new Promise((done) => pending.push(done));
      },
      { onTurn: (t) => turns.push(t), onError, onLevel: () => {}, onStatus: () => {} },
      () => time,
    );
    const feed = (frames: number, speaking = true) => {
      for (let i = 0; i < frames; i++) {
        time += 50;
        pipeline.feed(new Int16Array(800).fill(speaking ? 3000 : 0));
      }
    };
    feed(50);
    feed(11, false);
    feed(30);
    const finished = pipeline.finish();
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      expect(pending).toHaveLength(1);
      time += 300;
      pending.shift()!({ text: `phrase ${i}`, processingMs: 290 });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    await finished;
    expect(turns.filter((t) => t.final).map((t) => t.id)).toEqual(['turn-1', 'turn-2']);
    expect(turns[0].final).toBe(false);
    expect(turns.every((t) => t.measurement!.speechToTextMs >= 0)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not send silence for inference and aborts pending work when capture is canceled', async () => {
    let time = 0;
    let signal: AbortSignal | undefined;
    const transcribe = vi.fn(async (_audio, incoming: AbortSignal) => {
      signal = incoming;
      return await new Promise<{ text: string; processingMs: number }>((_done, reject) =>
        incoming.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    });
    const onError = vi.fn();
    const pipeline = new LocalSpeechPipeline(
      transcribe,
      { onTurn: () => {}, onError, onLevel: () => {}, onStatus: () => {} },
      () => time,
    );
    for (let i = 0; i < 100; i++) {
      time += 50;
      pipeline.feed(new Int16Array(800));
    }
    expect(transcribe).not.toHaveBeenCalled();
    for (let i = 0; i < 30; i++) {
      time += 50;
      pipeline.feed(new Int16Array(800).fill(3000));
    }
    expect(transcribe).toHaveBeenCalledTimes(1);
    pipeline.cancel();
    expect(signal!.aborted).toBe(true);
    await pipeline.finish();
    expect(onError).not.toHaveBeenCalled();
  });
});
