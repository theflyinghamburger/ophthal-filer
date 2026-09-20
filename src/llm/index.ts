/**
 * llama-server lifecycle and the three LLM stages (ARCHITECTURE.md §3.3, §5.4-5.6).
 *
 * One model, loaded once. Pass A, laterality expansion and Pass B all use the
 * same weights with different prompts and grammars — do not try to hold two
 * models on a 6 GB card (§2).
 *
 * TODO(#11): managed `llama-server` child process on 127.0.0.1, random port,
 *            random per-launch `--api-key`, plus a typed OpenAI-compatible
 *            client exposing `cache_prompt` and `n_probs`.
 * TODO(#12): Pass A transcript repair and its five hard guards. Guards 3
 *            (phonetic distance) and 4 (negation preservation) are not
 *            optional — without them the repair pass is a clinical
 *            fabrication engine with a friendly interface.
 * TODO(#13): deterministic normalization, emitted as anchored edits.
 * TODO(#14): laterality expansion ("cornea clear OU" -> explicit OD + OS).
 * TODO(#15): Pass B, six sectioned grammar-constrained calls, transcript-first
 *            prompt ordering so the six share a cached prefix.
 */
export {};
