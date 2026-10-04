import { parentPort, workerData } from 'node:worker_threads';
import { PortableSpeakerRuntime } from './portable-speaker-runtime.js';

if (!parentPort || typeof workerData?.model !== 'string')
  throw new Error('Missing speaker worker model.');
const port = parentPort;
try {
  const runtime = await PortableSpeakerRuntime.create(workerData.model);
  let busy = false;
  port.on('message', async (message) => {
    if (busy || !Number.isSafeInteger(message?.id)) {
      port.postMessage({ error: 'Invalid speaker worker request.' });
      return;
    }
    busy = true;
    try {
      const result = await runtime.request(message.audio, message.final === true);
      port.postMessage({ id: message.id, ...result });
    } catch {
      port.postMessage({ error: 'Local speaker analysis failed.' });
    } finally {
      busy = false;
    }
  });
  port.postMessage({ ready: true, model: 'LS-EEND AMI · ONNX CPU', maxSpeakers: 4 });
} catch {
  port.postMessage({ error: 'Local speaker model could not load.' });
}
