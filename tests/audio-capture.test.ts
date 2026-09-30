import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { startCapture } from '../src/audio/capture';
import { createRealtimeSink, createDiarizedSink } from '../src/audio/transports';

vi.mock('../src/audio/transports', () => ({
  createRealtimeSink: vi.fn(),
  createDiarizedSink: vi.fn(),
}));

function track(kind: 'audio' | 'video', state: 'live' | 'ended' = 'live') {
  const value = {
    kind,
    readyState: state,
    onended: null,
    stop: vi.fn(() => {
      value.readyState = 'ended';
    }),
  };
  return value;
}

function stream(tracks: ReturnType<typeof track>[]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'),
  } as unknown as MediaStream;
}

const callbacks = () => ({
  onTranscript: vi.fn(),
  onLevel: vi.fn(),
  onStatus: vi.fn(),
  onError: vi.fn(),
  onEnded: vi.fn(),
});

describe('audio acquisition failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal('window', { callsideDesktop: { platform: 'darwin' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['missing', 'ended'] as const)(
    'rejects %s call audio and releases every source before opening the API',
    async (state) => {
      const mic = track('audio');
      const video = track('video');
      const callTracks = state === 'missing' ? [video] : [video, track('audio', 'ended')];
      const getDisplayMedia = vi.fn(async () => stream(callTracks));
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn(async () => stream([mic])),
          getDisplayMedia,
        },
      });
      const events = callbacks();
      await expect(startCapture(DEFAULT_SETTINGS, 'synthetic-token', events)).rejects.toThrow(
        state === 'missing'
          ? 'macOS returned a screen stream without an audio track'
          : 'macOS ended the call audio track before recording started',
      );
      expect(getDisplayMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: true,
          systemAudio: 'include',
        }),
      );
      for (const item of [mic, ...callTracks]) {
        expect(item.stop).toHaveBeenCalledOnce();
        expect(item.readyState).toBe('ended');
      }
      expect(createRealtimeSink).not.toHaveBeenCalled();
      expect(createDiarizedSink).not.toHaveBeenCalled();
      expect(events.onEnded).not.toHaveBeenCalled();
    },
  );

  it('does not request screen sharing for a microphone-only session', async () => {
    const getDisplayMedia = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => stream([])),
        getDisplayMedia,
      },
    });
    await expect(
      startCapture({ ...DEFAULT_SETTINGS, captureSystem: false }, 'synthetic-token', callbacks()),
    ).rejects.toThrow('The microphone supplied no live audio');
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(createRealtimeSink).not.toHaveBeenCalled();
  });
});
