import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/defaults.js';
import type { CaptureCallbacks } from '../shared/types.js';
import { createDiarizedSink, createRealtimeSink } from '../src/audio/transports.js';
import { startCapture } from '../src/audio/capture.js';

function callbacks(): CaptureCallbacks {
  return {
    onTranscript: vi.fn(),
    onLevel: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
    onEnded: vi.fn(),
  };
}

class TestSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static latest: TestSocket;
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: URL) {
    TestSocket.latest = this;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('realtime audio transport', () => {
  it('configures first, waits for readiness, then drains the last committed transcription on stop', async () => {
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:1234/' } });
    vi.stubGlobal('WebSocket', TestSocket);
    const cb = callbacks();
    const fail = vi.fn();
    let resolved = false;
    const pending = createRealtimeSink(DEFAULT_SETTINGS, 'token', 'mic', cb, fail).then((sink) => {
      resolved = true;
      return sink;
    });
    const socket = TestSocket.latest;
    socket.open();
    expect(socket.url.protocol).toBe('ws:');
    expect(socket.url.searchParams.get('source')).toBe('mic');
    expect(socket.sent[0]).toMatchObject({ type: 'configure', model: 'gpt-live-transcribe' });
    await Promise.resolve();
    expect(resolved).toBe(false);
    socket.emit({ type: 'ready' });
    const sink = await pending;
    sink.beginTurn(1000);
    sink.append(new Int16Array(4800).fill(500), 1000);
    const stopped = sink.stop();
    expect(socket.sent.map((event) => event.type)).toEqual([
      'configure',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
    expect(socket.readyState).toBe(TestSocket.OPEN);
    socket.emit({ type: 'input_audio_buffer.committed', item_id: 'last' });
    socket.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'last',
      transcript: 'Fertig.',
    });
    await stopped;
    expect(socket.readyState).toBe(TestSocket.CLOSED);
    expect(cb.onTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: 1000, text: 'Fertig.', final: true }),
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it('surfaces a provider error before ready instead of hanging or silently reconnecting', async () => {
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:1234/' } });
    vi.stubGlobal('WebSocket', TestSocket);
    const pending = createRealtimeSink(DEFAULT_SETTINGS, 'token', 'system', callbacks(), vi.fn());
    TestSocket.latest.open();
    TestSocket.latest.emit({ type: 'error', error: { message: 'Model unavailable' } });
    await expect(pending).rejects.toThrow('Model unavailable');
    expect(TestSocket.latest.readyState).toBe(TestSocket.CLOSED);
  });

  it('reports an unfinished final turn if the socket closes during stop', async () => {
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:1234/' } });
    vi.stubGlobal('WebSocket', TestSocket);
    const cb = callbacks();
    const pending = createRealtimeSink(DEFAULT_SETTINGS, 'token', 'mic', cb, vi.fn());
    TestSocket.latest.open();
    TestSocket.latest.emit({ type: 'ready' });
    const sink = await pending;
    sink.beginTurn(1000);
    sink.append(new Int16Array(4800).fill(500), 1000);
    const stopped = sink.stop();
    TestSocket.latest.close();
    await stopped;
    expect(cb.onError).toHaveBeenCalledOnce();
    expect(cb.onError).toHaveBeenCalledWith(expect.stringContaining('incomplete'));
  });
});

describe('diarization queue', () => {
  it('flushes a final partial block as valid WAV and waits for its transcript', async () => {
    const cb = callbacks();
    const fetch = vi.fn(async (_url: string, request: RequestInit) => {
      const body = JSON.parse(String(request.body)) as {
        audio: string;
        timestamp: number;
        source: string;
      };
      const bytes = Buffer.from(body.audio, 'base64');
      expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
      expect(bytes.readUInt32LE(40)).toBe(9600);
      expect(body.timestamp).toBe(5000);
      return {
        ok: true,
        json: async () => ({
          entries: [
            {
              id: 'system:block:A',
              speaker: 'A',
              source: 'system',
              text: 'Hello',
              timestamp: 5000,
              final: true,
            },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetch);
    const sink = createDiarizedSink(DEFAULT_SETTINGS, 'token', 'system', cb, vi.fn());
    sink.append(new Int16Array(4800).fill(1000), 5000);
    expect(fetch).not.toHaveBeenCalled();
    await sink.stop();
    expect(fetch).toHaveBeenCalledOnce();
    expect(cb.onTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Hello',
        timestamp: 5000,
        id: 'system:block:A',
        speaker: 'Other speaker · Speaker A · Chunk 1',
      }),
    );
  });

  it('stops explicitly when transcription falls behind, with a bounded queue', async () => {
    const fail = vi.fn();
    let aborted = false;
    const fetch = vi.fn(
      (_url: string, request: RequestInit) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const sink = createDiarizedSink(
      { ...DEFAULT_SETTINGS, diarizationChunkSeconds: 3 },
      'token',
      'system',
      callbacks(),
      fail,
    );
    for (let i = 0; i < 4; i++) sink.append(new Int16Array(72_000).fill(1000), i * 3000);
    await sink.stop();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledOnce();
    expect(fail.mock.calls[0][0]).toContain('cannot keep up');
    expect(aborted).toBe(true);
  });

  it('does not submit silent audio blocks', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const sink = createDiarizedSink(DEFAULT_SETTINGS, 'token', 'mic', callbacks(), vi.fn());
    sink.append(new Int16Array(24_000 * 20), 0);
    await sink.stop();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('capture startup cleanup', () => {
  it('releases an already granted system stream when microphone permission fails', async () => {
    const track = { stop: vi.fn(), onended: null };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => stream),
        getUserMedia: vi.fn(async () => {
          throw new DOMException('Permission denied', 'NotAllowedError');
        }),
      },
    });
    await expect(startCapture(DEFAULT_SETTINGS, 'token', callbacks())).rejects.toThrow(
      'Audio access was denied',
    );
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
