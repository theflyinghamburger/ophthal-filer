import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  emptyInstance,
  jsonSchemaFor,
  pdfFieldManifest,
  reviewFieldList,
  sectionJsonSchemas,
  type JsonValue,
} from '../src/schema/artefacts.js';
import { buildArtefacts, buildLock, checkArtefacts } from '../src/schema/build.js';
import type { AnyNode, ValueSpec } from '../src/schema/field-spec.js';
import {
  ASSUMPTIONS,
  EXTRACTED_FIELDS,
  FIELDS,
  SECTION_NODES,
  VALIDATION_RULES,
  nodeAt,
  type AdditionalTesting,
  type AnteriorSegment,
  type ContactLensRx,
  type EncounterDraft,
  type PosteriorSegment,
  type Recommendations,
  type SpectacleRx,
} from '../src/schema/form-schema.js';
import { emitGbnf, gbnfToRegExp, parseGbnf, ruleName, validateGbnf } from '../src/schema/gbnf.js';
import { EXTRACTION_SECTIONS, type EncounterMeta, type Extracted } from '../src/schema/types.js';
import { emitZodSource, encounterDraftSchema, sectionSchemas } from '../src/schema/zod.js';
import { loadConfig } from '../src/util/config.js';
import { createLogger } from '../src/util/log.js';

// ---------------------------------------------------------------------------
// Compile-time conformance with ARCHITECTURE.md §6.1
//
// The derived types must equal the interfaces the document specifies. These
// aliases are checked by `npm run typecheck`; a mismatch is a build error, not
// a test failure, which is the earliest place to catch it.
// ---------------------------------------------------------------------------

// The standard exact-equality trick: each type parameter appears once by
// design, which is exactly what makes the comparison invariant.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

interface DocAnteriorSegment {
  status: Extracted<'WNL' | 'PATH'>;
  lidsLashes: Extracted<string>;
  conjunctiva: Extracted<string>;
  sclera: Extracted<string>;
  angles: Extracted<1 | 2 | 3 | 4>;
  cornea: Extracted<string>;
  irisPupil: Extracted<string>;
  anteriorChamber: Extracted<string>;
  lensMedia: Extracted<string>;
}

interface DocPosteriorSegment {
  status: Extracted<'WNL' | 'PATH'>;
  lens: Extracted<'20D' | '78D' | 'Direct'>;
  media: Extracted<string>;
  cdRatio: { horizontal: Extracted<number>; vertical: Extracted<number> };
  shapeType: Extracted<string>;
  rimTissue: Extracted<string>;
  venousPulsation: Extracted<boolean>;
  posteriorPole: Extracted<string>;
  avRatio: Extracted<string>;
  alr: Extracted<1 | 2 | 3 | 4>;
  macularFLR: Extracted<boolean>;
  periphery: Extracted<string>;
}

interface DocSpectacleRx {
  usage: Extracted<'DV' | 'NV' | 'INT' | 'Other'>;
  usageOther: Extracted<string>;
  od: { sphere: Extracted<number>; cylinder: Extracted<number>; axis: Extracted<number> };
  os: { sphere: Extracted<number>; cylinder: Extracted<number>; axis: Extracted<number> };
  prism: Extracted<string>;
  add: Extracted<number>;
}

export type AnteriorMatchesDoc = Assert<Exact<AnteriorSegment, DocAnteriorSegment>>;
export type PosteriorMatchesDoc = Assert<Exact<PosteriorSegment, DocPosteriorSegment>>;
export type SpectacleMatchesDoc = Assert<Exact<SpectacleRx, DocSpectacleRx>>;

/** The §6.1 `EncounterDraft` skeleton, minus the under-specified branches. */
export type DraftMatchesDoc = Assert<
  Exact<
    Pick<EncounterDraft, 'od' | 'os' | 'assessment'>,
    {
      od: { anterior: AnteriorSegment; posterior: PosteriorSegment };
      os: { anterior: AnteriorSegment; posterior: PosteriorSegment };
      assessment: Extracted<string>[];
    }
  >
>;

/** The derived provenance block must stay identical to `EncounterMeta`. */
export type MetaMatchesDoc = Assert<Exact<EncounterDraft['meta'], EncounterMeta>>;

