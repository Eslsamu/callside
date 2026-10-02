import type { Express } from 'express';
import { z } from 'zod';
import type { LocalEngine, LocalMeasurement } from '../shared/local-test.js';

const duration = z.number().finite().min(0).max(600000);
const measurement = z.object({
  turnId: z.string().min(1).max(80),
  final: z.boolean(),
  audioMs: duration,
  processingMs: duration,
  requestMs: duration,
  queueMs: duration,
  speechToTextMs: duration,
  firstTextMs: duration,
});
const request = z.object({
  audio: z
    .string()
    .min(60)
    .max(900000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  language: z.enum(['de', 'en', 'auto']),
});

/** Strict canonical PCM16 mono 16 kHz, at most 13 seconds per local request. */
export function decodeLocalWav(encoded: string, maxSeconds = 13): Buffer {
  const b = Buffer.from(encoded, 'base64');
  if (
    b.length < 3244 ||
    b.length > 44 + 32000 * maxSeconds ||
    b.toString('base64') !== encoded ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    b.readUInt32LE(4) !== b.length - 8 ||
    b.readUInt32LE(16) !== 16 ||
    b.readUInt16LE(20) !== 1 ||
    b.readUInt16LE(22) !== 1 ||
    b.readUInt32LE(24) !== 16000 ||
    b.readUInt32LE(28) !== 32000 ||
    b.readUInt16LE(32) !== 2 ||
    b.readUInt16LE(34) !== 16 ||
    b.toString('ascii', 36, 40) !== 'data' ||
    b.readUInt32LE(40) !== b.length - 44 ||
    (b.length - 44) % 2 !== 0
  )
    throw new Error(`Expected PCM16 mono 16 kHz WAV, up to ${maxSeconds} seconds.`);
  return b;
}

/** Installed after the app's same-origin, session-token, and JSON guards. */
export function attachLocalTest(app: Express, engine?: LocalEngine) {
  let measurements: LocalMeasurement[] = [];
  let busy = false;
  app.get('/api/local-test/status', (_req, res) =>
    res.json({ ready: Boolean(engine), model: engine?.model ?? null }),
  );
  app.get('/api/local-test/measurements', (_req, res) =>
    res.json({ model: engine?.model ?? null, measurements }),
  );
  app.post('/api/local-test/measurements', (req, res) => {
    if (req.body?.reset === true) {
      measurements = [];
      res.json({ ok: true });
      return;
    }
    const parsed = measurement.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid timing measurement.' });
      return;
    }
    measurements.push(parsed.data);
    measurements = measurements.slice(-2000);
    res.json({ ok: true });
  });
  app.post('/api/local-test/transcribe', async (req, res) => {
    if (!engine) {
      res.status(503).json({ error: 'Start the local engine with npm run local:test.' });
      return;
    }
    if (busy) {
      res.status(429).json({ error: 'Local Whisper is busy. Stop the other test and retry.' });
      return;
    }
    const parsed = request.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid local audio request.' });
      return;
    }
    let audio: Buffer;
    try {
      audio = decodeLocalWav(parsed.data.audio);
    } catch {
      res.status(400).json({ error: 'Invalid local WAV audio.' });
      return;
    }
    busy = true;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    res.on('close', cancel);
    try {
      res.json(await engine.transcribe(audio, parsed.data.language, abort.signal));
    } catch (error) {
      if (!res.destroyed)
        res
          .status(502)
          .json({ error: error instanceof Error ? error.message : 'Local transcription failed.' });
    } finally {
      busy = false;
      res.off('close', cancel);
    }
  });
}
