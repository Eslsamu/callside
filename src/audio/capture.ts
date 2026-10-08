import { createLocalSpeakerSink } from './local-speakers';
import type { CaptureCallbacks, CaptureHandle, Settings, Source } from '../../shared/types.js';
import { floatToPcm16, rms, StreamingResampler, VoiceActivityDetector } from './dsp.js';
import { createDiarizedSink, createRealtimeSink, type AudioSink } from './transports.js';
import { createBackgroundSpeakerSink } from './background.js';
import { createLocalSink, prepareLocal } from './local-sink.js';

interface SourceCapture {
  source: Source;
  stream: MediaStream;
  context?: AudioContext;
  node?: AudioWorkletNode;
  input?: MediaStreamAudioSourceNode;
  sink?: AudioSink;
  background?: AudioSink;
  lastAudioEnd?: number;
  vad?: VoiceActivityDetector;
  finishWorklet?: () => Promise<void>;
  signalTimer?: ReturnType<typeof setTimeout>;
}

function captureError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  if (error.name === 'NotAllowedError')
    return new Error(
      'Audio access was denied. Allow microphone and system audio in system settings and restart recording.',
    );
  if (error.name === 'NotFoundError')
    return new Error(
      'The selected audio input is unavailable. Select a connected microphone, check the operating system default input and microphone permissions, then retry.',
    );
  if (error.name === 'NotReadableError')
    return new Error(
      'Could not open the audio input. Check the device and its system permissions.',
    );
  return error;
}