export type PlanMatchesDoc = Assert<
  Exact<
    EncounterDraft['plan'],
    {
      glasses: [SpectacleRx, SpectacleRx];
      contacts: ContactLensRx;
      testing: AdditionalTesting;
      recommendations: Recommendations;
      additionalInstructions: Extracted<string>;
    }
  >
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Segment = string | number;

function segments(path: string): Segment[] {
  const out: Segment[] = [];
  for (const part of path.split('.')) {
    const match = /^([^[]+)((?:\[\d+\])*)$/.exec(part);
    if (match === null) throw new Error(`unparsable path: ${path}`);
    out.push(match[1] ?? '');
    for (const index of (match[2] ?? '').matchAll(/\[(\d+)\]/g)) {
      out.push(Number.parseInt(index[1] ?? '0', 10));
    }
  }
  return out;
}

/** A representative populated value for a spec — the grammar must accept it. */
function sampleValue(spec: ValueSpec): JsonValue {
  switch (spec.kind) {
    case 'string':
      return 'trace';
    case 'number':
      return spec.integer === true ? 90 : 0.45;
    case 'boolean':
      return true;
    case 'enum':
      return spec.options[0] ?? '';
    case 'intEnum':
      return spec.options[0] ?? 0;
  }
}

/**
 * An instance of `node` in which every field is null except the one at `rel`,
 * which carries `value` and `evidence`.
 */
function instanceWith(
  node: AnyNode,
  rel: readonly Segment[],
  evidence: string | null,
): JsonValue {
  if (rel.length === 0) {
    if (node.node !== 'leaf') throw new Error('target is not a leaf');
    return { value: sampleValue(node.value), evidence };
  }
  const [head, ...tail] = rel;
  switch (node.node) {
    case 'object': {
      const out: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(node.fields)) {
        out[key] = key === head ? instanceWith(child, tail, evidence) : emptyInstance(child);
      }
      return out;
    }
    case 'tuple':
      return node.items.map((_item, index) =>
        index === head ? instanceWith(node.of, tail, evidence) : emptyInstance(node.of),
      );
    case 'list': {
      const upto = typeof head === 'number' ? head : 0;
      return Array.from({ length: upto + 1 }, (_unused, index) =>
        index === upto ? instanceWith(node.of, tail, evidence) : emptyInstance(node.of),
      );
    }
    default:
      throw new Error(`cannot descend into ${node.node}`);
  }
}

interface ZodObjectLike {
  readonly shape: Record<string, unknown>;
}
interface ZodTupleLike {
  readonly def: { readonly items: readonly unknown[] };
}
interface ZodArrayLike {
  readonly element: unknown;
}

