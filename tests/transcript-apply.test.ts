import { describe, expect, it } from 'vitest';

import {
  TranscriptError,
  applyEdits,
  mapSpanToRaw,
  type AppliedTranscript,
} from '../src/transcript/apply.js';
import type { Edit, EditSource, Transcript } from '../src/transcript/types.js';

function makeEdit(
  raw: string,
  id: string,
  rawStart: number,
  rawEnd: number,
  replacement: string,
  overrides: Partial<Edit> = {},
): Edit {
  return {
    id,
    source: 'lexicon',
    rawStart,
    rawEnd,
    original: raw.slice(rawStart, rawEnd),
    replacement,
    reason: 'unit-test',
    accepted: true,
    ...overrides,
  };
}

/** Fresh objects, so memoization keyed on identity can't mask a bug. */
function make(raw: string, edits: readonly Edit[]): Transcript {
  return { raw, segments: [], edits: edits.map((edit) => ({ ...edit })) };
}

function mapEvery(applied: AppliedTranscript): number[] {
  const out: number[] = [];
  for (let i = 0; i <= applied.working.length; i++) out.push(applied.mapToRaw(i));
  return out;
}

const RAW = 'A'.repeat(20);

describe('applyEdits', () => {
  it('1. empty edit list: working === raw and identity offset map', () => {
    const applied = applyEdits(make(RAW, []));

    expect(applied.working).toBe(RAW);
    expect(applied.applied).toEqual([]);
    expect(applied.rejected).toEqual([]);
    expect(mapEvery(applied)).toEqual(Array.from({ length: RAW.length + 1 }, (_, i) => i));
  });

  it('2. single replacement shorter than the original', () => {
    const applied = applyEdits(make('abcdefgh', [makeEdit('abcdefgh', 'e1', 2, 6, 'x')]));

    expect(applied.working).toBe('abxgh');
    expect(mapEvery(applied)).toEqual([0, 1, 2, 6, 7, 8]);
  });

  it('3. single replacement longer than the original', () => {
    const applied = applyEdits(make('abcde', [makeEdit('abcde', 'e1', 1, 2, 'xyz')]));

    expect(applied.working).toBe('axyzcde');
    expect(mapEvery(applied)).toEqual([0, 1, 1, 1, 2, 3, 4, 5]);
  });

  it('4. two adjacent edits (a.rawEnd === b.rawStart): both applied', () => {
    const applied = applyEdits(
      make('abcdefgh', [makeEdit('abcdefgh', 'e1', 0, 4, 'w'), makeEdit('abcdefgh', 'e2', 4, 8, 'z')]),
    );

    expect(applied.working).toBe('wz');
    expect(applied.applied.map((edit) => edit.id)).toEqual(['e1', 'e2']);
    expect(applied.rejected).toEqual([]);
    expect(mapEvery(applied)).toEqual([0, 4, 8]);
  });

  it('5. edit at offset 0', () => {
    const applied = applyEdits(make('abcde', [makeEdit('abcde', 'e1', 0, 1, 'z')]));

    expect(applied.working).toBe('zbcde');
    expect(mapEvery(applied)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('6. edit ending at raw.length', () => {
    const applied = applyEdits(make('abcde', [makeEdit('abcde', 'e1', 4, 5, 'z')]));

    expect(applied.working).toBe('abcdz');
    expect(mapEvery(applied)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('7. insertion (rawStart === rawEnd, non-empty replacement)', () => {
    const applied = applyEdits(make('abce', [makeEdit('abce', 'e1', 2, 2, 'X')]));

    expect(applied.working).toBe('abXce');
    expect(mapEvery(applied)).toEqual([0, 1, 2, 2, 3, 4]);
    expect(applied.applied.map((edit) => edit.id)).toEqual(['e1']);
  });

  it('8. deletion (empty replacement): no working text, offset map jumps', () => {
    const applied = applyEdits(make('abcdef', [makeEdit('abcdef', 'e1', 2, 4, '')]));

    expect(applied.working).toBe('abef');
    // The deletion stays in `applied` — it contributed a raw jump only.
    expect(applied.applied.map((edit) => edit.id)).toEqual(['e1']);
    expect(mapEvery(applied)).toEqual([0, 1, 4, 5, 6]);
  });

  it('9. accepted: false is excluded from working, applied and rejected', () => {
    const declined = makeEdit('abcde', 'e1', 1, 2, 'Z', { accepted: false });
    const applied = applyEdits(make('abcde', [declined]));

    expect(applied.working).toBe('abcde');
    expect(applied.applied).toEqual([]);
    expect(applied.rejected).toEqual([]);
  });

  it('10. overlap: the lower rawStart / higher precedence edit wins', () => {
    // Different rawStart: the earlier one is kept regardless of precedence.
    const earlier = makeEdit('abcdefghij', 'a-early', 4, 9, 'x');
    const later = makeEdit('abcdefghij', 'b-later', 6, 10, 'y', { source: 'human' });
    const byRawStart = applyEdits(make('abcdefghij', [later, earlier]));
    expect(byRawStart.applied.map((edit) => edit.id)).toEqual(['a-early']);
    expect(byRawStart.rejected).toEqual([
      { id: 'b-later', reason: 'overlap', conflictsWith: 'a-early' },
    ]);

    // Same rawStart: higher precedence wins.
    const lex = makeEdit('abcdefgh', 'e-lex', 4, 8, 'x');
    const rep = makeEdit('abcdefgh', 'e-rep', 4, 7, 'y', { source: 'repair' });
    const byPrecedence = applyEdits(make('abcdefgh', [lex, rep]));
    expect(byPrecedence.applied.map((edit) => edit.id)).toEqual(['e-rep']);
    expect(byPrecedence.rejected).toEqual([
      { id: 'e-lex', reason: 'overlap', conflictsWith: 'e-rep' },
    ]);
  });

  it('11. two insertions at the same offset: the second is rejected', () => {
    const first = makeEdit('abcde', 'i1', 2, 2, 'X', { source: 'human' });
    const second = makeEdit('abcde', 'i2', 2, 2, 'Y', { source: 'lexicon' });
    const applied = applyEdits(make('abcde', [first, second]));

    expect(applied.applied.map((edit) => edit.id)).toEqual(['i1']);
    expect(applied.rejected).toEqual([
      { id: 'i2', reason: 'overlap', conflictsWith: 'i1' },
    ]);
    expect(applied.working).toBe('abXcde');
  });

  it('12. original !== raw.slice(rawStart, rawEnd) throws TranscriptError', () => {
    const wrong = makeEdit('abcde', 'e1', 1, 2, 'z', { original: 'x' });
    const caseFolded = makeEdit('Abcde', 'e1', 1, 2, 'z', { original: 'B' });
    const trimmed = makeEdit('abcde', 'e1', 1, 2, 'z', { original: ' b' });

    expect(() => applyEdits(make('abcde', [wrong]))).toThrow(TranscriptError);
    expect(() => applyEdits(make('Abcde', [caseFolded]))).toThrow(TranscriptError);
    expect(() => applyEdits(make('abcde', [trimmed]))).toThrow(TranscriptError);
  });

  it('13. out-of-range, inverted, fractional, duplicate and empty ids each throw', () => {
    expect(() => applyEdits(make('abc', [makeEdit('abc', 'e1', 1, 9, 'x')]))).toThrow(TranscriptError);
    expect(() => applyEdits(make('abc', [makeEdit('abc', 'e1', 4, 2, 'x')]))).toThrow(TranscriptError);
    expect(() => applyEdits(make('abc', [makeEdit('abcde', 'e1', 0.5, 1, 'x')]))).toThrow(TranscriptError);
    expect(() =>
      applyEdits(make('abc', [makeEdit('abc', 'e1', 0, 1, 'x'), makeEdit('abc', 'e1', 1, 2, 'x')])),
    ).toThrow(TranscriptError);
    expect(() => applyEdits(make('abc', [makeEdit('abc', '', 0, 1, 'x')]))).toThrow(TranscriptError);
  });

  it('14. offset map is correct at every index of a mixed 4-edit transcript', () => {
    const edits = [
      makeEdit(RAW, 'ins-0', 0, 0, 'xy'), // insertion at 0
      makeEdit(RAW, 'shrink', 2, 6, 'B'), // shorter replacement
      makeEdit(RAW, 'del-mid', 10, 14, ''), // pure deletion
      makeEdit(RAW, 'grow-tail', 16, 20, 'CCCCC'), // longer replacement
    ];
    const applied = applyEdits(make(RAW, edits));

    // 'xy' + raw[0,2] + 'B' + raw[6,10] + raw[14,16] + 'CCCCC'
    expect(applied.working).toBe('xy' + 'AA' + 'B' + 'AAAA' + 'AA' + 'CCCCC');
    expect(applied.applied.map((edit) => edit.id)).toEqual(['ins-0', 'shrink', 'del-mid', 'grow-tail']);
    expect(mapEvery(applied)).toEqual([0, 0, 0, 1, 2, 6, 7, 8, 9, 14, 15, 16, 16, 16, 16, 16, 20]);
  });

  it('15. mapToRaw throws RangeError outside [0, working.length]', () => {
    const applied = applyEdits(make('abcde', [makeEdit('abcde', 'e1', 1, 2, 'z')]));

    expect(() => applied.mapToRaw(-1)).toThrow(RangeError);
    expect(() => applied.mapToRaw(applied.working.length + 1)).toThrow(RangeError);
    expect(() => applied.mapToRaw(2.5)).toThrow(RangeError);
  });

  it('16. toggling accepted re-applies exactly, for all 2^4 subsets', () => {
    const fixture = [
      makeEdit(RAW, 'a', 0, 0, 'p'),
      makeEdit(RAW, 'b', 3, 7, 'q'),
      makeEdit(RAW, 'c', 9, 11, ''),
      makeEdit(RAW, 'd', 15, 19, 'rs'),
    ];

    for (let mask = 0; mask < 16; mask += 1) {
      const active = fixture.filter((_, i) => (mask & (1 << i)) !== 0);
      const fromScratch = applyEdits(make(RAW, active));
      const toggled = applyEdits(
        make(RAW, fixture.map((edit, i) => ({ ...edit, accepted: (mask & (1 << i)) !== 0 }))),
      );

      expect(toggled.working, `mask ${mask}`).toBe(fromScratch.working);
      expect(mapEvery(toggled), `mask ${mask}`).toEqual(mapEvery(fromScratch));
      expect(toggled.applied.map((edit) => edit.id), `mask ${mask}`).toEqual(
        fromScratch.applied.map((edit) => edit.id),
      );
      expect(toggled.rejected.map((edit) => edit.id), `mask ${mask}`).toEqual(
        fromScratch.rejected.map((edit) => edit.id),
      );
    }
  });
});

describe('mapSpanToRaw', () => {
  it('collapses a working span inside a replacement to its raw start', () => {
    const applied = applyEdits(make('abcdef', [makeEdit('abcdef', 'e1', 2, 5, 'xy')]));

    expect(mapSpanToRaw(applied, 2, 3)).toEqual({ rawStart: 2, rawEnd: 2 });

    const plain = applyEdits(make('abcdef', []));
    expect(mapSpanToRaw(plain, 1, 4)).toEqual({ rawStart: 1, rawEnd: 4 });
  });
});

describe('property: random accepted-edit sets', () => {
  // Seeded mulberry32 so a failure reproduces; no fast-check needed.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const sources: readonly EditSource[] = ['repair', 'lexicon', 'laterality', 'human'];
  const replacements = ['', 'c', 'cd', 'w'];

  it('mapToRaw is monotonic, in range, anchored at both ends, with no drift', () => {
    const rand = mulberry32(0x0426);

    for (let i = 0; i < 200; i += 1) {
      const rawLength = Math.floor(rand() * 41);
      let raw = '';
      for (let j = 0; j < rawLength; j += 1) raw += rand() < 0.5 ? 'a' : 'b';

      // Random non-overlapping accepted edit set, in ascending rawStart order.
      const edits: Edit[] = [];
      let cursor = 0;
      const count = Math.floor(rand() * 6);
      for (let k = 0; k < count; k += 1) {
        const start = cursor;
        const end = Math.min(rawLength, start + Math.floor(rand() * 5));
        // A deletion that eats the raw prefix would make mapToRaw(0) !== 0.
        const replacement =
          replacements[Math.floor(rand() * replacements.length)] ?? '';
        edits.push(
          makeEdit(
            raw,
            `e${i}-${k}`,
            start,
            end,
            start === 0 && end > start && replacement === '' ? 'c' : replacement,
            { source: sources[Math.floor(rand() * sources.length)] ?? 'lexicon' },
          ),
        );
        cursor = end;
      }

      const transcript = make(raw, edits);
      const applied = applyEdits(transcript);
      expect(applyEdits(make(raw, transcript.edits)).working).toBe(applied.working);

      const values = mapEvery(applied);
      expect(values[0]).toBe(0);
      expect(values[values.length - 1]).toBe(raw.length);
      for (let w = 1; w < values.length; w += 1) {
        const value = values[w];
        const prev = values[w - 1];
        if (value === undefined || prev === undefined) throw new Error('offset map has a gap');
        if (value < 0 || value > rawLength) throw new Error('offset out of raw range');
        expect(value, `transcript ${i} offset ${w}`).toBeGreaterThanOrEqual(prev);
      }
    }
  });
});
