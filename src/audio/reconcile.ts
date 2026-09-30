import type { TranscriptEntry } from '../../shared/types';

const normalize = (text: string) =>
  text
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function echoMatch(a: TranscriptEntry, b: TranscriptEntry): boolean {
  if (Math.abs(a.timestamp - b.timestamp) > 750) return false;
  const left = normalize(a.text),
    right = normalize(b.text);
  if (
    Math.min(left.length, right.length) < 12 ||
    Math.min(left.split(' ').length, right.split(' ').length) < 3
  )
    return false;
  if (left === right) return true;
  // Numbers and negations must agree. Near-identical timing/text is an echo
  // heuristic, not voice identification; never collapse distinct short answers.
  const important = (text: string) =>
    text
      .match(/\b(?:\d+|not|no|never|cannot|cant|dont|doesnt|wont|nicht|kein\p{L}*|nie)\b/gu)
      ?.join(' ') ?? '';
  if (important(left) !== important(right)) return false;
  const limit = Math.floor(Math.max(left.length, right.length) * 0.1);
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++)
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(left[i - 1] !== right[j - 1]),
      );
    if (Math.min(...current) > limit) return false;
    previous = current;
  }
  return previous[right.length] <= limit;
}

/** Retains raw revisions so disabling the filter can restore every original turn. */
export class TranscriptReconciler {
  private raw = new Map<string, TranscriptEntry>();
  clear() {
    this.raw.clear();
  }
  accept(entry: TranscriptEntry) {
    if (!this.raw.get(entry.id)?.final) this.raw.set(entry.id, { ...entry });
  }
  view(filterEcho = true): { entries: TranscriptEntry[]; echoCount: number } {
    const all = [...this.raw.values()]
      .filter((entry) => entry.text.trim())
      .sort((a, b) => a.timestamp - b.timestamp);
    const system = new Map<number, TranscriptEntry[]>();
    if (filterEcho)
      for (const entry of all) {
        if (entry.source !== 'system' || !entry.final) continue;
        const bucket = Math.floor(entry.timestamp / 750);
        const items = system.get(bucket) ?? [];
        items.push(entry);
        system.set(bucket, items);
      }
    let echoCount = 0;
    const entries = all.filter((entry) => {
      const bucket = Math.floor(entry.timestamp / 750);
      if (
        filterEcho &&
        entry.source === 'mic' &&
        [bucket - 1, bucket, bucket + 1].some((key) =>
          system.get(key)?.some((other) => echoMatch(entry, other)),
        )
      ) {
        echoCount++;
        return false;
      }
      return true;
    });
    return { entries, echoCount };
  }
}
