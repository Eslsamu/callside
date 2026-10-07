import OpenAI, { toFile } from 'openai';
import { z } from 'zod';
import type {
  AnswerRequest,
  TranscriptEntry,
  Source,
  SpeakerReference,
  TokenUsage,
} from '../shared/types.js';

import { answerInstructions, WAIT_SENTINEL } from '../shared/instructions.js';
export { WAIT_SENTINEL } from '../shared/instructions.js';
export interface AnswerInput {
  model: string;
  reasoningEffort: import('../shared/models.js').ReasoningEffort;
  fastMode: boolean;
  instructions: string;
  referenceMaterial: string;
  modeInstructions: string;
  input: string;
  maxOutputTokens: number | null;
}
export interface DiarizeInput {
  audio: Buffer;
  source: Source;
  chunkId: string;
  timestamp: number;
  language: string;
  knownSpeakers?: SpeakerReference[];
}
export type ProviderAnswerEvent =
  { type: 'delta'; text: string } | { type: 'done'; usage?: TokenUsage };

/** Add future providers here without changing the browser or storing provider credentials there. */
export interface AiProvider {
  answer(input: AnswerInput, signal: AbortSignal): AsyncIterable<ProviderAnswerEvent>;
  diarize(input: DiarizeInput, signal: AbortSignal): Promise<TranscriptEntry[]>;
}

export function buildAnswerInput(request: AnswerRequest): AnswerInput {
  // Keep the freshest context within a predictable bound, even during a long call.
  const transcript: Array<{
    source: Source;
    speaker: string;
    attribution?: string;
    text: string;
    partial: boolean;
  }> = [];
  let remaining = 24000;
  for (const entry of request.transcript.slice(-120).reverse()) {
    if (remaining <= 0) break;
    const text = entry.text.slice(-remaining);
    remaining -= text.length;
    transcript.unshift({
      source: entry.source,
      speaker: entry.speaker,
      ...(entry.attribution ? { attribution: entry.attribution } : {}),
      text,
      partial: !entry.final,
    });
  }
  const { settings } = request;
  return {
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    fastMode: settings.fastMode,
    maxOutputTokens:
      settings.maxOutputTokens === null
        ? null
        : Math.min(32768, Math.max(64, Math.floor(settings.maxOutputTokens))),
    ...answerInstructions(settings, request.mode),
    referenceMaterial: settings.context,
    input: JSON.stringify({
      userCommand: request.question,
      callTranscript: transcript,
      previousSuggestions: request.previousSuggestions.slice(-5).map((text) => text.slice(-3000)),
    }),
  };
}

export class PublicError extends Error {}
export function publicError(error: unknown): string {
  if (error instanceof PublicError) return error.message;
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
  if (status === 401 || status === 403)
    return 'OpenAI rejected the API key. Check the key and project permissions.';
  if (status === 429)
    return 'OpenAI limit reached. Check your balance and limits, or try again later.';
  if (status === 400 || status === 404)
    return 'OpenAI rejected the request. Check model access, language, reasoning strength, and Fast mode availability.';
  if (error instanceof Error && /abort|timeout/i.test(error.name))
    return 'The request was cancelled or timed out.';
  return 'Could not connect to OpenAI. Check your network and model settings.';
}

export class OpenAIProvider implements AiProvider {
  private readonly client: OpenAI;
  constructor(
    apiKey: string,
    private readonly billing: 'api' | 'chatgpt' = 'api',
  ) {
    this.client = new OpenAI({
      apiKey,
      ...(billing === 'chatgpt'
        ? { baseURL: 'https://api.openai.com/v1', organization: null, project: null }
        : {}),
      maxRetries: 0,
      timeout: 60000,
    });
  }

