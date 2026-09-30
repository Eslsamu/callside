import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { CaptureCallbacks, SpeakerAttribution } from '../shared/types';
import { createBackgroundSpeakerSink } from '../src/audio/background';
import { TranscriptReconciler } from '../src/audio/reconcile';

const callbacks = (): CaptureCallbacks => ({
  onTranscript: vi.fn(),
  onAttribution: vi.fn(),
  onAttributionStatus: vi.fn(),
  onLevel: vi.fn(),
  onStatus: vi.fn(),
  onError: vi.fn(),
  onEnded: vi.fn(),
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('background speaker analysis', () => {
  it('reuses clean voice clips across differently numbered chunks, without emitting duplicate text', async () => {
    const cb = callbacks();
    const bodies: Array<Record<string, any>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, request: RequestInit) => {
        const body = JSON.parse(String(request.body));
        bodies.push(body);
        return {
          ok: true,
          json: async () => ({
            entries: [
              {
                speaker: `system:${body.chunkId}:${bodies.length === 1 ? 'A' : 'speaker_1'}`,
                text: 'What would you suggest for our launch?',
                timestamp: body.timestamp,
                endTimestamp: body.timestamp + 3000,
              },
            ],
          }),
        };
      }),
    );
    const sink = createBackgroundSpeakerSink(
      { ...DEFAULT_SETTINGS, diarizationChunkSeconds: 4 },
      'token',
      cb,
    );
    sink.append(new Int16Array(4 * 24000).fill(2000), 1000);
    await tick();
    sink.append(new Int16Array(3 * 24000).fill(2000), 5000);
    await tick();
    await sink.stop();
    expect(bodies).toHaveLength(2); // stop does not resubmit the overlap by itself
    expect(bodies[0].knownSpeakers).toEqual([]);
    expect(bodies[1].knownSpeakers).toHaveLength(1);
    expect(bodies[1].knownSpeakers[0].name).toBe('speaker_1');
    expect(Buffer.from(bodies[1].knownSpeakers[0].audio, 'base64').subarray(0, 4).toString()).toBe(
      'RIFF',
    );
    expect(bodies[1].timestamp).toBe(4000); // one second of overlap at this batch size
    const updates = vi.mocked(cb.onAttribution!).mock.calls.map(([result]) => result);
    expect(updates.map((update) => update.segments[0].speakerId)).toEqual([
      'speaker_1',
      'speaker_1',
    ]);
    expect(updates[0].segments[0].speaker).toBe('Speaker 1');
    expect(cb.onTranscript).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(JSON.stringify(updates)).not.toContain('audio');
  });

  it('does not enroll overlapping voices or assume that file-local speaker A is stable', async () => {
    const cb = callbacks();
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, request: RequestInit) => {
        const body = JSON.parse(String(request.body));
        bodies.push(body);
        return {
          ok: true,
          json: async () => ({
            entries: [
              {
                speaker: 'A',
                text: 'First voice',
                timestamp: body.timestamp,
                endTimestamp: body.timestamp + 3000,
              },
              {
                speaker: 'B',
                text: 'Second voice',
                timestamp: body.timestamp + 1000,
                endTimestamp: body.timestamp + 3500,
              },
            ],
          }),
        };
      }),
    );
    const sink = createBackgroundSpeakerSink(
      { ...DEFAULT_SETTINGS, diarizationChunkSeconds: 4 },
      'token',
      cb,
    );
    sink.append(new Int16Array(4 * 24000).fill(2000), 1000);
    await tick();
    sink.append(new Int16Array(3 * 24000).fill(2000), 5000);
    await tick();
    await sink.stop();
    expect(bodies[1].knownSpeakers).toEqual([]);
    const updates = vi.mocked(cb.onAttribution!).mock.calls.map(([result]) => result);
    expect(updates[0].segments[0].attribution).toBe('chunk');
    expect(updates[0].segments[0].speakerId).not.toBe(updates[1].segments[0].speakerId);
  });

  it('pauses only background attribution after an API failure', async () => {
    const cb = callbacks();
    const fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Model unavailable' }),
    }));
    vi.stubGlobal('fetch', fetch);
    const sink = createBackgroundSpeakerSink(
      { ...DEFAULT_SETTINGS, diarizationChunkSeconds: 4 },
      'token',
      cb,
    );
    sink.append(new Int16Array(4 * 24000).fill(1000), 0);
    await tick();
    sink.append(new Int16Array(4 * 24000).fill(1000), 4000);
    await sink.stop();
    expect(fetch).toHaveBeenCalledOnce();
    expect(cb.onAttributionStatus).toHaveBeenLastCalledWith(
      expect.stringContaining('Live transcription continues'),
    );
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onEnded).not.toHaveBeenCalled();
  });

  it('bounds lag, flushes the last fresh audio, and cancels unfinished analysis after stop', async () => {
    vi.useFakeTimers();
    const cb = callbacks();
    const fetch = vi.fn(
      (_url: string, request: RequestInit) =>
        new Promise((_resolve, reject) => {
          request.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const sink = createBackgroundSpeakerSink(
      { ...DEFAULT_SETTINGS, diarizationChunkSeconds: 4 },
      'token',
      cb,
    );
    sink.append(new Int16Array(16 * 24000).fill(1000), 0);
    expect(cb.onAttributionStatus).toHaveBeenCalledWith(
      expect.stringContaining('skipping an older batch'),
    );
    const stopping = sink.stop();
    await vi.advanceTimersByTimeAsync(10000);
    await stopping;
    expect(fetch).toHaveBeenCalledOnce();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onAttributionStatus).toHaveBeenLastCalledWith(
      expect.stringContaining('live transcript is preserved'),
    );
  });

  it('skips silent audio and submits a final fresh partial batch', async () => {
    const fetch = vi.fn(async (_url: string, _request: RequestInit) => ({
      ok: true,
      json: async () => ({ entries: [] }),
    }));
    vi.stubGlobal('fetch', fetch);
    const sink = createBackgroundSpeakerSink(DEFAULT_SETTINGS, 'token', callbacks());
    sink.append(new Int16Array(12 * 24000), 1000);
    expect(fetch).not.toHaveBeenCalled();
    sink.append(new Int16Array(24000).fill(1000), 13000);
    await sink.stop();
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.timestamp).toBe(11000);
  });
});

