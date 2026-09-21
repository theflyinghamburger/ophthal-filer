import { getConfig } from '../util/config.js';
import { createLogger, type Logger } from '../util/log.js';
import {
  EDIT_PRECEDENCE,
  type Edit,
  type Transcript,
  type WorkingTranscript,
} from './types.js';

/**
 * The verbatim-anchored edit applier (ARCHITECTURE.md §4).
 *
 * Everything downstream — extract, evidence spans, audio scrubbing, the
 * review UI — depends on `working` and `mapToRaw` agreeing, so both are
 * derived from one private piece list that no caller can see.
 */

export class TranscriptError extends Error {
  override readonly name = 'TranscriptError';
}

/** An accepted edit that was dropped because it collided with a kept edit. */
export interface RejectedEdit {
  readonly id: string;
  readonly reason: 'overlap';
  /** id of the already-kept edit it collided with. */
  readonly conflictsWith: string;
}

/** A span of offsets into the raw transcript. */
export interface RawSpan {
  readonly rawStart: number;
  readonly rawEnd: number;
}

/** The result of applying a transcript's accepted edits. */
export interface AppliedTranscript extends WorkingTranscript {
  /** Accepted, non-conflicting, sorted by rawStart. */
  readonly applied: readonly Edit[];
  /** Accepted but dropped for overlap, sorted by rawStart. */
  readonly rejected: readonly RejectedEdit[];
}

/** One contiguous run of `working` mapped onto a run of `raw`. */
interface Piece {
  readonly kind: 'raw' | 'edit';
  readonly text: string;
  readonly workingStart: number;
  readonly workingEnd: number;
  readonly rawStart: number;
  readonly rawEnd: number;
}

function validateEdit(transcript: Transcript, index: number, edit: Edit): void {
  const where = `edits[${index}]`;
  if (!Number.isInteger(edit.rawStart) || !Number.isInteger(edit.rawEnd)) {
    throw new TranscriptError(`${where}.rawStart/rawEnd must be integers`);
  }
  if (edit.rawStart < 0 || edit.rawEnd < edit.rawStart || edit.rawEnd > transcript.raw.length) {
    throw new TranscriptError(`${where} offsets are out of range`);
  }
  // Guard 1 of §5.4: verbatim. No trimming, no case folding, no normalization.
  if (transcript.raw.slice(edit.rawStart, edit.rawEnd) !== edit.original) {
    throw new TranscriptError(`${where}.original does not match raw verbatim`);
  }
  if (edit.id === '') {
    throw new TranscriptError(`${where}.id must be non-empty`);
  }
}

/** Sort order: rawStart asc, precedence desc, rawEnd desc (longer first), id asc. */
function compareEdits(a: Edit, b: Edit): number {
  if (a.rawStart !== b.rawStart) return a.rawStart - b.rawStart;
  const precedence = EDIT_PRECEDENCE[b.source] - EDIT_PRECEDENCE[a.source];
  if (precedence !== 0) return precedence;
  if (a.rawEnd !== b.rawEnd) return b.rawEnd - a.rawEnd;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Conflict test for two accepted edits. Called only with
 * `kept.rawStart <= candidate.rawStart` and exactly one kept edit — the last
 * one — because kept spans are ordered, so an earlier kept edit cannot
 * collide with a later candidate.
 */
function conflicts(kept: Edit, candidate: Edit): boolean {
  const keptZero = kept.rawStart === kept.rawEnd;
  const candidateZero = candidate.rawStart === candidate.rawEnd;
  if (keptZero && candidateZero) return kept.rawStart === candidate.rawStart;
  if (candidateZero) return kept.rawStart < candidate.rawStart && candidate.rawStart < kept.rawEnd;
  if (keptZero) return candidate.rawStart < kept.rawStart && kept.rawStart < candidate.rawEnd;
  // Abutting spans (kept.rawEnd === candidate.rawStart) are not a conflict.
  return kept.rawStart < candidate.rawEnd && candidate.rawStart < kept.rawEnd;
}

/** The single source of truth for both `working` and `mapToRaw`. */
function materialize(raw: string, applied: readonly Edit[]): readonly Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  let workingCursor = 0;

  const emitRaw = (rawStart: number, rawEnd: number): void => {
    if (rawStart < rawEnd) {
      pieces.push({
        kind: 'raw',
        text: raw.slice(rawStart, rawEnd),
        workingStart: workingCursor,
        workingEnd: workingCursor + (rawEnd - rawStart),
        rawStart,
        rawEnd,
      });
      workingCursor += rawEnd - rawStart;
    }
  };

  for (const edit of applied) {
    emitRaw(cursor, edit.rawStart);
    if (edit.replacement !== '') {
      pieces.push({
        kind: 'edit',
        text: edit.replacement,
        workingStart: workingCursor,
        workingEnd: workingCursor + edit.replacement.length,
        rawStart: edit.rawStart,
        rawEnd: edit.rawEnd,
      });
      workingCursor += edit.replacement.length;
    }
    // A pure deletion contributes no working text — only the raw jump.
    cursor = edit.rawEnd;
  }
  emitRaw(cursor, raw.length);

  return pieces;
}

