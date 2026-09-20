/**
 * Core extraction vocabulary (ARCHITECTURE.md §6).
 *
 * Only the *load-bearing* shapes live here for now — the ones the rest of the
 * scaffold has to name. The full ~120-field `EncounterDraft` is a domain
 * problem to be worked through with the clinician.
 *
 * TODO(#3): expand into the complete form schema (`src/schema/form-schema.ts`)
 * and the codegen that derives zod schemas, per-section JSON Schema, GBNF
 * grammars, the PDF field manifest and the review-UI field list from it (§6.4).
 */

/**
 * A single extracted field.
 *
 * Every field is nullable and every populated field carries a verbatim span
 * from the working transcript. There is deliberately **no** self-reported
 * confidence — see {@link FieldSignal} and §6.2.
 */
export interface Extracted<T> {
  /** `null` means "not stated". The model never infers (§6.3). */
  value: T | null;
  /** Verbatim substring of the working transcript, or `null`. */
  evidence: string | null;
}

/** Outcome of the clinical validation rules in §6.5. */
export type ValidationOutcome = 'ok' | 'warn' | 'fail';

/**
 * Computed, verifiable signals for one extracted field (§6.2).
 *
 * Contains no PHI by construction — a schema path, booleans, a logprob and an
 * outcome — which is exactly why `src/util/log.ts` accepts it wholesale.
 */
export interface FieldSignal {
  /** Dotted schema path, e.g. `od.posterior.cdRatio.vertical`. */
  path: string;
  /** The model returned a span. */
  hasEvidence: boolean;
  /** That span string-matched against the working transcript. */
  evidenceVerbatim: boolean;
  /** That span mapped back through the edit list to raw text and audio time. */
  evidenceResolved: boolean;
  /**
   * Logprob at the null-vs-value **decision token**, not the mean across the
   * span: under a grammar, probabilities are renormalized over allowed tokens,
   * so a forced field looks spuriously confident (§6.2).
   */
  decisionLogprob: number;
  /** The evidence span overlaps a Pass A repair edit — worth a second look. */
  touchedByRepair: boolean;
  validation: ValidationOutcome;
}

/** Provenance stamped onto every draft and rendered into the PDF footer (§3.4). */
export interface EncounterMeta {
  transcriptHash: string;
  /** ISO 8601. */
  generatedAt: string;
  asrModel: string;
  llmModel: string;
  appVersion: string;
  repairEditCount: number;
  lateralityEditCount: number;
}

/**
 * The structured chart draft: what Pass B produces and the doctor signs.
 *
 * TODO(#3): `od`, `os`, `assessment` and `plan` land here once the field list
 * is agreed. Keeping the type present but minimal means later stages can
 * already import the name without inventing a placeholder of their own.
 */
export interface EncounterDraft {
  meta: EncounterMeta;
}

/** Which of Pass B's six sectioned calls a field belongs to (§5.6). */
export const EXTRACTION_SECTIONS = [
  'od.anterior',
  'os.anterior',
  'od.posterior',
  'os.posterior',
  'assessment',
  'plan',
] as const;

export type ExtractionSection = (typeof EXTRACTION_SECTIONS)[number];