function attribution(segments: SpeakerAttribution['segments']): SpeakerAttribution {
  return { chunkId: 'batch', timestamp: 1000, endTimestamp: 13000, receivedAt: 14000, segments };
}
const voice = (text: string, timestamp = 1000, endTimestamp = 4000, speakerId = 'speaker_1') => ({
  text,
  timestamp,
  endTimestamp,
  speakerId,
  speaker: `Speaker ${speakerId.slice(-1)}`,
  attribution: 'reference' as const,
});

describe('speaker labels on live transcript revisions', () => {
  it.each([true, false])(
    'merges either arrival order without duplicating words (labels first=%s)',
    (first) => {
      const reconciler = new TranscriptReconciler();
      const update = attribution([voice('What should we do next?')]);
      if (first) reconciler.attribute(update);
      reconciler.accept({
        id: 'system:turn',
        source: 'system',
        speaker: 'Other speaker',
        text: 'What should',
        timestamp: 1000,
        endTimestamp: 4200,
        final: false,
      });
      if (!first) reconciler.attribute(update);
      reconciler.accept({
        id: 'system:turn',
        source: 'system',
        speaker: 'Other speaker',
        text: 'What should we do next?',
        timestamp: 1000,
        endTimestamp: 4200,
        final: true,
      });
      const entries = reconciler.view().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: 'system:turn',
        turnId: 'system:turn',
        speaker: 'Speaker 1',
        text: 'What should we do next?',
        attribution: 'reference',
      });
      reconciler.accept({ ...entries[0], text: 'Late partial', final: false });
      expect(reconciler.view().entries[0].text).toBe('What should we do next?');
    },
  );

  it('splits a live turn containing two speakers, preserves its words, and keeps one automatic trigger ID', () => {
    const reconciler = new TranscriptReconciler();
    const text = 'The launch is next week. What will the first test cost?';
    reconciler.accept({
      id: 'system:turn',
      source: 'system',
      speaker: 'Other speaker',
      text,
      timestamp: 1000,
      endTimestamp: 8500,
      final: true,
    });
    reconciler.attribute(
      attribution([
        voice('The launch is next week.', 1000, 4000),
        voice('What will the first test cost?', 4500, 8000, 'speaker_2'),
      ]),
    );
    const entries = reconciler.view().entries;
    expect(entries.map((entry) => entry.speaker)).toEqual(['Speaker 1', 'Speaker 2']);
    expect(entries.map((entry) => entry.text).join(' ')).toBe(text);
    expect(entries[0].endTimestamp).toBe(entries[1].timestamp);
    expect(entries[1].endTimestamp).toBe(8500);
    expect(new Set(entries.map((entry) => entry.turnId))).toEqual(new Set(['system:turn']));
  });

  it('keeps microphone speech and unrelated words untouched, and clears identities for a new session', () => {
    const reconciler = new TranscriptReconciler();
    const entry = {
      id: 'mic:1',
      source: 'mic' as const,
      speaker: 'Me',
      text: 'What should we do next?',
      timestamp: 1000,
      endTimestamp: 4000,
      final: true,
    };
    reconciler.accept(entry);
    reconciler.accept({
      ...entry,
      id: 'system:other',
      source: 'system',
      speaker: 'Other speaker',
      text: 'A completely different topic.',
    });
    reconciler.attribute(attribution([voice(entry.text)]));
    expect(reconciler.view(false).entries[0]).toEqual(entry);
    expect(reconciler.view(false).entries[1].speaker).toBe('Other speaker');
    reconciler.clear();
    reconciler.accept({ ...entry, id: 'system:new', source: 'system', speaker: 'Other speaker' });
    expect(reconciler.view().entries[0].speaker).toBe('Other speaker');
  });
});
