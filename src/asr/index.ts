/**
 * Stage 1-2 — audio preprocess and speech recognition (ARCHITECTURE.md §5.1-5.2).
 *
 * ASR stays on **CPU** and never runs concurrently with the LLM: the pipeline
 * is sequential anyway, and on a 6-core laptop overlapping them thrashes (§2).
 *
 * TODO(#8):  ffmpeg preprocess — 16 kHz mono, HPF 80 Hz, EBU R128, VAD trim.
 * TODO(#9):  sherpa-onnx + Parakeet-TDT-0.6B-v2 int8, modified_beam_search,
 *            hotwords from the lexicon, per-token scores, and the §5.2
 *            quality gate that aborts rather than passing garbage downstream.
 */
export {};