function workingOfPieces(pieces: readonly Piece[]): string {
  let text = '';
  for (const piece of pieces) text += piece.text;
  return text;
}

/**
 * Binary search over piece workingStarts. Pieces tile [0, workingLength)
 * with no gaps, so `w < workingLength` always lands in exactly one piece.
 */
function mapToRawOf(pieces: readonly Piece[], workingLength: number, rawLength: number):
  (workingOffset: number) => number {
  return (workingOffset: number): number => {
    if (!Number.isInteger(workingOffset) || workingOffset < 0 || workingOffset > workingLength) {
      throw new RangeError('workingOffset is out of range');
    }
    if (workingOffset === workingLength) return rawLength;

    let lo = 0;
    let hi = pieces.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const piece = pieces[mid]; // mid < hi <= pieces.length, so defined
      if (piece === undefined) throw new RangeError('workingOffset is out of range');
      if (piece.workingStart > workingOffset) hi = mid;
      else lo = mid + 1;
    }
    const piece = pieces[lo - 1];
    if (piece === undefined) throw new RangeError('workingOffset is out of range');
    // Every offset inside a replacement collapses to the start of the span.
    return piece.kind === 'raw' ? piece.rawStart + (workingOffset - piece.workingStart) : piece.rawStart;
  };
}

let sharedLogger: Logger | undefined;

function logger(): Logger {
  return (sharedLogger ??= createLogger({ level: getConfig().logLevel }));
}

/**
 * Validate every edit, select the accepted non-overlapping ones, and
 * materialize `working` plus the offset map. Pure apart from logging:
 * the input is never mutated — rejection is a property of this application,
 * not of the edits.
 */
export function applyEdits(transcript: Transcript): AppliedTranscript {
  const seen = new Set<string>();
  transcript.edits.forEach((edit, index) => {
    validateEdit(transcript, index, edit);
    if (seen.has(edit.id)) throw new TranscriptError(`duplicate edit id at edits[${index}]`);
    seen.add(edit.id);
  });

  const sorted = transcript.edits.filter((edit) => edit.accepted).sort(compareEdits);

  const applied: Edit[] = [];
  const rejected: RejectedEdit[] = [];
  let lastKept: Edit | undefined;
  for (const candidate of sorted) {
    if (lastKept !== undefined && conflicts(lastKept, candidate)) {
      rejected.push({ id: candidate.id, reason: 'overlap', conflictsWith: lastKept.id });
      logger().warn('transcript.apply.overlap', { editSource: candidate.source });
      continue;
    }
    applied.push(candidate);
    lastKept = candidate;
  }

  const pieces = materialize(transcript.raw, applied);
  const working = workingOfPieces(pieces);

  const log = logger();
  log.debug('transcript.apply', { editCount: applied.length, droppedEditCount: rejected.length });

  return {
    transcript,
    working,
    mapToRaw: mapToRawOf(pieces, working.length, transcript.raw.length),
    applied,
    rejected,
  };
}

/** Map a working span back to the raw span it occupied (zero-length possible). */
export function mapSpanToRaw(applied: AppliedTranscript, start: number, end: number): RawSpan {
  const rawStart = applied.mapToRaw(start);
  const rawEnd = Math.max(applied.mapToRaw(end), rawStart);
  return { rawStart, rawEnd };
}

const appliedCache = new WeakMap<Transcript, AppliedTranscript>();

/**
 * `working` derived from `raw` + accepted edits, memoized per transcript object.
 * Treat `Transcript` as immutable: a stage that adds edits returns a new
 * object, `{ ...t, edits: [...t.edits, ...newEdits] }` — mutating `edits` in
 * place would return the stale cached value.
 */
export function workingOf(transcript: Transcript): AppliedTranscript {
  const hit = appliedCache.get(transcript);
  if (hit !== undefined) return hit;
  const applied = applyEdits(transcript);
  appliedCache.set(transcript, applied);
  return applied;
}
