import { describe, expect, it } from 'vitest';
import { TranscriptReconciler } from '../src/audio/reconcile';
import type { SpeakerAttribution, TranscriptEntry } from '../shared/types';

function entry(
  id: string,
  source: 'mic' | 'system',
  text: string,
  timestamp = 1000,
  final = true,
): TranscriptEntry {
  return { id, source, text, timestamp, final, speaker: source === 'mic' ? 'Me' : 'Other speaker' };
}

describe('local speaker boundary alignment', () => {
  const attribution = (start: number, end: number): SpeakerAttribution => ({
    chunkId: 'local-window',
    timestamp: start,
    endTimestamp: end,
    receivedAt: 6000,
    segments: [
      {
        timestamp: start,
        endTimestamp: end,
        speaker: 'Speaker 1 · local',
        speakerId: 'local-1',
        attribution: 'local',
        text: '',
      },
    ],
  });
  it('labels a dominant voice despite up to 250 ms of VAD/worklet boundary skew', () => {
    const reconciler = new TranscriptReconciler();
    reconciler.accept({
      ...entry('system:1', 'system', 'A complete measured phrase.'),
      endTimestamp: 5000,
    });
    reconciler.attribute(attribution(1250, 4750));
    expect(reconciler.view().entries[0]).toMatchObject({
      speaker: 'Speaker 1 · local',
      speakerId: 'local-1',
      attribution: 'local',
      text: 'A complete measured phrase.',
    });
  });
  it.each([
    [1251, 5000],
    [1000, 4749],
    [1000, 3000],
  ])('keeps uncovered or still-pending speech unassigned (%d–%d)', (from, through) => {
    const reconciler = new TranscriptReconciler();
    reconciler.accept({
      ...entry('system:1', 'system', 'A complete measured phrase.'),
      endTimestamp: 5000,
    });
    reconciler.attribute(attribution(from, through));
    expect(reconciler.view().entries[0]).toMatchObject({ speaker: 'Other speaker' });
    expect(reconciler.view().entries[0].attribution).toBeUndefined();
  });
  it('does not label a provisional phrase without an end timestamp', () => {
    const reconciler = new TranscriptReconciler();
    reconciler.accept(entry('system:1', 'system', 'An unfinished phrase', 1000, false));
    reconciler.attribute(attribution(1000, 5000));
    expect(reconciler.view().entries[0].attribution).toBeUndefined();
  });
});
describe('cross-channel microphone echo', () => {
  it.each([true, false])(
    'keeps the system speaker regardless of arrival order: system first=%s',
    (systemFirst) => {
      const reconciler = new TranscriptReconciler();
      const pair = [
        entry('mic:1', 'mic', 'The delivery takes two weeks.', 1000),
        entry('system:1', 'system', 'The delivery takes two weeks!', 1306),
      ];
      if (systemFirst) pair.reverse();
      for (const item of pair) reconciler.accept(item);
      expect(reconciler.view()).toEqual({
        entries: [pair.find((item) => item.source === 'system')],
        echoCount: 1,
      });
      expect(reconciler.view(false).entries).toHaveLength(2);
    },
  );
  it('allows tiny transcription differences but keeps negations, numbers, short replies and later repetitions', () => {
    const reconciler = new TranscriptReconciler();
    reconciler.accept(entry('system:1', 'system', 'All clear, I will do that.', 1000));
    reconciler.accept(entry('echo', 'mic', 'All clear I will do that', 1056));
    reconciler.accept(entry('different', 'mic', 'All clear I will not do that', 1060));
    reconciler.accept(entry('repeat', 'mic', 'All clear I will do that', 4000));
    reconciler.accept(entry('system:2', 'system', 'The total price is 1200.', 6000));
    reconciler.accept(entry('number', 'mic', 'The total price is 1500.', 6020));
    reconciler.accept(entry('system:3', 'system', 'Yes', 8000));
    reconciler.accept(entry('short', 'mic', 'Yes', 8050));
    expect(reconciler.view().entries.map((item) => item.id)).toEqual([
      'system:1',
      'different',
      'repeat',
      'system:2',
      'number',
      'system:3',
      'short',
    ]);
  });
  it('handles final revisions, filters blank rows, and clears between sessions', () => {
    const reconciler = new TranscriptReconciler();
    reconciler.accept(entry('mic:1', 'mic', 'Please tell me the delivery date.', 1000));
    reconciler.accept(entry('system:1', 'system', 'Please tell me', 1100, false));
    expect(reconciler.view().echoCount).toBe(0);
    reconciler.accept(entry('system:1', 'system', 'Please tell me the delivery date.', 1100));
    reconciler.accept(entry('system:1', 'system', 'late partial', 1100, false));
    reconciler.accept(entry('blank', 'mic', '', 1200));
    expect(reconciler.view().entries).toHaveLength(1);
    reconciler.clear();
    expect(reconciler.view()).toEqual({ entries: [], echoCount: 0 });
  });
  it('matches minor inflection differences without collapsing separate speech', () => {
    const reconciler = new TranscriptReconciler();
    reconciler.accept(entry('system', 'system', 'Alles klar, mache ich nicht.', 1000));
    reconciler.accept(entry('echo', 'mic', 'Alles klar, mach ich nicht.', 1306));
    expect(reconciler.view().echoCount).toBe(1);
  });
});
