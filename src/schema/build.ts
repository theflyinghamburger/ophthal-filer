/**
 * Codegen entry point — `npm run schema:build` (ARCHITECTURE.md §6.4).
 *
 * ```
 * build/schema/
 *   zod-schemas.ts            1. zod, runtime validation
 *   json/<section>.schema.json  2. JSON Schema, per §5.6 section
 *   gbnf/<section>.gbnf         3. GBNF, per section, for llama.cpp
 *   field-manifest.json       4. PDF widgets: name, type, page, options
 *   review-fields.json        5. review UI: label, group, order, widget
 *   validation-rules.json     §6.5 rule table, for #16
 *   assumptions.json          the under-specified shapes, for #20
 * ```
 *
 * Deterministic by construction: no timestamps, no version stamps, no
 * filesystem or environment input. Re-running produces byte-identical output,
 * which is what lets `--check` treat any difference as drift.
 *
 * `src/schema/artefacts.lock.json` is committed and carries a SHA-256 per
 * artefact plus the full field path list. A clinical field cannot be added,
 * renamed or dropped without that diff showing up in review — §6.4's "a
 * drifted field silently drops a clinical finding", made loud.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, type Logger } from '../util/log.js';
import { getConfig } from '../util/config.js';
import {
  assumptionRegister,
  emptyInstance,
  GENERATED_NOTE,
  pdfFieldManifest,
  reviewFieldList,
  sectionJsonSchemas,
  validationRuleTable,
  type JsonValue,
} from './artefacts.js';
import { FIELDS, SECTION_NODES } from './form-schema.js';
import { emitGbnf, gbnfToRegExp, validateGbnf } from './gbnf.js';
import { emitZodSource } from './zod.js';

/** Where the lock lives, relative to the repository root. */
export const LOCK_PATH = 'src/schema/artefacts.lock.json';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Generate every artefact in memory, keyed by its path under `build/schema/`.
 *
 * Keys are sorted, so the lock is order-stable regardless of emission order.
 */
export function buildArtefacts(): ReadonlyMap<string, string> {
  const files = new Map<string, string>();

  files.set('zod-schemas.ts', emitZodSource());

  const schemas = sectionJsonSchemas();
  for (const { section } of SECTION_NODES) {
    files.set(`json/${section}.schema.json`, json(schemas[section]));
  }

  for (const { section, node } of SECTION_NODES) {
    const grammar = emitGbnf(node, section);
    // Verify rather than trust: a grammar that does not parse, or that cannot
    // express "nothing was stated", must never reach a model (§6.3).
    const problems = validateGbnf(grammar);
    if (problems.length > 0) {
      throw new Error(`generated grammar for ${section} is invalid: ${problems.join('; ')}`);
    }
    const empty = JSON.stringify(emptyInstance(node));
    if (!gbnfToRegExp(grammar).test(empty)) {
      throw new Error(`generated grammar for ${section} rejects the all-null instance`);
    }
    files.set(`gbnf/${section}.gbnf`, grammar);
  }

  files.set('field-manifest.json', json({ $comment: GENERATED_NOTE, fields: pdfFieldManifest() }));
  files.set('review-fields.json', json({ $comment: GENERATED_NOTE, fields: reviewFieldList() }));
  files.set('validation-rules.json', json(validationRuleTable()));
  files.set('assumptions.json', json(assumptionRegister()));

  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The committed drift lock: a digest per artefact, plus every field path. */
export function buildLock(files: ReadonlyMap<string, string> = buildArtefacts()): string {
  const artefacts: Record<string, JsonValue> = {};
  for (const [path, content] of files) artefacts[path] = sha256(content);

  return json({
    $comment:
      `${GENERATED_NOTE} Run \`npm run schema:build\` and commit the result; ` +
      'CI fails if this file disagrees with the field table.',
    fieldCount: FIELDS.length,
    extractedFieldCount: FIELDS.filter((field) => field.extracted).length,
    fields: FIELDS.map((field) => field.path),
    artefacts,
  });
}

export interface RunOptions {
  readonly check?: boolean;
  readonly logger?: Logger;
  /** Overrides `config.buildDir`; used by tests. */
  readonly outDir?: string;
  readonly repoRoot?: string;
}

/** Write every artefact, then refresh the lock. */
export function writeArtefacts(options: RunOptions = {}): number {
  const config = getConfig();
  const outDir = options.outDir ?? resolve(config.buildDir, 'schema');
  const repoRoot = options.repoRoot ?? config.repoRoot;
  const logger = options.logger ?? createLogger({ level: config.logLevel });

  const files = buildArtefacts();
  for (const [path, content] of files) {
    const target = resolve(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    logger.debug('schema.build.wrote', { artefact: path });
  }

  const lock = buildLock(files);
  writeFileSync(resolve(repoRoot, LOCK_PATH), lock, 'utf8');
  logger.info('schema.build.ok', { count: files.size, fieldCount: FIELDS.length });
  return 0;
}

/**
 * Regenerate in memory and compare against the committed lock.
 *
 * Reports the *number* of drifted artefacts and their paths (an artefact path
 * is a build-tree token, never clinical content) — never a field value.
 */
export function checkArtefacts(options: RunOptions = {}): number {
  const config = getConfig();
  const repoRoot = options.repoRoot ?? config.repoRoot;
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const lockFile = resolve(repoRoot, LOCK_PATH);

  const expected = buildLock();
  let actual: string;
  try {
    actual = readFileSync(lockFile, 'utf8');
  } catch {
    logger.error('schema.check.lock_missing', { ok: false });
    return 1;
  }

  if (actual === expected) {
    logger.info('schema.check.ok', { ok: true, fieldCount: FIELDS.length });
    return 0;
  }

  const parse = (text: string): Record<string, string> => {
    try {
      const value: unknown = JSON.parse(text);
      const artefacts: unknown = (value as { artefacts?: unknown }).artefacts;
      return typeof artefacts === 'object' && artefacts !== null
        ? (artefacts as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };

  const before = parse(actual);
  const after = parse(expected);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) logger.error('schema.check.drift', { artefact: key, ok: false });
  }
  logger.error('schema.check.failed', { ok: false });
  return 1;
}

/* c8 ignore start */
async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  return Promise.resolve(check ? checkArtefacts() : writeArtefacts());
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
/* c8 ignore stop */
