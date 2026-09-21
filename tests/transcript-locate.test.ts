import { describe, expect, it } from 'vitest';

import { applyEdits, type AppliedTranscript } from '../src/transcript/apply.js';
import { TranscriptError } from '../src/transcript/apply.js';
import { findVerbatim, locate, segmentRanges } from '../src/transcript/locate.js';
import type { Edit, Transcript, TranscriptSegment } from '../src/transcript/types.js';

function segment(start: number, end: number, text: string, score = 0.9): TranscriptSegment {
  return { start, end, text, score };
}

function edit(raw: string, rawStart: number, rawEnd: number, replacement: string): Edit {
  return {
    id: 'e1',
    source: 'repair',
    rawStart,
    rawEnd,
    original: raw.slice(rawStart, rawEnd),
    replacement,
    reason: 'unit-test',
    accepted: true,
  };
}

function make(raw: string, segments: TranscriptSegment[], edits: Edit[] = []): Transcript {
  return { raw, segments, edits: edits.map((item) => ({ ...item })) };
}

function mapEvery(applied: AppliedTranscript): number[] {
  const out: number[] = [];
  for (let i = 0; i <= applied.working.length; i++) out.push(applied.mapToRaw(i));
  return out;
}

describe('segmentRanges', () => {
  it('17. recovers correct ranges for a 3-segment transcript joined with space', () => {
    const transcript = make('hello world foo bar', [
      segment(0, 1, 'hello'),
      segment(1, 2, 'world'),
      segment(2, 3, 'foo bar'),
    ]);

    expect(segmentRanges(transcript)).toEqual([
      { index: 0, start: 0, end: 5 },
      { index: 1, start: 6, end: 11 },
      { index: 2, start: 12, end: 19 },
    ]);
  });

  it('18. throws when a segment text is not findable in raw', () => {
    const transcript = make('cat sat mat', [segment(0, 1, 'cat'), segment(1, 2, 'dog')]);

    expect(() => segmentRanges(transcript)).toThrow(TranscriptError);
  });
});

const CAT_SAT_MAT = make('cat sat mat', [
  segment(0, 1, 'cat'),
  segment(1, 2, 'sat'),
  segment(2, 3, 'mat'),
]);

describe('locate', () => {

  it('19. a working span inside an edited region locates back to its original segment', () => {
    // "mit" was corrected to "mat" — the corrected span still locates to segment 2.
    const transcript = make('cat sat mit', [
      segment(0, 1, 'cat'),
      segment(1, 2, 'sat'),
      segment(2, 3, 'mit'),
    ], [edit('cat sat mit', 8, 11, 'mat')]);
    const applied = applyEdits(transcript);
    expect(applied.working).toBe('cat sat mat');

    const located = locate(applied, 8, 11);
    expect(located.segments).toEqual([2]);
    expect(located.audio).toEqual({ start: 2, end: 3 });
  });

  it('20. a span crossing two segments returns both indices and the union audio window', () => {
    const applied = applyEdits(CAT_SAT_MAT);

    const located = locate(applied, 4, 9);
    expect(located.raw).toEqual({ rawStart: 4, rawEnd: 9 });
    expect(located.segments).toEqual([1, 2]);
    expect(located.audio).toEqual({ start: 1, end: 3 });
  });

  it('21. a zero-length span returns the containing segment', () => {
    const applied = applyEdits(CAT_SAT_MAT);

    expect(locate(applied, 5, 5).segments).toEqual([1]);
    expect(locate(applied, 5, 5).audio).toEqual({ start: 1, end: 2 });
  });

  it('EOF point resolves to the segment ending at the boundary', () => {
    const applied = applyEdits(CAT_SAT_MAT);

    expect(locate(applied, 11, 11).segments).toEqual([2]);
  });

  it('audio is null when no segment matches', () => {
    const applied = applyEdits(make('cat', []));

    expect(locate(applied, 1, 1)).toEqual({
      raw: { rawStart: 1, rawEnd: 1 },
      segments: [],
      audio: null,
    });
  });
});

describe('findVerbatim', () => {
  it('22. returns the index when present, -1 for a near-miss differing only in case', () => {
    const applied = applyEdits(CAT_SAT_MAT);

    expect(findVerbatim(applied, 'sat')).toBe(4);
    expect(findVerbatim(applied, 'Sat')).toBe(-1);
  });

  it('finds text introduced by an accepted replacement, not the original', () => {
    const transcript = make('cat sat mit', [
      segment(0, 1, 'cat'),
      segment(1, 2, 'sat'),
      segment(2, 3, 'mit'),
    ], [edit('cat sat mit', 8, 11, 'mat')]);
    const applied = applyEdits(transcript);

    expect(findVerbatim(applied, 'mat')).toBe(8);
    expect(mapEvery(applied)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 11]);
  });
});
