import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { TranscriptError } from './apply.js';
import type { Edit, EditSource, Transcript, TranscriptSegment } from './types.js';

/**
 * The `*.transcript.json` envelope (§0.6): every stage from #8 to #15 reads
 * and writes it, appending a `StageRecord` each run. This file owns the
 * envelope; each stage owns its own payload shape.
 */

export const TRANSCRIPT_DOCUMENT_KIND = 'ophtha-scribe/transcript';

const GATE_CHECK_IDS = ['words-per-second', 'mean-token-score', 'glossary-hit-rate'] as const;

// ponytail: placeholders until #8/#9/#10/#12 land — the owning modules will
// replace these declarations with imports of their real types. The shapes
// below are exactly what those specs give.

/** #8 — one kept (non-silent) run, in both timebases. */
export interface TrimSegment {
  readonly outStart: number;
  readonly outEnd: number;
  readonly srcStart: number;
  readonly srcEnd: number;
}

/** #8 — ascending, non-overlapping, contiguous in the `out` timebase. */
export interface TrimMap {
  readonly segments: readonly TrimSegment[];
}

/** #8 — where the audio came from. */
export interface AudioProvenance {
  readonly path: string;
  readonly sha256: string;
  readonly sourceDurationSec: number;
  readonly durationSec: number;
  readonly sampleRate: 16000;
  readonly channels: 1;
  readonly denoised: boolean;
  readonly trim: TrimMap;
}

/** #9 — one quality-gate check. */
export type GateCheckId = (typeof GATE_CHECK_IDS)[number];

export interface QualityGateCheck {
  readonly id: GateCheckId;
  readonly value: number;
  readonly threshold: number;
  readonly pass: boolean;
}

/** #9 — the §5.2 quality gate report. */
export interface QualityGateReport {
  readonly pass: boolean;
  readonly checks: readonly QualityGateCheck[];
}

/** #10 — one retrieved lexicon term. */
export interface RetrievedTerm {
  readonly id: string;
  readonly score: number;
  readonly floor: boolean;
}

/** #10 — retrieval result: term ids and scores only, no transcript text. */
export interface RetrievalResult {
  readonly k: number;
  readonly terms: readonly RetrievedTerm[];
  readonly hits: number;
  readonly shortCircuit: boolean;
}

/** #12 — which guard dropped a correction. */
export type GuardId = 'anchor' | 'glossary' | 'phonetic' | 'negation' | 'budget';

/** #12 — a guard rejection, kept for the learning loop and eval harness. */
export interface DroppedEdit {
  readonly guard: GuardId;
  readonly original: string;
  readonly replacement: string;
  readonly termId: string | null;
  readonly distance: number | null;
}

/** One stage's run record. No timestamp, so documents stay diffable. */
export interface StageRecord {
  readonly stage: string;
  readonly durationMs: number;
  readonly ok: boolean;
}

/**
 * The on-disk handoff. `audio`, `asrModel`, `gate` and `retrieval` are null
 * until their owning stage (#8/#9/#9/#10) has run; everything is declared now
 * so the shape never changes mid-pipeline.
 */
export interface TranscriptDocument {
  readonly kind: typeof TRANSCRIPT_DOCUMENT_KIND;
  readonly version: 1;
  readonly audio: AudioProvenance | null;
  /** #9. e.g. 'parakeet-tdt-0.6b-v2-int8'. */
  readonly asrModel: string | null;
  readonly gate: QualityGateReport | null;
  readonly retrieval: RetrievalResult | null;
  readonly droppedEdits: readonly DroppedEdit[];
  readonly transcript: Transcript;
  readonly stages: readonly StageRecord[];
}

