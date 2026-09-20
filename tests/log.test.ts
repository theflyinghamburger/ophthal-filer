import { describe, expect, it } from 'vitest';

import type { FieldSignal } from '../src/schema/types.js';
import {
  FIELD_KINDS,
  type LogEntry,
  type Logger,
  REDACTED,
  createLogger,
  errorRecord,
  fieldSignalRecord,
  redact,
} from '../src/util/log.js';

/** A logger that captures entries instead of writing to stderr. */
function capturing(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (entry) => entries.push(entry),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  return { logger, entries };
}

/** Representative PHI: prose from a dictation. */
const TRANSCRIPT =
  'Cornea clear OU, anterior chamber deep and quiet, no cells or flare, ' +
  'lens shows two plus nuclear sclerosis.';

describe('redact', () => {
  it('keeps allowlisted keys whose values match their declared kind', () => {
    const { fields, droppedFieldCount, redactedFields } = redact({
      stage: 'repair',
      field: 'od.anterior.cornea',
      editCount: 12,
      touchedByRepair: true,
      validation: 'warn',
      transcriptHash: 'deadbeefcafe1234',
    });

    expect(fields).toEqual({
      stage: 'repair',
      field: 'od.anterior.cornea',
      editCount: 12,
      touchedByRepair: true,
      validation: 'warn',
      transcriptHash: 'deadbeefcafe1234',
    });
    expect(droppedFieldCount).toBe(0);
    expect(redactedFields).toEqual([]);
  });

  it('drops keys that are not on the allowlist, without echoing their names', () => {
    const result = redact({
      transcript: TRANSCRIPT,
      patientName: 'Asha Menon',
      'od.anterior.cornea': 'clear',
      stage: 'extract',
    });

    expect(result.fields).toEqual({ stage: 'extract' });
    expect(result.droppedFieldCount).toBe(3);
    // The key name itself can be PHI, so it must not appear anywhere.
    expect(JSON.stringify(result)).not.toContain('patientName');
    expect(JSON.stringify(result)).not.toContain('Asha');
  });

  it('redacts an allowlisted key whose value is prose rather than a token', () => {
    // The dangerous case: a transcript smuggled in through a legitimate key.
    const result = redact({ reason: TRANSCRIPT, field: TRANSCRIPT });

    expect(result.fields['reason']).toBe(REDACTED);
    expect(result.fields['field']).toBe(REDACTED);
    expect(result.redactedFields).toEqual(['reason', 'field']);
    expect(JSON.stringify(result)).not.toContain('nuclear sclerosis');
  });

  it('rejects field values dressed up as schema paths', () => {
    // `2+ nuclear sclerosis` is a value, not a path; only paths pass.
    expect(redact({ field: '2+ nuclear sclerosis' }).fields['field']).toBe(REDACTED);
    expect(redact({ field: 'plan.glasses[0].od.sphere' }).fields['field']).toBe(
      'plan.glasses[0].od.sphere',
    );
  });

  it('enforces the declared kind for numbers, booleans, outcomes and hashes', () => {
    expect(redact({ editCount: Number.NaN }).fields['editCount']).toBe(REDACTED);
    expect(redact({ editCount: '12' }).fields['editCount']).toBe(REDACTED);
    expect(redact({ ok: 'yes' }).fields['ok']).toBe(REDACTED);
    expect(redact({ validation: 'maybe' }).fields['validation']).toBe(REDACTED);
    expect(redact({ transcriptHash: 'not a hash' }).fields['transcriptHash']).toBe(REDACTED);
    expect(redact({ validation: 'fail' }).fields['validation']).toBe('fail');
  });

  it('skips undefined values rather than emitting nulls', () => {
    const result = redact({ stage: 'asr', editCount: undefined });
    expect(result.fields).toEqual({ stage: 'asr' });
    expect(result.droppedFieldCount).toBe(0);
  });

  it('tolerates non-objects', () => {
    expect(redact(TRANSCRIPT).fields).toEqual({});
    expect(redact(null).fields).toEqual({});
    expect(redact(undefined).droppedFieldCount).toBe(0);
  });

  it('admits no whitespace in any kind, which is what blocks prose structurally', () => {
    for (const key of Object.keys(FIELD_KINDS)) {
      const result = redact({ [key]: 'two words' });
      expect(result.fields[key] ?? REDACTED).toBe(REDACTED);
    }
  });
});

