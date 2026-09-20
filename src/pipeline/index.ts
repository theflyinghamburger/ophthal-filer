/**
 * Stage orchestration (ARCHITECTURE.md §5).
 *
 * Every stage reads and writes JSON so any stage can be re-run in isolation:
 * iterate on repair prompts without re-running ASR, and inspect every
 * intermediate.
 *
 * preprocess -> transcribe -> retrieve glossary -> Pass A repair ->
 * normalize -> laterality -> Pass B extract -> validate + score ->
 * HUMAN REVIEW (non-optional) -> render
 *
 * TODO(#18): wire the stages into the `run` verb.
 */
export {};
