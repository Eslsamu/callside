import type { AnswerEvent, AnswerRequest } from '../shared/types';

export async function* streamAnswer(
  request: AnswerRequest,
  token: string,
  signal: AbortSignal,
): AsyncGenerator<AnswerEvent> {
  const response = await fetch('/api/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Callside-Token': token },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  if (!response.body) throw new Error('Could not read the answer.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data && data !== '[DONE]') {
          const parsed = JSON.parse(data) as AnswerEvent;
          if (parsed.type === 'done' || parsed.type === 'skip' || parsed.type === 'error')
            terminal = true;
          yield parsed;
        }
      }
      if (done) break;
    }
    if (!terminal && !signal.aborted)
      throw new Error('The answer connection was interrupted. Try again.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
