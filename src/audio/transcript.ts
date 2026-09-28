import type { Source, TranscriptEntry } from '../../shared/types.js';

interface TranscriptEvent {
  type: string;
  item_id?: string;
  previous_item_id?: string | null;
  delta?: string;
  transcript?: string;
}

/** Matches revisions by provider item ID; arrival order never determines transcript order. */
export class TranscriptAssembler {
  private entries = new Map<string, TranscriptEntry>();
  private unassignedStarts: number[] = [];
  private lastTimestamp = 0;

  constructor(
    private readonly source: Source,
    private readonly speaker: string,
    private readonly emit: (entry: TranscriptEntry) => void,
  ) {}

  beginTurn(timestamp: number): void {
    this.unassignedStarts.push(timestamp);
  }

  private entry(id: string): TranscriptEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      const timestamp =
        this.unassignedStarts.shift() ?? Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = timestamp;
      entry = {
        id: `${this.source}:${id}`,
        source: this.source,
        speaker: this.speaker,
        text: '',
        timestamp,
        final: false,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  accept(event: TranscriptEvent): void {
    if (!event.item_id) return;
    if (event.type === 'input_audio_buffer.committed') {
      this.entry(event.item_id);
      return;
    }
    if (
      event.type !== 'conversation.item.input_audio_transcription.delta' &&
      event.type !== 'conversation.item.input_audio_transcription.completed'
    )
      return;
    const entry = this.entry(event.item_id);
    if (entry.final) return;
    if (event.type.endsWith('.completed')) {
      entry.text = event.transcript ?? entry.text;
      entry.final = true;
    } else entry.text += event.delta ?? '';
    this.emit({ ...entry });
  }

  get pending(): number {
    return (
      [...this.entries.values()].filter((entry) => !entry.final).length +
      this.unassignedStarts.length
    );
  }
}