const EDIT_SOURCES: readonly EditSource[] = ['repair', 'lexicon', 'laterality', 'human'];
const GUARD_IDS: readonly GuardId[] = ['anchor', 'glossary', 'phonetic', 'negation', 'budget'];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEdit(raw: unknown, index: number): Edit {
  const where = `transcript.edits[${index}]`;
  if (!isPlainObject(raw)) throw new TranscriptError(`${where} is not an object`);

  const id = raw['id'];
  if (typeof id !== 'string' || id === '') {
    throw new TranscriptError(`${where}.id must be a non-empty string`);
  }
  const source = raw['source'];
  if (typeof source !== 'string' || !EDIT_SOURCES.includes(source as EditSource)) {
    throw new TranscriptError(`${where}.source is not a known edit source`);
  }
  const rawStart = raw['rawStart'];
  const rawEnd = raw['rawEnd'];
  if (!isFiniteNumber(rawStart) || !isFiniteNumber(rawEnd)) {
    throw new TranscriptError(`${where}.rawStart and rawEnd must be numbers`);
  }
  const original = raw['original'];
  if (typeof original !== 'string') throw new TranscriptError(`${where}.original must be a string`);
  const replacement = raw['replacement'];
  if (typeof replacement !== 'string') {
    throw new TranscriptError(`${where}.replacement must be a string`);
  }
  const reason = raw['reason'];
  if (typeof reason !== 'string') throw new TranscriptError(`${where}.reason must be a string`);
  const accepted = raw['accepted'];
  if (typeof accepted !== 'boolean') {
    throw new TranscriptError(`${where}.accepted must be a boolean`);
  }

  return {
    id,
    source: source as EditSource,
    rawStart,
    rawEnd,
    original,
    replacement,
    reason,
    accepted,
  };
}

function parseSegment(raw: unknown, index: number): TranscriptSegment {
  const where = `transcript.segments[${index}]`;
  if (!isPlainObject(raw)) throw new TranscriptError(`${where} is not an object`);

  const start = raw['start'];
  const end = raw['end'];
  if (!isFiniteNumber(start) || !isFiniteNumber(end)) {
    throw new TranscriptError(`${where}.start and end must be numbers`);
  }
  const text = raw['text'];
  if (typeof text !== 'string') throw new TranscriptError(`${where}.text must be a string`);
  const score = raw['score'];
  if (!isFiniteNumber(score)) throw new TranscriptError(`${where}.score must be a number`);

  return { start, end, text, score };
}

function parseTranscript(raw: unknown): Transcript {
  if (!isPlainObject(raw)) throw new TranscriptError('transcript is not an object');
  if (typeof raw['raw'] !== 'string') throw new TranscriptError('transcript.raw must be a string');
  if (!Array.isArray(raw['segments'])) throw new TranscriptError('transcript.segments must be an array');
  if (!Array.isArray(raw['edits'])) throw new TranscriptError('transcript.edits must be an array');

  return {
    raw: raw['raw'],
    segments: raw['segments'].map((item, index) => parseSegment(item, index)),
    edits: raw['edits'].map((item, index) => parseEdit(item, index)),
  };
}

function parseAudio(raw: unknown): AudioProvenance {
  if (!isPlainObject(raw)) throw new TranscriptError('audio is not an object');

  const path = raw['path'];
  if (typeof path !== 'string') throw new TranscriptError('audio.path must be a string');
  const sha256 = raw['sha256'];
  if (typeof sha256 !== 'string') throw new TranscriptError('audio.sha256 must be a string');
  const sourceDurationSec = raw['sourceDurationSec'];
  if (!isFiniteNumber(sourceDurationSec)) {
    throw new TranscriptError('audio.sourceDurationSec must be a number');
  }
  const durationSec = raw['durationSec'];
  if (!isFiniteNumber(durationSec)) throw new TranscriptError('audio.durationSec must be a number');
  if (raw['sampleRate'] !== 16000) throw new TranscriptError('audio.sampleRate must be 16000');
  if (raw['channels'] !== 1) throw new TranscriptError('audio.channels must be 1');
  const denoised = raw['denoised'];
  if (typeof denoised !== 'boolean') throw new TranscriptError('audio.denoised must be a boolean');
  const trim = raw['trim'];
  if (!isPlainObject(trim) || !Array.isArray(trim['segments'])) {
    throw new TranscriptError('audio.trim.segments must be an array');
  }

  const segments = trim['segments'].map((item, index) => {
    const where = `audio.trim.segments[${index}]`;
    if (!isPlainObject(item)) throw new TranscriptError(`${where} is not an object`);
    const outStart = item['outStart'];
    if (!isFiniteNumber(outStart)) throw new TranscriptError(`${where}.outStart must be a number`);
    const outEnd = item['outEnd'];
    if (!isFiniteNumber(outEnd)) throw new TranscriptError(`${where}.outEnd must be a number`);
    const srcStart = item['srcStart'];
    if (!isFiniteNumber(srcStart)) throw new TranscriptError(`${where}.srcStart must be a number`);
    const srcEnd = item['srcEnd'];
    if (!isFiniteNumber(srcEnd)) throw new TranscriptError(`${where}.srcEnd must be a number`);
    return { outStart, outEnd, srcStart, srcEnd };
  });

  return {
    path,
    sha256,
    sourceDurationSec,
    durationSec,
    sampleRate: 16000,
    channels: 1,
    denoised,
    trim: { segments },
  };
}

