const { readFile, writeFile, mkdir, rename, rm } = require('node:fs/promises');
const { dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');

// The preview checkpoint is separate from credentials and the normal template.
const text = z.string().max(12000);
const number = z.number().finite();
const entry = z.object({
  id: z.string().max(200),
  source: z.enum(['mic', 'system']),
  speaker: z.string().max(200),
  text,
  timestamp: number,
  endTimestamp: number.optional(),
  final: z.boolean(),
  attribution: z.enum(['local', 'reference', 'chunk']).optional(),
});
const check = z.object({
  state: z.string().max(30),
  text: text.optional(),
  message: text.optional(),
  errors: z.array(text).max(100).optional(),
  firstTextMs: number.optional(),
  localInference: z
    .array(
      z.object({
        turnId: z.string().max(100),
        source: z.enum(['mic', 'system']),
        empty: z.boolean(),
        final: z.boolean(),
        audioMs: number,
        processingMs: number,
        requestMs: number,
        queueMs: number,
        speechToTextMs: number,
        firstTextMs: number,
      }),
    )
    .max(100)
    .optional(),
  durationMs: number.optional(),
  matches: z.boolean().optional(),
  peak: number.optional(),
  entries: z.array(entry).max(500).optional(),
  peaks: z.object({ mic: number, system: number }).optional(),
  echoCount: number.optional(),
  speakerCount: number.optional(),
  attributionEvents: number.optional(),
  attributionMessage: text.optional(),
  attributionDelayMs: number.optional(),
  judgments: z
    .object({
      transcript: z.boolean().optional(),
      echo: z.boolean().optional(),
      speakers: z.boolean().optional(),
    })
    .optional(),
  received: number.optional(),
  outsideApp: z.boolean().optional(),
  connected: z.boolean().optional(),
  model: z.string().max(100).optional(),
  models: z.array(z.string().max(100)).max(100).optional(),
  requestCount: number.optional(),
  settingsMatch: z.boolean().optional(),
  chatgptPersisted: z.boolean().nullable().optional(),
  secureStoragePersisted: z.boolean().nullable().optional(),
});

function createTestStateStore(file, defaults) {
  const template = z.object(
    Object.fromEntries(
      Object.entries(defaults).map(([key, value]) => [
        key,
        key === 'maxOutputTokens'
          ? number.nullable()
          : typeof value === 'string'
            ? z.string().max(100000)
            : typeof value === 'boolean'
              ? z.boolean()
              : number,
      ]),
    ),
  );
  const schema = z.object({
    schemaVersion: z.literal(2),
    savedAt: z.string().max(40),
    checks: z.object(
      Object.fromEntries(
        ['mic', 'system', 'conversation', 'shortcut', 'chatgpt', 'restart', 'call'].map((key) => [
          key,
          check.optional(),
        ]),
      ),
    ),
    preferences: z.object({ output: z.string().max(30), model: z.string().max(100) }),
    notes: z.string().max(2000),
    restartCheckpoint: z
      .object({
        sessionId: z.string().max(100),
        nonce: z.string().max(100),
        expected: z.object({
          language: z.literal('de'),
          captureMic: z.literal(true),
          captureSystem: z.literal(true),
          answerBilling: z.literal('chatgpt'),
          model: z.string().max(100),
        }),
        chatgptWasConnected: z.boolean(),
        previousTemplate: template.nullable(),
      })
      .optional(),
  });
  function sanitize(value) {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 250000)
      throw Error('The test checkpoint is too large. Download the report before retrying.');
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw Error('The saved test checkpoint is invalid.');
    return parsed.data;
  }
  let writes = Promise.resolve();
  return {
    async load() {
      await writes;
      try {
        return sanitize(JSON.parse(await readFile(file, 'utf8')));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw Error('The previous test could not be restored. Its saved file has been kept.');
      }
    },
    save(value) {
      const contents = JSON.stringify(sanitize(value));
      const write = writes.then(async () => {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
          await rename(temporary, file);
        } finally {
          await rm(temporary, { force: true });
        }
      });
      writes = write.catch(() => undefined);
      return write;
    },
    flush: () => writes,
  };
}
const checks = z.object(
  Object.fromEntries(
    ['mic', 'system', 'conversation', 'shortcut', 'chatgpt', 'restart', 'call'].map((key) => [
      key,
      check.optional(),
    ]),
  ),
);
function sanitizeTestReport(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 250000)
    throw Error('The test report is too large.');
  return z
    .object({
      schemaVersion: z.literal(2),
      test: z.literal('windows-comprehensive-preview'),
      exportedAt: z.string().max(40),
      environment: z.object({
        platform: z.string().optional(),
        arch: z.string().optional(),
        osVersion: z.string().optional(),
        machine: z.string().optional(),
        cpu: z.string().optional(),
        cpuThreads: number.optional(),
        ramGB: number.optional(),
        appVersion: z.string().optional(),
        electronVersion: z.string().optional(),
        preview: z.boolean().optional(),
        buildId: z.string().optional(),
        secureStorage: z.boolean().optional(),
        secureStorageRestart: z.boolean().nullable().optional(),
        shortcuts: z
          .array(z.object({ accelerator: z.string(), registered: z.boolean() }))
          .optional(),
      }),
      setup: z.object({ phase: z.string().max(30), message: text }),
      output: z.string().max(30),
      checks,
      notes: z.string().max(2000),
      scope: text,
      privacy: text,
    })
    .parse(value);
}
module.exports = { createTestStateStore, sanitizeTestReport };
