/**
 * Three of the five generated artefacts (ARCHITECTURE.md §6.4): per-section
 * JSON Schema, the PDF field manifest, and the review-UI field list.
 *
 * (zod lives in `zod.ts`, GBNF in `gbnf.ts` — both larger subjects.)
 *
 * Every function here is a fold over the one field table in `form-schema.ts`.
 * None of them has a list of its own, which is the whole point of §6.4.
 */

import type { AnyNode, LeafNode, ValueSpec } from './field-spec.js';
import {
  ASSUMPTIONS,
  EXTRACTED_FIELDS,
  FIELDS,
  SECTION_NODES,
  VALIDATION_RULES,
  type FieldEntry,
} from './form-schema.js';
import type { ExtractionSection } from './types.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Provenance line carried by every generated JSON artefact. */
export const GENERATED_NOTE =
  'GENERATED FILE - do not edit. Source: src/schema/form-schema.ts (npm run schema:build).';

// ---------------------------------------------------------------------------
// JSON Schema, per section (§5.6)
// ---------------------------------------------------------------------------

/** The schema a populated `value` must satisfy. */
function valueSchema(spec: ValueSpec): JsonValue {
  switch (spec.kind) {
    case 'string':
      return { type: 'string', minLength: 1 };
    case 'number':
      return { type: spec.integer === true ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { enum: [...spec.options] };
    case 'intEnum':
      return { enum: [...spec.options] };
  }
}

/** The same, widened to admit `null` — the default state of every field. */
function nullableValueSchema(spec: ValueSpec): JsonValue {
  switch (spec.kind) {
    case 'string':
      return { type: ['string', 'null'] };
    case 'number':
      return { type: [spec.integer === true ? 'integer' : 'number', 'null'] };
    case 'boolean':
      return { type: ['boolean', 'null'] };
    case 'enum':
      return { enum: [...spec.options, null] };
    case 'intEnum':
      return { enum: [...spec.options, null] };
  }
}

/**
 * `Extracted<T>` as JSON Schema.
 *
 * The `anyOf` encodes the same invariant as the grammar: either both members
 * are null, or the value is populated *and* cited with a non-empty span.
 */
function extractedSchema(node: LeafNode): JsonValue {
  return {
    title: node.label,
    type: 'object',
    additionalProperties: false,
    required: ['value', 'evidence'],
    properties: {
      value: nullableValueSchema(node.value),
      evidence: { type: ['string', 'null'] },
    },
    anyOf: [
      {
        description: 'not stated',
        properties: { value: { type: 'null' }, evidence: { type: 'null' } },
      },
      {
        description: 'stated, with a verbatim span from the working transcript',
        properties: { value: valueSchema(node.value), evidence: { type: 'string', minLength: 1 } },
      },
    ],
  };
}

/** JSON Schema for any node of the field table. */
export function jsonSchemaFor(node: AnyNode): JsonValue {
  switch (node.node) {
    case 'leaf':
      return extractedSchema(node);
    case 'raw':
      return { title: node.label, type: node.kind };
    case 'object': {
      const properties: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(node.fields)) {
        properties[key] = jsonSchemaFor(child);
      }
      return {
        title: node.label,
        type: 'object',
        additionalProperties: false,
        required: Object.keys(node.fields),
        properties,
      };
    }
    case 'tuple':
      return {
        title: node.label,
        type: 'array',
        minItems: node.items.length,
        maxItems: node.items.length,
        prefixItems: node.items.map(() => jsonSchemaFor(node.of)),
        items: false,
      };
    case 'list':
      return {
        title: node.label,
        type: 'array',
        minItems: 0,
        maxItems: node.maxItems,
        items: jsonSchemaFor(node.of),
      };
  }
}

/** The six Pass B section schemas (§5.6), keyed by section. */
export function sectionJsonSchemas(): Record<ExtractionSection, JsonValue> {
  const out: Partial<Record<ExtractionSection, JsonValue>> = {};
  for (const { section, node } of SECTION_NODES) {
    const body = jsonSchemaFor(node);
    out[section] = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `https://ophtha-scribe.local/schema/${section}.schema.json`,
      $comment: GENERATED_NOTE,
      ...(typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}),
    };
  }
  return out as Record<ExtractionSection, JsonValue>;
}

// ---------------------------------------------------------------------------
// PDF field manifest (§3.4)
// ---------------------------------------------------------------------------

