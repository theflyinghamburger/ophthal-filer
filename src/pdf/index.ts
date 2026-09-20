/**
 * Stage 10 — render (ARCHITECTURE.md §3.4).
 *
 * Scan as a full-page background image, real named AcroForm widgets on top.
 * Field names mirror schema paths exactly, so filling is one flat map lookup.
 * Do not flatten by default; offer flatten-on-sign as an explicit action.
 *
 * Every PDF carries the provenance footer: "AI-assisted draft - reviewed and
 * signed by ____", timestamp, app version, ASR and LLM model versions,
 * transcript hash, and the count of Pass A corrections applied.
 *
 * TODO(#17): `template.ts` (background + fields), `fill.ts` (EncounterDraft ->
 *            filled PDF), `calibrate.ts` (grid overlay tool).
 */
export {};