/** Resolve a dotted path inside a zod schema, using zod's public accessors. */
function zodAt(schema: unknown, path: readonly Segment[]): unknown {
  let current: unknown = schema;
  for (const step of path) {
    if (typeof step === 'number') {
      const tuple = current as Partial<ZodTupleLike>;
      const items = tuple.def?.items;
      current = items === undefined ? (current as ZodArrayLike).element : items[step];
    } else {
      const shape = (current as Partial<ZodObjectLike>).shape;
      if (shape === undefined) return undefined;
      current = shape[step];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/** Resolve a dotted path inside a JSON Schema document. */
function jsonSchemaAt(schema: JsonValue, path: readonly Segment[]): JsonValue | undefined {
  let current: JsonValue | undefined = schema;
  for (const step of path) {
    const record = asRecord(current);
    if (record === undefined) return undefined;
    if (typeof step === 'number') {
      const prefix = record['prefixItems'];
      current = Array.isArray(prefix) ? prefix[step] : record['items'];
    } else {
      const properties = asRecord(record['properties']);
      current = properties?.[step];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

const silent = createLogger({ level: 'silent' });

// ---------------------------------------------------------------------------
// The field table
// ---------------------------------------------------------------------------

describe('field table', () => {
  it('covers the §6.1 shape and assigns every field to a §5.6 section', () => {
    expect(FIELDS.length).toBeGreaterThan(90);
    expect(EXTRACTED_FIELDS.length).toBe(FIELDS.length - 7); // seven meta scalars
    for (const field of EXTRACTED_FIELDS) {
      expect(EXTRACTION_SECTIONS).toContain(field.section);
    }
    for (const field of FIELDS.filter((entry) => !entry.extracted)) {
      expect(field.path.startsWith('meta.')).toBe(true);
      expect(field.section).toBeNull();
    }
  });

  it('uses dotted schema paths exactly as §3.4 specifies', () => {
    const paths = new Set(FIELDS.map((field) => field.path));
    for (const path of [
      'od.anterior.lidsLashes',
      'os.posterior.cdRatio.horizontal',
      'plan.glasses[0].od.sphere',
      'plan.testing.tonometry',
    ]) {
      expect(paths.has(path)).toBe(true);
    }
  });

  it('has unique paths and a stable order', () => {
    const paths = FIELDS.map((field) => field.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(FIELDS.map((field) => field.order)).toEqual(paths.map((_path, index) => index));
  });

  it('marks blanket-WNL coverage without propagating it (§6.3)', () => {
    const sclera = FIELDS.find((field) => field.path === 'od.anterior.sclera');
    expect(sclera?.coveredBy).toBe('od.anterior.status');
    // The toggle covers itself too; what matters is that nothing populates it.
    const empty = emptyInstance(nodeAt('od.anterior'));
    expect(asRecord(empty)?.['sclera']).toEqual({ value: null, evidence: null });
  });

  it('records every assumption about an under-specified type (#20)', () => {
    expect(ASSUMPTIONS.length).toBeGreaterThan(10);
    for (const entry of ASSUMPTIONS) {
      expect(entry.assumption.length).toBeGreaterThan(20);
    }
    const paths = ASSUMPTIONS.map((entry) => entry.path);
    expect(paths.some((path) => path.startsWith('plan.contacts.'))).toBe(true);
    expect(paths.some((path) => path.startsWith('plan.testing.'))).toBe(true);
    expect(paths.some((path) => path.startsWith('plan.recommendations.'))).toBe(true);
  });

  it('only references §6.5 rules that exist', () => {
    for (const field of FIELDS) {
      for (const rule of field.rules) {
        expect(Object.keys(VALIDATION_RULES)).toContain(rule);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// No silent drops: every leaf in all five artefacts
// ---------------------------------------------------------------------------

describe('every leaf appears in all five artefacts (§6.4)', () => {
  it('1. zod', () => {
    for (const field of FIELDS) {
      const schema = zodAt(encounterDraftSchema, segments(field.path));
      expect(schema, field.path).toBeDefined();
    }
    // The emitted source is keyed by property name; an array index is
    // positional, so the list's own key is what has to be present.
    const source = emitZodSource();
    for (const field of EXTRACTED_FIELDS) {
      const key = segments(field.path)
        .filter((segment): segment is string => typeof segment === 'string')
        .at(-1);
      expect(source, field.path).toContain(`${JSON.stringify(key)}:`);
    }
  });

  it('2. JSON Schema, per section', () => {
    const schemas = sectionJsonSchemas();
    for (const field of EXTRACTED_FIELDS) {
      const section = field.section;
      expect(section, field.path).not.toBeNull();
      if (section === null) continue;
      const rel = segments(field.path).slice(segments(section).length);
      const node = jsonSchemaAt(schemas[section], rel);
      expect(node, field.path).toBeDefined();
      expect(asRecord(node)?.['properties'], field.path).toBeDefined();
    }
  });

  it('3. GBNF, per section', () => {
    for (const { section, node } of SECTION_NODES) {
      const grammar = parseGbnf(emitGbnf(node, section));
      const leaves = EXTRACTED_FIELDS.filter((field) => field.section === section);
      for (const field of leaves) {
        const name = field.path === section ? 'root' : ruleName(field.path);
        // A list's items share one rule, named after the list root.
        const expected = grammar.rules.has(name) || grammar.rules.has('root-item');
        expect(expected, `${field.path} -> ${name}`).toBe(true);
      }
    }
  });

  it('4. PDF field manifest', () => {
    const manifest = pdfFieldManifest();
    expect(manifest.map((entry) => entry.name)).toEqual(FIELDS.map((field) => field.path));
    for (const entry of manifest) {
      expect(['text', 'radio', 'checkbox']).toContain(entry.type);
      expect(entry.page).toBeGreaterThan(0);
      // TODO(#14): calibration fills these.
      expect(entry.rect).toBeNull();
      if (entry.type === 'radio') expect(entry.options?.length ?? 0).toBeGreaterThan(1);
    }
  });

  it('5. review UI field list', () => {
    const review = reviewFieldList();
    expect(review.map((entry) => entry.path)).toEqual(FIELDS.map((field) => field.path));
    for (const entry of review) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.group.length).toBeGreaterThan(0);
      expect(entry.widget.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// GBNF semantics
// ---------------------------------------------------------------------------

describe('generated grammars', () => {
  it('parse as GBNF, with no dangling or unused rules', () => {
    for (const { section, node } of SECTION_NODES) {
      const grammar = emitGbnf(node, section);
      expect(validateGbnf(grammar), section).toEqual([]);
      expect(parseGbnf(grammar).rules.has('root'), section).toBe(true);
    }
  });

  it('permit null for every field — nothing is required to be populated (§6.3)', () => {
    for (const { section, node } of SECTION_NODES) {
      const matcher = gbnfToRegExp(emitGbnf(node, section));
      expect(matcher.test(JSON.stringify(emptyInstance(node))), section).toBe(true);
    }
  });

  it('accept a populated field only when it carries non-empty evidence (§6.2)', () => {
    for (const { section, node } of SECTION_NODES) {
      const matcher = gbnfToRegExp(emitGbnf(node, section));
      const leaves = EXTRACTED_FIELDS.filter((field) => field.section === section);
      for (const field of leaves) {
        const rel = segments(field.path).slice(segments(section).length);
        const cited = JSON.stringify(instanceWith(node, rel, 'said so'));
        expect(matcher.test(cited), `cited: ${field.path}`).toBe(true);

        const uncited = JSON.stringify(instanceWith(node, rel, null));
        expect(matcher.test(uncited), `uncited: ${field.path}`).toBe(false);

        const blank = JSON.stringify(instanceWith(node, rel, ''));
        expect(matcher.test(blank), `empty evidence: ${field.path}`).toBe(false);
      }
    }
  });

  it('enforce closed option sets but leave numeric ranges to the validator (§6.5)', () => {
    const matcher = gbnfToRegExp(emitGbnf(nodeAt('od.posterior'), 'od.posterior'));
    const withAlr = (value: string): string =>
      JSON.stringify(instanceWith(nodeAt('od.posterior'), ['alr'], 'x')).replace(
        '"alr":{"value":1',
        `"alr":{"value":${value}`,
      );
    expect(matcher.test(withAlr('1'))).toBe(true);
    expect(matcher.test(withAlr('5'))).toBe(false);

    // A C/D ratio of 3.0 is nonsense, but the grammar must still emit it so
    // that #16 can flag it rather than the decoder silently correcting it.
    const cd = JSON.stringify(
      instanceWith(nodeAt('od.posterior'), ['cdRatio', 'vertical'], 'x'),
    ).replace('"vertical":{"value":0.45', '"vertical":{"value":3');
    expect(matcher.test(cd)).toBe(true);
  });

  it('rejects a recursive grammar rather than looping', () => {
    expect(() => gbnfToRegExp('root ::= "a" root')).toThrow(/recursive/);
  });

  it('round-trips literals, classes, groups and repetition', () => {
    const grammar = 'root ::= "a" ( [0-9a-f] | "b" )* "-"? ["\\\\]';
    const matcher = gbnfToRegExp(grammar);
    expect(matcher.test('a0fb-"')).toBe(true);
    expect(matcher.test('aZ')).toBe(false);
    expect(validateGbnf(grammar)).toEqual([]);
    expect(validateGbnf('root ::= missing')).toEqual(['undefined rule: missing']);
  });
});

// ---------------------------------------------------------------------------
// zod runtime behaviour
// ---------------------------------------------------------------------------

describe('zod schemas', () => {
  it('accept an all-null draft and reject unknown keys', () => {
    const empty = emptyInstance(nodeAt('od.anterior'));
    const schema = sectionSchemas['od.anterior'];
    expect(schema.safeParse(empty).success).toBe(true);

    const extra = { ...asRecord(empty), surprise: { value: null, evidence: null } };
    expect(schema.safeParse(extra).success).toBe(false);
  });

  it('reject a missing field, a wrong type and an out-of-set option', () => {
    const schema = sectionSchemas['od.anterior'];
    const base = asRecord(emptyInstance(nodeAt('od.anterior'))) ?? {};

    const missing = { ...base };
    delete missing['sclera'];
    expect(schema.safeParse(missing).success).toBe(false);

    expect(schema.safeParse({ ...base, angles: { value: 7, evidence: 'x' } }).success).toBe(false);
    expect(schema.safeParse({ ...base, angles: { value: 3, evidence: 'x' } }).success).toBe(true);
    expect(schema.safeParse({ ...base, status: { value: 'FINE', evidence: 'x' } }).success).toBe(
      false,
    );
  });

  it('parse a whole draft, provenance included', () => {
    const draft = emptyInstance(nodeAt('meta'));
    const whole = {
      meta: draft,
      od: emptyInstance(nodeAt('od')),
      os: emptyInstance(nodeAt('os')),
      assessment: [],
      plan: emptyInstance(nodeAt('plan')),
    };
    const result = encounterDraftSchema.safeParse(whole);
    expect(result.success).toBe(true);
  });

  it('agree with the emitted zod-schemas.ts artefact', async () => {
    // The runtime builder and the source emitter are two folds over one tree.
    // Import the emitted artefact and make them answer the same questions.
    const target = resolve(loadConfig().buildDir, 'schema', 'zod-source-check.ts');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, emitZodSource(), 'utf8');

    const emitted = (await import(pathToFileURL(target).href)) as {
      sectionSchemas: Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
    };

    for (const { section, node } of SECTION_NODES) {
      const empty = emptyInstance(node);
      const generated = emitted.sectionSchemas[section];
      expect(generated?.safeParse(empty).success, section).toBe(true);
      expect(sectionSchemas[section].safeParse(empty).success, section).toBe(true);

      const record = asRecord(empty);
      if (record === undefined) continue;
      const extra = { ...record, surprise: 1 };
      expect(generated?.safeParse(extra).success, section).toBe(false);
      expect(sectionSchemas[section].safeParse(extra).success, section).toBe(false);
    }
  });

  it('cap the assessment list at the form’s ruled lines', () => {
    const schema = sectionSchemas.assessment;
    const item = { value: 'cataract', evidence: 'cataract' };
    expect(schema.safeParse([]).success).toBe(true);
    expect(schema.safeParse(Array.from({ length: 6 }, () => item)).success).toBe(true);
    expect(schema.safeParse(Array.from({ length: 7 }, () => item)).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codegen
// ---------------------------------------------------------------------------

describe('schema:build', () => {
  it('is deterministic — byte-identical on re-run', () => {
    const first = buildArtefacts();
    const second = buildArtefacts();
    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [path, content] of first) {
      expect(second.get(path), path).toBe(content);
    }
    expect(buildLock(first)).toBe(buildLock(second));
  });

  it('emits all five artefact families', () => {
    const files = buildArtefacts();
    expect(files.has('zod-schemas.ts')).toBe(true);
    expect(files.has('field-manifest.json')).toBe(true);
    expect(files.has('review-fields.json')).toBe(true);
    for (const section of EXTRACTION_SECTIONS) {
      expect(files.has(`json/${section}.schema.json`), section).toBe(true);
      expect(files.has(`gbnf/${section}.gbnf`), section).toBe(true);
    }
  });

  it('contains no timestamp or other nondeterministic stamp', () => {
    for (const [path, content] of buildArtefacts()) {
      expect(content, path).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
  });

  it('agrees with the committed lock — drift fails the build', () => {
    expect(checkArtefacts({ logger: silent })).toBe(0);
  });

  it('every generated JSON artefact is valid JSON', () => {
    for (const [path, content] of buildArtefacts()) {
      if (!path.endsWith('.json')) continue;
      expect(() => JSON.parse(content) as unknown, path).not.toThrow();
    }
  });

  it('produces a JSON Schema per section that admits the all-null instance', () => {
    for (const { section, node } of SECTION_NODES) {
      const schema = asRecord(jsonSchemaFor(node));
      expect(schema, section).toBeDefined();
      expect(emptyInstance(node)).toBeDefined();
    }
  });
});