export async function startCapture(
  settings: Settings,
  token: string,
  callbacks: CaptureCallbacks,
): Promise<CaptureHandle> {
  if (!settings.captureMic && !settings.captureSystem)
    throw new Error('Select at least one audio source.');
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('Audio capture requires localhost or HTTPS and a supported browser.');
  if (!globalThis.AudioWorkletNode)
    throw new Error(
      'This browser does not support AudioWorklets. Use the desktop app or a current Chromium browser.',
    );
  const sources: SourceCapture[] = [];
  let stopping = false;
  let initialized = false;
  let failed = false;
  let startupEnded = false;
  let stopPromise: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      // Flush the worklet before detaching tracks so the final partial audio batch survives.
      await Promise.all(
        sources.map(async (capture) => {
          clearTimeout(capture.signalTimer);
          try {
            await capture.finishWorklet?.();
          } catch {
            /* bounded flush below still releases tracks */
          }
          if (capture.vad?.flush()) capture.sink?.commit(capture.lastAudioEnd);
          capture.node?.disconnect();
          capture.input?.disconnect();
          for (const track of capture.stream.getTracks()) {
            track.onended = null;
            track.stop();
          }
          if (capture.context && capture.context.state !== 'closed')
            await capture.context.close().catch(() => undefined);
        }),
      );
      await Promise.all(
        sources.map(async (capture) => {
          await Promise.all([capture.sink?.stop(), capture.background?.stop()]);
          callbacks.onLevel(capture.source, 0);
          callbacks.onStatus(capture.source, 'Ended');
        }),
      );
      if (initialized) callbacks.onEnded();
    })();
    return stopPromise;
  };
  const fail = (message: string) => {
    // Final inference can fail after capture stops. Keep that error visible to the report.
    if (failed) return;
    failed = true;
    callbacks.onError(message);
    if (initialized && !stopping) void stop();
  };

  const acquire = async (source: Source, request: Promise<MediaStream>) => {
    const stream = await request;
    const capture: SourceCapture = { source, stream };
    sources.push(capture);
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.some((track) => track.readyState === 'live')) {
      if (source === 'mic')
        throw new Error(
          'The microphone supplied no live audio. Select another microphone in Settings.',
        );
      if (settings.systemDeviceId)
        throw new Error(
          'The call audio input supplied no live audio. Select another input in Settings.',
        );
      if (window.callsideDesktop?.platform === 'darwin')
        throw new Error(
          `${audioTracks.length ? 'macOS ended the call audio track before recording started.' : 'macOS returned a screen stream without an audio track.'} Allow Callside in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen Callside. A virtual audio input can be selected in Settings if capture is still unavailable.`,
        );
      throw new Error(
        'The shared stream supplied no live call audio. Share the call tab with audio enabled, or select a virtual audio input in Settings.',
      );
    }
    // Display capture requires a video track. It stays local and is released with the session.
    for (const track of stream.getTracks())
      track.onended = () => {
        if (!stopping) {
          callbacks.onStatus(source, 'Audio sharing ended');
          if (initialized) void stop();
          else startupEnded = true;
        }
      };
    return capture;
  };

  try {
    // Invoke display capture while the user's click is still the active browser gesture.
    const requests: Promise<SourceCapture>[] = [];
    if (settings.captureSystem) {
      callbacks.onStatus('system', 'Select audio source …');
      const systemDeviceId = (settings as Settings & { systemDeviceId?: string }).systemDeviceId;
      const request = systemDeviceId
        ? navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: systemDeviceId },
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
            video: false,
          })
        : navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: { width: 320, height: 180, frameRate: 1 },
            // Explicitly request system audio; the chosen surface must still supply a live track.
            systemAudio: 'include',
          } as DisplayMediaStreamOptions & { systemAudio: 'include' });
      requests.push(
        acquire(
          'system',
          request.catch(async (error: unknown) => {
            if (!systemDeviceId && window.callsideDesktop?.platform === 'darwin') {
              const status = await window.callsideDesktop
                .getCaptureStatus?.()
                .catch(() => undefined);
              if (status?.failure === 'missing-user-gesture')
                throw new Error(
                  'System audio capture requires a fresh click. Click Start call again.',
                );
              if (status?.failure === 'untrusted-request')
                throw new Error(
                  'Callside rejected the capture request. Quit and reopen the app, then retry.',
                );
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(
                'macOS could not start system audio capture. ' +
                  (status?.packaged === false
                    ? 'This is a development build: enable the terminal or IDE that launched it (for example iTerm) in System Settings > Privacy & Security > Screen & System Audio Recording, then fully quit and reopen that terminal or IDE and relaunch Callside. Permissions for installed Callside copies may not apply to this build. '
                    : 'Allow this copy of Callside in System Settings > Privacy & Security > Screen & System Audio Recording, then fully quit and reopen it. ') +
                  `Details: ${status?.screenPermission ?? 'unknown permission'}; ${status?.failure || reason}.`,
              );
            }
            throw error;
          }),
        ),
      );
    }
    if (settings.captureMic) {
      callbacks.onStatus('mic', 'Connecting microphone …');
      requests.push(
        acquire(
          'mic',
          navigator.mediaDevices.getUserMedia({
            audio: {
              ...(settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : {}),
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          }),
        ),
      );
    }
    const acquired = await Promise.allSettled(requests);
    const rejected = acquired.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;

    if (stopping || startupEnded) throw new Error('Audio sharing ended during startup.');
    if (settings.transcriptionProvider === 'local') {
      for (const capture of sources)
        callbacks.onStatus(capture.source, 'Preparing local Whisper · reusing downloaded models …');
      await prepareLocal(token, (progress) => {
        for (const capture of sources)
          callbacks.onStatus(
            capture.source,
            progress.message +
              (progress.percent === undefined ? '' : ' · ' + Math.round(progress.percent) + '%'),
          );
      });
    }
    const prepared = await Promise.allSettled(
      sources.map(async (capture) => {
        capture.sink =
          settings.transcriptionProvider === 'local'
            ? createLocalSink(settings, token, capture.source, callbacks, fail)
            : settings.captureMode === 'diarized'
              ? createDiarizedSink(settings, token, capture.source, callbacks, fail)
              : await createRealtimeSink(settings, token, capture.source, callbacks, fail);
        if (stopping) {
          await capture.sink.stop();
          throw new Error('Recording ended during startup.');
        }
        if (
          settings.captureMode === 'realtime' &&
          settings.backgroundSpeakers &&
          capture.source === 'system'
        ) {
          callbacks.onAttributionStatus?.('Loading speaker labeling…');
          capture.background =
            settings.diarizationProvider === 'local'
              ? await createLocalSpeakerSink(token, callbacks)
              : createBackgroundSpeakerSink(settings, token, callbacks);
        }
        const context = new AudioContext({ latencyHint: 'interactive' });
        capture.context = context;
        await context.audioWorklet.addModule('/pcm-worklet.js');
        if (stopping) throw new Error('Recording ended during startup.');
        const node = new AudioWorkletNode(context, 'callside-pcm', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        capture.node = node;
        const input = context.createMediaStreamSource(
          new MediaStream(capture.stream.getAudioTracks()),
        );
        capture.input = input;
        const resampler = new StreamingResampler(context.sampleRate);
        const vad =
          settings.captureMode === 'realtime' && settings.transcriptionProvider !== 'local'
            ? new VoiceActivityDetector()
            : undefined;
        capture.vad = vad;
        let originTime = Date.now() - context.currentTime * 1000;
        let firstPacket = true;
        let receivedSamples = 0;
        let hadSignal = false;
        let accepting = true;
        let flushed: (() => void) | undefined;
        node.port.onmessage = (
          event: MessageEvent<{ type: string; samples?: ArrayBuffer; startFrame?: number }>,
        ) => {
          if (event.data.type === 'flushed') {
            accepting = false;
            flushed?.();
            return;
          }
          if (!accepting || !event.data.samples) return;
          const samples = floatToPcm16(resampler.process(new Float32Array(event.data.samples)));
          if (!samples.length) return;
          if (firstPacket) {
            originTime += ((event.data.startFrame ?? 0) / context.sampleRate) * 1000;
            firstPacket = false;
          }
          const timestamp = originTime + receivedSamples / 24;
          receivedSamples += samples.length;
          capture.lastAudioEnd = timestamp + samples.length / 24;
          const level = rms(samples);
          // Analyze the continuous system timeline, not the VAD's cropped live turns.
          capture.background?.append(samples, timestamp);
          callbacks.onLevel(capture.source, Math.min(1, level * 5));
          if (level > 0.003 && !hadSignal) {
            hadSignal = true;
            clearTimeout(capture.signalTimer);
            callbacks.onStatus(
              capture.source,
              settings.captureMode === 'realtime' ? 'Live' : 'Listening · speakers per chunk',
            );
          }
          if (vad) {
            const result = vad.feed(samples);
            if (result.startedAtSample !== undefined)
              capture.sink!.beginTurn(originTime + result.startedAtSample / 24);
            for (const part of result.audio) capture.sink!.append(part, timestamp);
            if (result.commit) capture.sink!.commit(timestamp + samples.length / 24);
          } else capture.sink!.append(samples, timestamp);
        };
        node.onprocessorerror = () => fail('Audio processing was interrupted. Restart recording.');
        capture.finishWorklet = () =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              accepting = false;
              resolve();
            }, 300);
            flushed = () => {
              clearTimeout(timer);
              resolve();
            };
            node.port.postMessage({ type: 'flush' });
          });
        input.connect(node);
        node.connect(context.destination);
        await context.resume();
        capture.signalTimer = setTimeout(() => {
          if (!hadSignal && !stopping)
            callbacks.onStatus(
              capture.source,
              'No audio signal yet · check source and permissions',
            );
        }, 12_000);
      }),
    );
    const preparationFailed = prepared.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (preparationFailed) throw preparationFailed.reason;
    if (stopping || startupEnded) throw new Error('Audio sharing ended during startup.');
    if (failed) throw new Error('The audio connection was interrupted during startup.');
    initialized = true;
    return { stop };
  } catch (error) {
    await stop();
    throw captureError(error);
  }
}