/**
 * One AcroForm widget.
 *
 * `rect` is `null` here by design: §3.4 measures rectangles against the
 * scanned background once, with the calibration harness.
 * TODO(#14): calibration fills `rect`; TODO(#17): `src/pdf/template.ts` places
 * the widgets and `fill.ts` maps an `EncounterDraft` onto them by `name`.
 */
export interface PdfField {
  /** Dotted schema path — the flat-map key the filler looks up (§3.4). */
  readonly name: string;
  readonly type: 'text' | 'radio' | 'checkbox';
  readonly page: number;
  /** Export values for a radio group / checkbox; `null` for a text field. */
  readonly options: readonly string[] | null;
  /** `[x, y, width, height]` in PDF points. Filled by calibration. */
  readonly rect: readonly [number, number, number, number] | null;
  readonly label: string;
  /** Provenance footer fields are rendered, never typed into. */
  readonly readOnly: boolean;
}

export function pdfFieldManifest(): readonly PdfField[] {
  return FIELDS.map((field) => ({
    name: field.path,
    type: field.pdfType,
    page: field.page,
    options: field.options,
    rect: null,
    label: field.label,
    readOnly: !field.extracted,
  }));
}

// ---------------------------------------------------------------------------
// Review-UI field list (§6.2, §6.3)
// ---------------------------------------------------------------------------

/** One row of the review UI. TODO(#8): the Electron review surface reads this. */
export interface ReviewField {
  readonly path: string;
  readonly label: string;
  readonly group: string;
  readonly order: number;
  readonly widget: string;
  readonly options: readonly string[] | null;
  readonly unit: string | null;
  readonly section: ExtractionSection | null;
  /** §6.5 rule ids applied to this field. TODO(#16). */
  readonly rules: readonly string[];
  /**
   * The blanket WNL/PATH toggle covering this field (§6.3): shade
   * "blank and expected" differently from "blank — did I forget to dictate
   * this?". Both stay empty either way.
   */
  readonly coveredBy: string | null;
  readonly readOnly: boolean;
}

export function reviewFieldList(): readonly ReviewField[] {
  return FIELDS.map((field: FieldEntry) => ({
    path: field.path,
    label: field.label,
    group: field.groupLabel,
    order: field.order,
    widget: field.widget,
    options: field.options,
    unit: field.unit,
    section: field.section,
    rules: field.rules,
    coveredBy: field.coveredBy,
    readOnly: !field.extracted,
  }));
}

// ---------------------------------------------------------------------------
// Instances — used by the tests, by #15's retry path and by #17's empty form
// ---------------------------------------------------------------------------

/**
 * The all-null instance of a node: what Pass B returns when the doctor said
 * nothing about a section, and the shape every grammar must accept (§6.3).
 */
export function emptyInstance(node: AnyNode): JsonValue {
  switch (node.node) {
    case 'leaf':
      return { value: null, evidence: null };
    case 'raw':
      return node.kind === 'number' ? 0 : '';
    case 'object': {
      const out: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = emptyInstance(child);
      return out;
    }
    case 'tuple':
      return node.items.map(() => emptyInstance(node.of));
    case 'list':
      return [];
  }
}

// ---------------------------------------------------------------------------
// The assumption register (#20)
// ---------------------------------------------------------------------------

/**
 * Every inference made about a type §6.1 names but does not specify.
 * TODO(#20): the clinician confirms or corrects each of these.
 */
export function assumptionRegister(): JsonValue {
  return {
    $comment: GENERATED_NOTE,
    note:
      'ContactLensRx, AdditionalTesting and Recommendations are named but not ' +
      'specified in ARCHITECTURE.md §6.1. Their shapes are inferred from the form ' +
      'affordances in §3.4 and the validation bounds in §6.5.',
    count: ASSUMPTIONS.length,
    assumptions: ASSUMPTIONS.map((entry) => ({ path: entry.path, assumption: entry.assumption })),
  };
}

/** The §6.5 rule table, emitted so #16 and the review UI share one copy. */
export function validationRuleTable(): JsonValue {
  return {
    $comment: GENERATED_NOTE,
    rules: Object.values(VALIDATION_RULES).map((rule) => ({ ...rule })),
    fields: EXTRACTED_FIELDS.filter((field) => field.rules.length > 0).map((field) => ({
      path: field.path,
      rules: [...field.rules],
    })),
  };
}
