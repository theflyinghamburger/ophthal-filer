/**
 * Eval harness (ARCHITECTURE.md §9 Step 3).
 *
 * Deliberately built *before* the work it measures: you cannot iterate on
 * prompts without a scoring harness.
 *
 * The three zero-targets are clinical-safety gates, not aspirations:
 * harmful corrections, negation flips, and laterality (OD/OS) errors must all
 * be exactly 0.
 *
 * TODO(#5): synthetic sample corpus + gold labels.
 * TODO(#6): scoring - clinical-term WER, retrieval recall @ K, repair
 *           precision/recall, field-level F1, hallucinated-field rate,
 *           evidence-span verbatim validity, end-to-end latency.
 */
export {};