describe('createLogger', () => {
  it('emits a structured entry with level, time and event', () => {
    const { logger, entries } = capturing();
    logger.info('asr.completed', { durationMs: 1234, segmentCount: 9 });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      time: '2026-01-01T00:00:00.000Z',
      level: 'info',
      event: 'asr.completed',
      durationMs: 1234,
      segmentCount: 9,
    });
  });

  it('redacts an event name that is prose rather than a token', () => {
    const { logger, entries } = capturing();
    logger.error(`failed on: ${TRANSCRIPT}`);
    expect(entries[0]?.event).toBe(REDACTED);
    expect(JSON.stringify(entries[0])).not.toContain('Cornea');
  });

  it('filters by level', () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({ level: 'warn', sink: (entry) => entries.push(entry) });
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(entries.map((entry) => entry.event)).toEqual(['c', 'd']);
  });

  it('emits nothing at level silent', () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({ level: 'silent', sink: (entry) => entries.push(entry) });
    logger.error('boom');
    expect(entries).toEqual([]);
  });

  it('merges child bindings into every entry', () => {
    const { logger, entries } = capturing();
    const child = logger.child({ stage: 'repair', llmModel: 'qwen3-8b-q4_k_m' });
    child.info('pass_a.started');
    child.child({ attempt: 2 }).info('pass_a.retried');

    expect(entries[0]).toMatchObject({ stage: 'repair', llmModel: 'qwen3-8b-q4_k_m' });
    expect(entries[1]).toMatchObject({ stage: 'repair', attempt: 2 });
  });

  it('reports counts of dropped and redacted fields so leakage is visible', () => {
    const { logger, entries } = capturing();
    logger.info('extract.field', { reason: TRANSCRIPT, notAKey: 1 } as never);

    expect(entries[0]).toMatchObject({
      droppedFieldCount: 1,
      redactedFields: ['reason'],
      reason: REDACTED,
    });
  });

  it('times a stage without exposing anything but the duration', () => {
    const entries: LogEntry[] = [];
    let tick = 0;
    const logger = createLogger({
      level: 'debug',
      sink: (entry) => entries.push(entry),
      now: () => new Date(1_700_000_000_000 + (tick += 250)),
    });

    const done = logger.time('pass_b.extract', { stage: 'extract' });
    done({ fieldCount: 38 });

    expect(entries[0]).toMatchObject({
      event: 'pass_b.extract',
      stage: 'extract',
      fieldCount: 38,
      durationMs: 250,
    });
  });
});

describe('fieldSignalRecord', () => {
  it('projects a FieldSignal, which is PHI-free by construction', () => {
    const signal: FieldSignal = {
      path: 'os.posterior.cdRatio.vertical',
      hasEvidence: true,
      evidenceVerbatim: false,
      evidenceResolved: false,
      decisionLogprob: -0.42,
      touchedByRepair: true,
      validation: 'warn',
    };

    const { logger, entries } = capturing();
    logger.warn('field.flagged', fieldSignalRecord(signal));

    expect(entries[0]).toMatchObject({
      event: 'field.flagged',
      field: 'os.posterior.cdRatio.vertical',
      hasEvidence: true,
      evidenceVerbatim: false,
      decisionLogprob: -0.42,
      validation: 'warn',
    });
    expect(entries[0]?.['redactedFields']).toBeUndefined();
    expect(entries[0]?.['droppedFieldCount']).toBeUndefined();
  });
});

describe('errorRecord', () => {
  it('keeps the error class name and drops the message', () => {
    const error = new TypeError(`cannot parse "${TRANSCRIPT}"`);
    const record = errorRecord(error);

    expect(record).toEqual({ errName: 'TypeError' });
    expect(JSON.stringify(record)).not.toContain('Cornea');
  });

  it('keeps a numeric code when present', () => {
    const error = Object.assign(new Error('spawn failed'), { code: 127 });
    expect(errorRecord(error)).toEqual({ errName: 'Error', code: 127 });
  });

  it('handles non-Error throws', () => {
    expect(errorRecord(TRANSCRIPT)).toEqual({ errName: 'string' });
  });
});