function parseGate(raw: unknown): QualityGateReport {
  if (!isPlainObject(raw)) throw new TranscriptError('gate is not an object');
  const pass = raw['pass'];
  if (typeof pass !== 'boolean') throw new TranscriptError('gate.pass must be a boolean');
  if (!Array.isArray(raw['checks'])) throw new TranscriptError('gate.checks must be an array');

  const checks = raw['checks'].map((item, index) => {
    const where = `gate.checks[${index}]`;
    if (!isPlainObject(item)) throw new TranscriptError(`${where} is not an object`);
    const id = item['id'];
    if (typeof id !== 'string' || !GATE_CHECK_IDS.includes(id as GateCheckId)) {
      throw new TranscriptError(`${where}.id is not a known check id`);
    }
    const value = item['value'];
    const threshold = item['threshold'];
    if (!isFiniteNumber(value) || !isFiniteNumber(threshold)) {
      throw new TranscriptError(`${where}.value and threshold must be numbers`);
    }
    const checkPass = item['pass'];
    if (typeof checkPass !== 'boolean') throw new TranscriptError(`${where}.pass must be a boolean`);
    return { id: id as GateCheckId, value, threshold, pass: checkPass };
  });

  return { pass, checks };
}

function parseRetrieval(raw: unknown): RetrievalResult {
  if (!isPlainObject(raw)) throw new TranscriptError('retrieval is not an object');
  const k = raw['k'];
  if (!isFiniteNumber(k)) throw new TranscriptError('retrieval.k must be a number');
  if (!Array.isArray(raw['terms'])) throw new TranscriptError('retrieval.terms must be an array');
  const hits = raw['hits'];
  if (!isFiniteNumber(hits)) throw new TranscriptError('retrieval.hits must be a number');
  const shortCircuit = raw['shortCircuit'];
  if (typeof shortCircuit !== 'boolean') {
    throw new TranscriptError('retrieval.shortCircuit must be a boolean');
  }

  const terms = raw['terms'].map((item, index) => {
    const where = `retrieval.terms[${index}]`;
    if (!isPlainObject(item)) throw new TranscriptError(`${where} is not an object`);
    const id = item['id'];
    if (typeof id !== 'string') throw new TranscriptError(`${where}.id must be a string`);
    const score = item['score'];
    if (!isFiniteNumber(score)) throw new TranscriptError(`${where}.score must be a number`);
    const floor = item['floor'];
    if (typeof floor !== 'boolean') throw new TranscriptError(`${where}.floor must be a boolean`);
    return { id, score, floor };
  });

  return { k, terms, hits, shortCircuit };
}

