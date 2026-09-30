import type { SpeakerAttribution, SpeakerSegment, TranscriptEntry } from '../../shared/types.js';

const words = (text: string) =>
  [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map((match) => ({
    value: match[0].toLocaleLowerCase().normalize('NFKC').replace(/['’]/g, ''),
    start: match.index!,
  }));

/** Ordered matching tolerates ASR wording differences without replacing live text. */
function align(left: string[], right: string[]): number[] {
  if (left.length > 512 || right.length > 512) return [];
  const rows = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = 1; i <= left.length; i++)
    for (let j = 1; j <= right.length; j++)
      rows[i][j] =
        left[i - 1] === right[j - 1]
          ? rows[i - 1][j - 1] + 1
          : Math.max(rows[i - 1][j], rows[i][j - 1]);
  const matches: number[] = [];
  let i = left.length,
    j = right.length;
  while (i && j) {
    if (left[i - 1] === right[j - 1]) {
      matches.push(--i);
      j--;
    } else if (rows[i - 1][j] >= rows[i][j - 1]) i--;
    else j--;
  }
  return matches.reverse();
}

/** Overlay labels on original live turns, regardless of which API finishes first. */
export class SpeakerAttributionOverlay {
  private batches = new Map<string, SpeakerAttribution>();
  private cached = new Map<string, { original: TranscriptEntry; entries: TranscriptEntry[] }>();
  clear() {
    this.batches.clear();
    this.cached.clear();
  }
  accept(result: SpeakerAttribution) {
    this.batches.set(result.chunkId, result);
    for (const [id, cached] of this.cached) {
      if (
        cached.original.timestamp < result.endTimestamp &&
        (cached.original.endTimestamp ?? cached.original.timestamp) > result.timestamp
      )
        this.cached.delete(id);
    }
  }

  apply(entry: TranscriptEntry): TranscriptEntry[] {
    const cached = this.cached.get(entry.id);
    if (cached?.original === entry) return cached.entries;
    const entries = this.label(entry);
    this.cached.set(entry.id, { original: entry, entries });
    return entries;
  }

  private label(entry: TranscriptEntry): TranscriptEntry[] {
    if (entry.source !== 'system' || !entry.text.trim()) return [entry];
    const tokens = words(entry.text);
    if (!tokens.length) return [entry];
    // Only committed turns have a measured end. Partials stay usable immediately.
    if (entry.endTimestamp === undefined) return [entry];
    const end = entry.endTimestamp;
    const assignments: Array<SpeakerSegment | undefined> = new Array(tokens.length);
    const batches = [...this.batches.values()]
      .filter((batch) => batch.timestamp < end && batch.endTimestamp > entry.timestamp)
      .sort((a, b) => a.receivedAt - b.receivedAt);
    for (const batch of batches) {
      for (const segment of batch.segments) {
        if (segment.timestamp >= end || segment.endTimestamp <= entry.timestamp) continue;
        const referenceWords = words(segment.text);
        const matches = align(
          tokens.map((token) => token.value),
          referenceWords.map((token) => token.value),
        );
        const minimum = Math.min(tokens.length, referenceWords.length);
        if (!minimum || matches.length < Math.min(2, minimum) || matches.length / minimum < 0.6)
          continue;
        const wholeTurn =
          matches.length / tokens.length >= 0.8 &&
          batch.timestamp <= entry.timestamp + 250 &&
          batch.endTimestamp >= end - 250;
        const first = wholeTurn ? 0 : matches[0];
        const last = wholeTurn ? tokens.length - 1 : matches.at(-1)!;
        for (let index = first; index <= last; index++) {
          // A weak file-local assignment must not replace a reference-linked label.
          if (
            assignments[index]?.attribution === 'reference' &&
            segment.attribution !== 'reference'
          )
            continue;
          assignments[index] = segment;
        }
      }
    }
    // Fill a small wording gap only if both neighboring matches agree on identity.
    for (let index = 0; index < tokens.length; index++) {
      if (assignments[index]) continue;
      const left = assignments[index - 1];
      const right = assignments.slice(index + 1).find(Boolean);
      if (left && right && left.speakerId === right.speakerId) assignments[index] = left;
    }
    if (!assignments.some(Boolean)) return [entry];
    const groups: Array<{ start: number; end: number; segment?: SpeakerSegment }> = [];
    for (let index = 0; index < tokens.length; index++) {
      const segment = assignments[index];
      const previous = groups.at(-1);
      if (previous && previous.segment?.speakerId === segment?.speakerId) previous.end = index + 1;
      else groups.push({ start: index, end: index + 1, segment });
    }
    let previousTimestamp = entry.timestamp;
    const fragments = groups.map((group, index) => {
      const startOffset = index === 0 ? 0 : tokens[group.start].start;
      const endOffset = group.end === tokens.length ? entry.text.length : tokens[group.end].start;
      const segment = group.segment;
      const timestamp =
        index === 0
          ? entry.timestamp
          : Math.max(
              previousTimestamp,
              Math.min(
                end,
                segment?.timestamp ??
                  entry.timestamp + ((end - entry.timestamp) * group.start) / tokens.length,
              ),
            );
      previousTimestamp = timestamp;
      return {
        ...entry,
        id: groups.length === 1 ? entry.id : `${entry.id}:part:${group.start}`,
        turnId: entry.turnId ?? entry.id,
        text: entry.text.slice(startOffset, endOffset).trim(),
        timestamp,
        ...(segment
          ? {
              speaker: segment.speaker,
              speakerId: segment.speakerId,
              attribution: segment.attribution,
            }
          : {}),
      };
    });
    return fragments.map((fragment, index) => ({
      ...fragment,
      endTimestamp: fragments[index + 1]?.timestamp ?? end,
    }));
  }
}
