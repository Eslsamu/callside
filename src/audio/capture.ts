import type { CaptureCallbacks, CaptureHandle, Settings, Source } from '../../shared/types.js';
import { floatToPcm16, rms, StreamingResampler, VoiceActivityDetector } from './dsp.js';
import { createDiarizedSink, createRealtimeSink, type AudioSink } from './transports.js';

interface SourceCapture {
  source: Source;
  stream: MediaStream;
  context?: AudioContext;
  node?: AudioWorkletNode;
  input?: MediaStreamAudioSourceNode;
  sink?: AudioSink;
  vad?: VoiceActivityDetector;
  finishWorklet?: () => Promise<void>;
  signalTimer?: ReturnType<typeof setTimeout>;
}

function captureError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  if (error.name === 'NotAllowedError')
    return new Error(
      'Audiozugriff wurde nicht freigegeben. Erlaube Mikrofon und Systemaudio in den Systemeinstellungen und starte die Aufnahme erneut.',
    );
  if (error.name === 'NotFoundError')
    return new Error('Der ausgewählte Audioeingang ist nicht verfügbar. Wähle ein anderes Gerät.');
  if (error.name === 'NotReadableError')
    return new Error(
      'Der Audioeingang konnte nicht geöffnet werden. Prüfe das Gerät und seine Systemberechtigungen.',
    );
  return error;
}

export async function startCapture(
  settings: Settings,
  token: string,
  callbacks: CaptureCallbacks,
): Promise<CaptureHandle> {
  if (!settings.captureMic && !settings.captureSystem)
    throw new Error('Wähle mindestens eine Audioquelle aus.');
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('Audioaufnahme benötigt localhost oder HTTPS und einen unterstützten Browser.');
  if (!globalThis.AudioWorkletNode)
    throw new Error(
      'Dieser Browser unterstützt keine AudioWorklets. Nutze die Desktop-App oder einen aktuellen Chromium-Browser.',
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
          if (capture.vad?.flush()) capture.sink?.commit();
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
          await capture.sink?.stop();
          callbacks.onLevel(capture.source, 0);
          callbacks.onStatus(capture.source, 'Beendet');
        }),
      );
      if (initialized) callbacks.onEnded();
    })();
    return stopPromise;
  };
  const fail = (message: string) => {
    if (failed || stopping) return;
    failed = true;
    callbacks.onError(message);
    if (initialized) void stop();
  };

  const acquire = async (source: Source, request: Promise<MediaStream>) => {
    const stream = await request;
    const capture: SourceCapture = { source, stream };
    sources.push(capture);
    if (!stream.getAudioTracks().length)
      throw new Error(
        'Die Freigabe enthält kein Systemaudio. Aktiviere „Audio teilen“, verwende die Desktop-App oder wähle einen virtuellen Audioeingang.',
      );
    // Display capture requires a video track. It stays local and is released with the session.
    for (const track of stream.getTracks())
      track.onended = () => {
        if (!stopping) {
          callbacks.onStatus(source, 'Audiofreigabe beendet');
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
      callbacks.onStatus('system', 'Audioquelle auswählen …');
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
          });
      requests.push(acquire('system', request));
    }
    if (settings.captureMic) {
      callbacks.onStatus('mic', 'Mikrofon verbinden …');
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

    if (stopping || startupEnded)
      throw new Error('Die Audiofreigabe wurde während des Starts beendet.');
    const prepared = await Promise.allSettled(
      sources.map(async (capture) => {
        capture.sink =
          settings.captureMode === 'diarized'
            ? createDiarizedSink(settings, token, capture.source, callbacks, fail)
            : await createRealtimeSink(settings, token, capture.source, callbacks, fail);
        if (stopping) {
          await capture.sink.stop();
          throw new Error('Die Aufnahme wurde während des Starts beendet.');
        }
        const context = new AudioContext({ latencyHint: 'interactive' });
        capture.context = context;
        await context.audioWorklet.addModule('/pcm-worklet.js');
        if (stopping) throw new Error('Die Aufnahme wurde während des Starts beendet.');
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
        const vad = settings.captureMode === 'realtime' ? new VoiceActivityDetector() : undefined;
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
          const level = rms(samples);
          callbacks.onLevel(capture.source, Math.min(1, level * 5));
          if (level > 0.003 && !hadSignal) {
            hadSignal = true;
            clearTimeout(capture.signalTimer);
            callbacks.onStatus(
              capture.source,
              settings.captureMode === 'realtime' ? 'Live' : 'Hört zu · Sprecher je Block',
            );
          }
          if (vad) {
            const result = vad.feed(samples);
            if (result.startedAtSample !== undefined)
              capture.sink!.beginTurn(originTime + result.startedAtSample / 24);
            for (const part of result.audio) capture.sink!.append(part, timestamp);
            if (result.commit) capture.sink!.commit();
          } else capture.sink!.append(samples, timestamp);
        };
        node.onprocessorerror = () =>
          fail('Die Audioverarbeitung wurde unterbrochen. Starte die Aufnahme erneut.');
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
              'Noch kein Audiosignal · Quelle und Berechtigung prüfen',
            );
        }, 12_000);
      }),
    );
    const preparationFailed = prepared.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (preparationFailed) throw preparationFailed.reason;
    if (stopping || startupEnded)
      throw new Error('Die Audiofreigabe wurde während des Starts beendet.');
    if (failed) throw new Error('Die Audioverbindung wurde während des Starts unterbrochen.');
    initialized = true;
    return { stop };
  } catch (error) {
    await stop();
    throw captureError(error);
  }
}