  async *answer(input: AnswerInput, signal: AbortSignal): AsyncIterable<ProviderAnswerEvent> {
    const stream = await this.client.responses.create(
      {
        model: input.model,
        reasoning: { effort: input.reasoningEffort },
        service_tier: input.fastMode ? 'priority' : 'default',
        input: [
          ...(input.instructions
            ? [{ role: 'developer' as const, content: input.instructions }]
            : []),
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({ referenceMaterial: input.referenceMaterial }),
                ...(this.billing === 'api'
                  ? { prompt_cache_breakpoint: { mode: 'explicit' as const } }
                  : {}),
              },
            ],
          },
          ...(input.modeInstructions
            ? [{ role: 'developer' as const, content: input.modeInstructions }]
            : []),
          { role: 'user', content: input.input },
        ],
        ...(this.billing === 'api'
          ? { prompt_cache_options: { mode: 'explicit' as const, ttl: '30m' as const } }
          : {}),
        ...(this.billing === 'chatgpt' || input.maxOutputTokens === null
          ? {}
          : { max_output_tokens: input.maxOutputTokens }),
        stream: true,
        store: false,
      },
      { signal },
    );
    let complete = false;
    let usage: TokenUsage | undefined;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') yield { type: 'delta', text: event.delta };
      else if (event.type === 'response.refusal.delta') yield { type: 'delta', text: event.delta };
      else if (event.type === 'response.completed') {
        complete = true;
        const report = event.response?.usage;
        if (report)
          usage = {
            inputTokens: report.input_tokens,
            outputTokens: report.output_tokens,
            cachedInputTokens: report.input_tokens_details?.cached_tokens ?? 0,
            ...(report.input_tokens_details?.cache_write_tokens !== undefined
              ? { cacheWriteTokens: report.input_tokens_details.cache_write_tokens }
              : {}),
            ...(report.output_tokens_details?.reasoning_tokens !== undefined
              ? { reasoningTokens: report.output_tokens_details.reasoning_tokens }
              : {}),
          };
      } else if (event.type === 'response.incomplete')
        throw new PublicError(
          this.billing === 'chatgpt'
            ? 'ChatGPT returned an incomplete result. Try lower reasoning or a shorter task.'
            : 'The result reached an output limit. Check the output token limit and reasoning strength in Settings.',
        );
      else if (event.type === 'response.failed' || event.type === 'error')
        throw new PublicError(
          this.billing === 'chatgpt'
            ? 'ChatGPT could not finish the suggestion. Check your plan usage and model access. No API fallback was used.'
            : 'OpenAI could not finish the answer. Check model access and API limits.',
        );
    }
    if (!complete) throw new PublicError('The answer stream ended unexpectedly.');
    yield { type: 'done', ...(usage ? { usage } : {}) };
  }

  async diarize(input: DiarizeInput, signal: AbortSignal): Promise<TranscriptEntry[]> {
    const result = await this.client.audio.transcriptions.create(
      {
        file: await toFile(input.audio, 'call-chunk.wav', { type: 'audio/wav' }),
        model: 'gpt-4o-transcribe-diarize',
        response_format: 'diarized_json',
        chunking_strategy: 'auto',
        ...(input.language ? { language: input.language } : {}),
        ...(input.knownSpeakers?.length
          ? {
              known_speaker_names: input.knownSpeakers.map((speaker) => speaker.name),
              known_speaker_references: input.knownSpeakers.map(
                (speaker) => `data:audio/wav;base64,${speaker.audio}`,
              ),
            }
          : {}),
      },
      { signal },
    );
    const parsed = z
      .object({
        segments: z
          .array(
            z
              .object({
                speaker: z.string().max(100),
                start: z.number().finite().nonnegative(),
                end: z.number().finite().nonnegative().optional(),
                text: z.string().max(12000),
              })
              .refine((segment) => segment.end === undefined || segment.end >= segment.start),
          )
          .max(2000),
      })
      .safeParse(result);
    if (!parsed.success) throw new PublicError('OpenAI returned invalid speaker segments.');
    return parsed.data.segments
      .filter((segment) => segment.text.trim())
      .map((segment, index) => ({
        id: `${input.source}:${input.chunkId}:${index}`,
        source: input.source,
        speaker: `${input.source}:${input.chunkId}:${segment.speaker}`,
        text: segment.text.trim(),
        timestamp: input.timestamp + Math.max(0, segment.start * 1000),
        ...(segment.end !== undefined
          ? { endTimestamp: input.timestamp + segment.end * 1000 }
          : {}),
        final: true,
      }));
  }
}

/** Holds only a possible sentinel prefix; ordinary suggestions still stream immediately. */
export class AutoGate {
  private buffer = '';
  private open = false;
  push(text: string): string {
    if (this.open) return text;
    this.buffer += text;
    const trimmed = this.buffer.trim();
    if (WAIT_SENTINEL.startsWith(trimmed)) return '';
    this.open = true;
    const output = this.buffer;
    this.buffer = '';
    return output;
  }
  finish(): { skip: boolean; text: string } {
    if (this.open) return { skip: false, text: '' };
    return {
      skip: this.buffer.trim() === WAIT_SENTINEL,
      text: this.buffer.trim() === WAIT_SENTINEL ? '' : this.buffer,
    };
  }
}

export async function* demoAnswer(
  request: AnswerRequest,
  signal: AbortSignal,
): AsyncIterable<ProviderAnswerEvent> {
  const last = request.transcript.at(-1);
  const text =
    request.mode === 'auto' && (!last || last.source === 'mic' || !/[?？]/.test(last.text))
      ? WAIT_SENTINEL
      : 'Demo suggestion: Let us start with a focused pilot. We can agree on a measurable goal and a timeline. Which outcome matters most to your team?';
  for (const word of text.match(/\S+\s*/g) ?? []) {
    if (signal.aborted) return;
    yield { type: 'delta', text: word };
    await new Promise<void>((resolve) => setTimeout(resolve, 18));
  }
  yield { type: 'done' };
}
