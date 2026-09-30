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
  private unassignedStarts: Array<{ timestamp: number; endTimestamp?: number; id?: string }> = [];
  private activeTurn?: { timestamp: number; endTimestamp?: number; id?: string };
  private lastTimestamp = 0;

  constructor(
    private readonly source: Source,
    private readonly speaker: string,
    private readonly emit: (entry: TranscriptEntry) => void,
  ) {}

  beginTurn(timestamp: number): void {
    this.activeTurn = { timestamp };
    this.unassignedStarts.push(this.activeTurn);
  }

  endTurn(timestamp: number): void {
    const turn = this.activeTurn;
    if (!turn) return;
    turn.endTimestamp = Math.max(turn.timestamp, timestamp);
    const entry = turn.id ? this.entries.get(turn.id) : undefined;
    if (entry) {
      entry.endTimestamp = turn.endTimestamp;
      if (entry.text) this.emit({ ...entry });
    }
    this.activeTurn = undefined;
  }

  private entry(id: string): TranscriptEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      const turn = this.unassignedStarts.shift();
      const timestamp = turn?.timestamp ?? Math.max(Date.now(), this.lastTimestamp + 1);
      if (turn) turn.id = id;
      this.lastTimestamp = timestamp;
      entry = {
        id: `${this.source}:${id}`,
        source: this.source,
        speaker: this.speaker,
        text: '',
        timestamp,
        ...(turn?.endTimestamp !== undefined ? { endTimestamp: turn.endTimestamp } : {}),
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
