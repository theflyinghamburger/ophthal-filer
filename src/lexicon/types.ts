/**
 * The lexicon: one artifact, four consumers (ARCHITECTURE.md §3.2).
 *
 * ```
 * lexicon/ophthalmology.json
 *    ├─→ build/hotwords.txt         sherpa-onnx contextual biasing
 *    ├─→ build/phonetic-index.json  Double Metaphone keys → term ids
 *    ├─→ Pass A glossary injection  term + gloss for the ~50 retrieved
 *    └─→ validator term whitelist   "is this a real ophthalmic term?"
 * ```
 */

export interface LexiconTerm {
  /** Stable id; referenced by `Edit.reason` and by the phonetic index. */
  id: string;
  /** Canonical spelling. */
  term: string;
  /** Accepted synonyms and abbreviations. */
  aliases: string[];
  /**
   * Observed ASR manglings. Starts empty and fills itself from the learning
   * loop — the compounding asset (§5.9). TODO(#19): `lexicon:suggest`.
   */
  spoken: string[];
  /** One line, injected into the Pass A prompt. Keep it short: tokens cost. */
  gloss: string;
  /**
   * Schema paths this term plausibly belongs to. A retrieval *prior* and a
   * validator eyebrow-raise, never a constraint (§3.2).
   */
  sections: string[];
  /** Contextual-biasing boost for the sherpa-onnx hotword list. */
  boost: number;
}

export interface Lexicon {
  /** Bumped whenever the generated artefacts must be rebuilt. */
  version: number;
  terms: LexiconTerm[];
}
