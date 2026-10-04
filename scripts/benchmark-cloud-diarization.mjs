#!/usr/bin/env node
// Six bounded API calls for the existing three-clip diarization suite.
import 'dotenv/config';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const directory = resolve(process.argv[2] ?? '.local/diarization-suite');
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
if (manifest.length !== 3 || manifest.some((item) => item.duration !== 90 || !/^[A-Za-z0-9-]+$/.test(item.id)))
  throw new Error('Expected the existing three 90-second benchmark clips.');
const providers = [
  { id: 'openai', model: 'gpt-4o-transcribe-diarize', key: process.env.OPENAI_API_KEY,
    url: 'https://api.openai.com/v1/audio/transcriptions' },
  { id: 'elevenlabs', model: 'scribe_v2', key: process.env.ELEVENLABS_API_KEY,
    url: 'https://api.elevenlabs.io/v1/speech-to-text' },
];
for (const provider of providers)
  if (!provider.key?.trim()) throw new Error(`Missing ${provider.id} API key. Set it in the ignored .env file.`);

for (const provider of providers) {
  for (const clip of manifest) {
    const output = join(directory, `${clip.id}.${provider.id}.json`);
    try { await access(output); console.log(`Keeping existing ${clip.id} ${provider.id}`); continue; } catch {}
    const form = new FormData();
    form.set('file', new Blob([await readFile(join(directory, `${clip.id}.wav`))], { type: 'audio/wav' }), `${clip.id}.wav`);
    if (provider.id === 'openai') {
      form.set('model', provider.model);
      form.set('response_format', 'diarized_json');
      form.set('chunking_strategy', 'auto');
      form.set('language', 'en');
    } else {
      form.set('model_id', provider.model);
      form.set('diarize', 'true');
      form.set('language_code', 'eng');
      form.set('tag_audio_events', 'false');
      form.set('timestamps_granularity', 'word');
    }
    console.log(`Running ${provider.id} on ${clip.id}…`);
    const started = performance.now();
    const response = await fetch(provider.url, {
      method: 'POST', body: form, signal: AbortSignal.timeout(180_000),
      headers: provider.id === 'openai'
        ? { Authorization: `Bearer ${provider.key.trim()}` }
        : { 'xi-api-key': provider.key.trim() },
    });
    if (!response.ok) throw new Error(`${provider.id}: HTTP ${response.status}; stopped without retries.`);
    const raw = await response.json();
    const processing_seconds = (performance.now() - started) / 1000;
    const segments = provider.id === 'openai' ? raw.segments?.map(s => ({ start:s.start,end:s.end,speaker:s.speaker,text:s.text }))
      : raw.words?.filter(w => ['word', 'spacing'].includes(w.type) && w.speaker_id != null).map(w => ({start:w.start,end:w.end,speaker:w.speaker_id,text:w.text}));
    if (!Array.isArray(segments) || segments.some(s => !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end < s.start || typeof s.speaker !== 'string'))
      throw new Error(`${provider.id} returned invalid speaker segments.`);
    await writeFile(output, JSON.stringify({ engine:provider.id,model:provider.model,audio_seconds:clip.duration,
      processing_seconds,timing:'HTTP upload through complete response; not live speaker-label latency',
      mode:'whole 90-second clip; no known speaker references or supplied speaker count',
      text:raw.text,segments,raw },null,2)+'\n');
    console.log(`Saved ${clip.id} ${provider.id}: ${processing_seconds.toFixed(2)}s, ${new Set(segments.map(s=>s.speaker)).size} speakers`);
  }
}
