import { LOG_LEVELS, type LogLevel } from './config.js';
import type { FieldSignal, ValidationOutcome } from '../schema/types.js';

/**
 * Structured logging with a redaction allowlist (ARCHITECTURE.md §7).
 *
 * > "Structured logging with a redaction allowlist. Log field *names*,
 * > validation outcomes, timings, model versions, edit counts. Never values,
 * > transcript text, or identifiers. Make the logger structurally incapable —
 * > have it accept `FieldSignal`, which contains no PHI by construction."
 *
 * Three layers enforce that, because a comment is not an enforcement mechanism:
 *
 *  1. **No free-text channel.** There is no `message` parameter. An event is a
 *     token: `/^[A-Za-z0-9._:+@/-]{1,96}$/`, no whitespace. You cannot write a
 *     sentence — let alone a transcript — into a log line.
 *  2. **Closed key set.** {@link LogRecord} is a mapped type over
 *     {@link FIELD_KINDS} with no index signature, so `{ transcript: "…" }` is
 *     a compile error at every call site.
 *  3. **Runtime value shapes.** Every allowlisted key declares a *kind*, and a
 *     value that does not match its kind is replaced with `[redacted]`. Even
 *     with an `as never` cast, a transcript cannot survive: prose contains
 *     spaces, and no kind admits whitespace.
 *
 * Output is NDJSON on **stderr** — stdout belongs to the CLI's data output so
 * `ophtha-scribe transcribe … | jq` stays usable.
 */

/** Value shapes an allowlisted log key may carry. None of them admit prose. */
export type FieldKind = 'token' | 'path' | 'number' | 'boolean' | 'outcome' | 'hash';

/**
 * The allowlist. Adding a key here is the only way to get it into a log line,
 * which makes this table the single place to review for PHI leakage.
 */
export const FIELD_KINDS = {
  /** Pipeline stage: `transcribe`, `repair`, `laterality`, `extract`, `render`. */
  stage: 'token',
  /** CLI verb being executed. */
  verb: 'token',
  /** Schema field *path* — `od.anterior.cornea`, never its value. */
  field: 'path',
  /** Lexicon term id or deterministic rule name behind an edit. */
  reason: 'token',
  /** `repair` | `lexicon` | `laterality` | `human` (Edit.source). */
  editSource: 'token',
  /** ASR model identifier, e.g. `parakeet-tdt-0.6b-v2-int8`. */
  asrModel: 'token',
  /** LLM model identifier, e.g. `qwen3-8b-q4_k_m`. */
  llmModel: 'token',
  /** Application version. */
  appVersion: 'token',
  /** Generated artefact path, e.g. `gbnf/od.anterior.gbnf`. Build tree, not PHI. */
  artefact: 'token',
  /** Error class name or `code` — never `error.message`, which may quote input. */
  errName: 'token',
  /** Process exit code / HTTP status. */
  code: 'number',
  /** Hex digest. Identifies a transcript without revealing it. */
  transcriptHash: 'hash',
  durationMs: 'number',
  /** Generic counter; prefer a specific one below where it exists. */
  count: 'number',
  editCount: 'number',
  droppedEditCount: 'number',
  fieldCount: 'number',
  nullFieldCount: 'number',
  flaggedFieldCount: 'number',
  glossaryHitCount: 'number',
  tokenCount: 'number',
  segmentCount: 'number',
  attempt: 'number',
  /** Mean per-token ASR score; a quality-gate input, not content. */
  meanScore: 'number',
  decisionLogprob: 'number',
  hasEvidence: 'boolean',
  evidenceVerbatim: 'boolean',
  evidenceResolved: 'boolean',
  touchedByRepair: 'boolean',
  ok: 'boolean',
  validation: 'outcome',
} as const satisfies Record<string, FieldKind>;

/** Keys a log record may carry. */
export type LogField = keyof typeof FIELD_KINDS;

type ValueOfKind<K extends FieldKind> = K extends 'number'
  ? number
  : K extends 'boolean'
    ? boolean
    : K extends 'outcome'
      ? ValidationOutcome
      : string;

/**
 * A loggable record: allowlisted keys only, each with its declared value shape.
 * No index signature, so excess properties are a compile error.
 */
export type LogRecord = {
  [K in LogField]?: ValueOfKind<(typeof FIELD_KINDS)[K]> | undefined;
};

/** Placeholder substituted for any value that fails its kind check. */
export const REDACTED = '[redacted]';

const TOKEN_RE = /^[A-Za-z0-9._:+@/-]{1,96}$/;
const PATH_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+|\[\d+\])*$/;
const HASH_RE = /^[A-Fa-f0-9]{8,128}$/;
const OUTCOMES: readonly string[] = ['ok', 'warn', 'fail'];

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function matchesKind(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'token':
      return isToken(value);
    case 'path':
      return typeof value === 'string' && value.length <= 120 && PATH_RE.test(value);
    case 'hash':
      return typeof value === 'string' && HASH_RE.test(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'outcome':
      return typeof value === 'string' && OUTCOMES.includes(value);
  }
}

/** Result of scrubbing a candidate record. */
export interface Redacted {
  /** Allowlisted keys whose values passed their kind check. */
  readonly fields: Record<string, string | number | boolean>;
  /** How many keys were not on the allowlist. The *names* are never reported. */
  readonly droppedFieldCount: number;
  /** Allowlisted keys whose values failed their kind check. */
  readonly redactedFields: readonly string[];
}