function parseDroppedEdits(raw: unknown): readonly DroppedEdit[] {
  if (!Array.isArray(raw)) throw new TranscriptError('droppedEdits must be an array');

  return raw.map((item, index) => {
    const where = `droppedEdits[${index}]`;
    if (!isPlainObject(item)) throw new TranscriptError(`${where} is not an object`);
    const guard = item['guard'];
    if (typeof guard !== 'string' || !GUARD_IDS.includes(guard as GuardId)) {
      throw new TranscriptError(`${where}.guard is not a known guard id`);
    }
    const original = item['original'];
    const replacement = item['replacement'];
    if (typeof original !== 'string' || typeof replacement !== 'string') {
      throw new TranscriptError(`${where}.original and replacement must be strings`);
    }
    const termId = item['termId'];
    if (termId !== null && typeof termId !== 'string') {
      throw new TranscriptError(`${where}.termId must be null or a string`);
    }
    const distance = item['distance'];
    if (distance !== null && !isFiniteNumber(distance)) {
      throw new TranscriptError(`${where}.distance must be null or a number`);
    }
    return { guard: guard as GuardId, original, replacement, termId, distance };
  });
}

function parseStages(raw: unknown): readonly StageRecord[] {
  if (!Array.isArray(raw)) throw new TranscriptError('stages must be an array');

  return raw.map((item, index) => {
    const where = `stages[${index}]`;
    if (!isPlainObject(item)) throw new TranscriptError(`${where} is not an object`);
    if (typeof item['stage'] !== 'string') throw new TranscriptError(`${where}.stage must be a string`);
    if (!isFiniteNumber(item['durationMs'])) throw new TranscriptError(`${where}.durationMs must be a number`);
    if (typeof item['ok'] !== 'boolean') throw new TranscriptError(`${where}.ok must be a boolean`);
    return { stage: item['stage'], durationMs: item['durationMs'], ok: item['ok'] };
  });
}

/**
 * Structural validation, hand-written in the style of `src/lexicon/load.ts`.
 * Failures name the offending **index**, never the offending text.
 */
export function parseTranscriptDocument(json: unknown): TranscriptDocument {
  if (!isPlainObject(json)) throw new TranscriptError('document is not an object');

  if (json['kind'] !== TRANSCRIPT_DOCUMENT_KIND) {
    throw new TranscriptError('document.kind is not a transcript document');
  }
  if (json['version'] !== 1) throw new TranscriptError('document.version must be 1');
  for (const key of ['audio', 'gate', 'retrieval'] as const) {
    if (json[key] !== null && !isPlainObject(json[key])) {
      throw new TranscriptError(`${key} must be null or an object`);
    }
  }
  if (json['asrModel'] !== null && typeof json['asrModel'] !== 'string') {
    throw new TranscriptError('asrModel must be null or a string');
  }

  return {
    kind: TRANSCRIPT_DOCUMENT_KIND,
    version: 1,
    audio: json['audio'] === null ? null : parseAudio(json['audio']),
    asrModel: json['asrModel'],
    gate: json['gate'] === null ? null : parseGate(json['gate']),
    retrieval: json['retrieval'] === null ? null : parseRetrieval(json['retrieval']),
    droppedEdits: parseDroppedEdits(json['droppedEdits']),
    transcript: parseTranscript(json['transcript']),
    stages: parseStages(json['stages']),
  };
}

/** A fresh envelope: every stage-owned field at its null/[] default. */
export function emptyDocument(transcript: Transcript): TranscriptDocument {
  return {
    kind: TRANSCRIPT_DOCUMENT_KIND,
    version: 1,
    audio: null,
    asrModel: null,
    gate: null,
    retrieval: null,
    droppedEdits: [],
    transcript,
    stages: [],
  };
}

/** Read and parse a `*.transcript.json` file. */
export function readTranscriptDocument(path: string): TranscriptDocument {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new TranscriptError(`cannot read ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TranscriptError(`file ${path} is not valid JSON`);
  }
  return parseTranscriptDocument(json);
}

/** Write per §0.6: pretty JSON, UTF-8, trailing newline, parent dirs created. */
export function writeTranscriptDocument(path: string, doc: TranscriptDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/** Return the document with one more stage run appended. */
export function withStage(doc: TranscriptDocument, record: StageRecord): TranscriptDocument {
  return { ...doc, stages: [...doc.stages, record] };
}
