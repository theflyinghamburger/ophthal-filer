import {
  TranscriptError,
  mapSpanToRaw,
  type AppliedTranscript,
  type RawSpan,
} from './apply.js';
import type { Transcript } from './types.js';

/**
 * Working span → raw span → segment → audio time (ARCHITECTURE.md §4).
 * This is what makes review-UI audio scrubbing survive every transform.
 *
 * Audio times are relative to the **preprocessed** audio; #8 owns the
 * conversion back to the original file.
 */

/** A recovered range of one segment inside `raw`, by segment order. */
export interface SegmentRange {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

/** A working span mapped home: its raw span, its segments, their audio union. */
export interface Located {
  readonly raw: RawSpan;
  /** Indices into transcript.segments, ascending; possibly empty. */
  readonly segments: readonly number[];
  /** Union of the matched segments' audio times; null when segments is empty. */
  readonly audio: { readonly start: number; readonly end: number } | null;
}

const rangesCache = new WeakMap<Transcript, readonly SegmentRange[]>();

/**
 * Recover the raw range of each segment. `TranscriptSegment` carries no
 * offsets, so ranges are re-derived: walk `raw` with sequential
 * `indexOf` from the end of the previous segment. Throws `TranscriptError`
 * when a segment's text is not findable — #9 must emit `raw` as the segment
 * texts joined by a single ' ' so this always succeeds.
 */
export function segmentRanges(transcript: Transcript): readonly SegmentRange[] {
  const hit = rangesCache.get(transcript);
  if (hit !== undefined) return hit;

  const ranges: SegmentRange[] = [];
  let cursor = 0;
  transcript.segments.forEach((segment, index) => {
    const at = transcript.raw.indexOf(segment.text, cursor);
    if (at === -1) throw new TranscriptError(`segments[${index}] text not found in raw`);
    ranges.push({ index, start: at, end: at + segment.text.length });
    cursor = at + segment.text.length;
  });

  rangesCache.set(transcript, ranges);
  return ranges;
}

/**
 * Map a working span back to raw, then to every intersecting segment, then to
 * their union audio window. When the mapped raw span is a point — including a
 * working span that collapsed inside a replacement — it matches the segment
 * containing that point (closed interval: a boundary point belongs to both
 * sides).
 */
export function locate(applied: AppliedTranscript, workingStart: number, workingEnd: number): Located {
  const raw = mapSpanToRaw(applied, workingStart, workingEnd);
  const ranges = segmentRanges(applied.transcript);
  const zeroLength = raw.rawStart === raw.rawEnd;

  const matched: number[] = [];
  for (const range of ranges) {
    const intersects = range.start < raw.rawEnd && raw.rawStart < range.end;
    const containsPoint = zeroLength && range.start <= raw.rawStart && raw.rawStart <= range.end;
    if (intersects || containsPoint) matched.push(range.index);
  }

  let audio: { start: number; end: number } | null = null;
  if (matched.length > 0) {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const index of matched) {
      const segment = applied.transcript.segments[index];
      if (segment === undefined) continue;
      start = Math.min(start, segment.start);
      end = Math.max(end, segment.end);
    }
    audio = { start, end };
  }

  return { raw, segments: matched, audio };
}

/** First index of `needle` in `working`, or -1. No normalization. */
export function findVerbatim(applied: AppliedTranscript, needle: string): number {
  return applied.working.indexOf(needle);
}