/**
 * Scrub an arbitrary object down to the allowlist.
 *
 * Accepts `unknown` on purpose: the compile-time guard is the first line of
 * defence, and this is the second, for values that arrived through a cast, a
 * JSON parse, or an `any` from a dependency.
 */
export function redact(record: unknown): Redacted {
  const fields: Record<string, string | number | boolean> = {};
  const redactedFields: string[] = [];
  let droppedFieldCount = 0;

  if (typeof record !== 'object' || record === null) {
    return { fields, droppedFieldCount, redactedFields };
  }

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(FIELD_KINDS, key)) {
      // Deliberately do not report the key name: a key can be PHI too
      // (`{ [patientName]: 1 }`).
      droppedFieldCount += 1;
      continue;
    }
    const kind: FieldKind = FIELD_KINDS[key as LogField];
    if (matchesKind(kind, value)) {
      fields[key] = value as string | number | boolean;
    } else {
      fields[key] = REDACTED;
      redactedFields.push(key);
    }
  }

  return { fields, droppedFieldCount, redactedFields };
}

/** One emitted log line, after redaction. */
export interface LogEntry {
  readonly time: string;
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly event: string;
  readonly [key: string]: string | number | boolean | readonly string[] | undefined;
}

export type LogSink = (entry: LogEntry) => void;

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** Fields merged into every entry (e.g. `{ stage: 'repair' }`). */
  readonly bindings?: LogRecord;
  readonly sink?: LogSink;
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => Date;
}

export interface Logger {
  readonly level: LogLevel;
  debug(event: string, fields?: LogRecord): void;
  info(event: string, fields?: LogRecord): void;
  warn(event: string, fields?: LogRecord): void;
  error(event: string, fields?: LogRecord): void;
  /** Derive a logger with extra bound fields. */
  child(bindings: LogRecord): Logger;
  /**
   * Start a timer. Call the returned function to emit `event` with
   * `durationMs`. Timings are explicitly allowlisted by §7.
   */
  time(event: string, fields?: LogRecord): (extra?: LogRecord) => void;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const ndjsonSink: LogSink = (entry) => {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
};

/** Ordered log levels, lowest first (re-exported for CLI help text). */
export const LEVELS = LOG_LEVELS;

export function createLogger(options: LoggerOptions = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  const sink: LogSink = options.sink ?? ndjsonSink;
  const now = options.now ?? ((): Date => new Date());
  const bound = redact(options.bindings ?? {});

  const emit = (entryLevel: Exclude<LogLevel, 'silent'>, event: string, fields?: LogRecord): void => {
    if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) return;

    const scrubbed = redact(fields ?? {});
    const droppedFieldCount = bound.droppedFieldCount + scrubbed.droppedFieldCount;
    const redactedFields = [...bound.redactedFields, ...scrubbed.redactedFields];

    const entry: LogEntry = {
      time: now().toISOString(),
      level: entryLevel,
      // An event name is a token, never prose: no whitespace can get through.
      event: isToken(event) ? event : REDACTED,
      ...bound.fields,
      ...scrubbed.fields,
      ...(droppedFieldCount > 0 ? { droppedFieldCount } : {}),
      ...(redactedFields.length > 0 ? { redactedFields } : {}),
    };

    sink(entry);
  };

  const logger: Logger = {
    level,
    debug: (event, fields) => {
      emit('debug', event, fields);
    },
    info: (event, fields) => {
      emit('info', event, fields);
    },
    warn: (event, fields) => {
      emit('warn', event, fields);
    },
    error: (event, fields) => {
      emit('error', event, fields);
    },
    child: (bindings) =>
      createLogger({
        level,
        sink,
        now,
        bindings: { ...(options.bindings ?? {}), ...bindings },
      }),
    time: (event, fields) => {
      const startedAt = now().getTime();
      return (extra?: LogRecord): void => {
        emit('info', event, {
          ...fields,
          ...extra,
          durationMs: now().getTime() - startedAt,
        });
      };
    },
  };

  return logger;
}

/**
 * Project a {@link FieldSignal} into a log record.
 *
 * §7's worked example: a `FieldSignal` contains no PHI by construction — a
 * schema path, four booleans, a logprob and a validation outcome — so it is
 * safe to log wholesale.
 */
export function fieldSignalRecord(signal: FieldSignal): LogRecord {
  return {
    field: signal.path,
    hasEvidence: signal.hasEvidence,
    evidenceVerbatim: signal.evidenceVerbatim,
    evidenceResolved: signal.evidenceResolved,
    decisionLogprob: signal.decisionLogprob,
    touchedByRepair: signal.touchedByRepair,
    validation: signal.validation,
  };
}

/**
 * Project an error into a log record: class name and numeric `code` only.
 *
 * `error.message` is deliberately dropped — a parse error or a failed
 * assertion routinely quotes the input that caused it, and the input here is a
 * transcript.
 */
export function errorRecord(error: unknown): LogRecord {
  if (error instanceof Error) {
    const code: unknown = (error as { code?: unknown }).code;
    return {
      errName: error.name,
      ...(typeof code === 'number' ? { code } : {}),
    };
  }
  return { errName: typeof error };
}
