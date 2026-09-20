/**
 * The transcript model (ARCHITECTURE.md §4).
 *
 * > "The transcript is never a rewritten string. It is raw text plus an
 * > ordered list of anchored edits."
 *
 * This is what preserves the mapping from an extracted field's evidence span
 * back to a character offset in the raw transcript, back to an audio
 * timestamp — through every LLM and deterministic transform. It is also what
 * makes each correction individually reviewable and reversible, and what feeds
 * the learning loop for free.
 */

/** Who proposed an edit. */
export type EditSource = 'repair' | 'lexicon' | 'laterality' | 'human';

/** A verbatim-anchored replacement over the raw transcript. */
export interface Edit {
  id: string;
  source: EditSource;
  /** Offset into the **raw** transcript. */
  rawStart: number;
  rawEnd: number;
  /** MUST equal `raw.slice(rawStart, rawEnd)` verbatim — guard 1 of §5.4. */
  original: string;
  replacement: string;
  /** Glossary term id, rule name, or free text. */
  reason: string;
  /** The doctor can reject any single edit. */
  accepted: boolean;
}

/** One ASR segment, carrying the audio timestamps the review UI scrubs to. */
export interface TranscriptSegment {
  /** Seconds from the start of the (preprocessed) audio. */
  start: number;
  end: number;
  text: string;
  /** Mean per-token score from the recognizer; feeds the quality gate (§5.2). */
  score: number;
}

/**
 * Raw ASR output plus the ordered edit list.
 *
 * `working` and `mapToRaw` are *derived* from `raw` + accepted `edits` and are
 * therefore not stored on this interface — see {@link WorkingTranscript}.
 */
export interface Transcript {
  raw: string;
  segments: TranscriptSegment[];
  edits: Edit[];
}

/**
 * The materialized view: `raw` with accepted edits applied, plus the offset map
 * back to `raw`.
 *
 * TODO(#4): the edit applier (`src/transcript/apply.ts`) — sort by `rawStart`,
 * reject overlaps, materialize `working`, build the offset map. ~60 lines of
 * deterministic TypeScript, and §4 is explicit that it must be unit-tested
 * hard because everything downstream depends on it.
 */
export interface WorkingTranscript {
  readonly transcript: Transcript;
  readonly working: string;
  /** Map an offset in `working` back to an offset in `transcript.raw`. */
  mapToRaw(workingOffset: number): number;
}
