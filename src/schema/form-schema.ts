/**
 * **The single source of truth for the chart** (ARCHITECTURE.md §6.1, §6.4).
 *
 * Everything else in `src/schema/` is a fold over {@link ENCOUNTER}:
 *
 * ```
 * form-schema.ts
 *    ├─→ zod schemas           src/schema/zod.ts        runtime validation
 *    ├─→ JSON Schema           src/schema/json-schema.ts   per section (§5.6)
 *    │      └─→ GBNF grammar   src/schema/gbnf.ts       llama.cpp decoding
 *    ├─→ PDF field manifest    src/schema/artefacts.ts  name, type, page, options
 *    └─→ review UI field list  src/schema/artefacts.ts  label, group, order, widget
 * ```
 *
 * The §6.1 TypeScript interfaces are *derived* from the same tree (`Shape<…>`),
 * so there is no way to add a field to the type without it appearing in all
 * five artefacts, and no way to drop one silently.
 *
 * ## Assumptions — TODO(#20): confirm with the clinician
 *
 * `ContactLensRx`, `AdditionalTesting` and `Recommendations` are *named* but
 * not specified in §6.1. Their shapes below are inferred from the form
 * affordances listed in §3.4 and the validation bounds in §6.5. Every such
 * inference carries an `assumption:` note on the field, and the full list is
 * emitted into `build/schema/assumptions.json` by `npm run schema:build`.
 */

import {
  choice,
  decimal,
  flag,
  group,
  integer,
  intChoice,
  leaf,
  list,
  pdfFieldType,
  raw,
  text,
  tuple,
  type AnyNode,
  type Fields,
  type LeafNode,
  type PdfFieldType,
  type Shape,
  type ValueSpec,
  type Widget,
} from './field-spec.js';
import { EXTRACTION_SECTIONS, type ExtractionSection } from './types.js';

// ---------------------------------------------------------------------------
// §6.5 clinical validation rules — declared here, applied by #16
// ---------------------------------------------------------------------------

/** A numeric bound from the §6.5 table. Violations are flagged, never fixed. */
export interface ValidationRule {
  readonly id: string;
  readonly description: string;
  readonly min?: number;
  readonly max?: number;
  /** Quantisation, e.g. 0.25 D. */
  readonly step?: number;
  readonly integer?: boolean;
  /** `warn` rather than `fail`: plus-cyl is a clinical choice, not an error. */
  readonly outcome: 'warn' | 'fail';
}

/**
 * The §6.5 table, verbatim. TODO(#16): `src/schema/validate.ts` evaluates these
 * and the cross-field checks (OD/OS contamination, WNL-vs-pathology, add on a
 * DV-only Rx, evidence overlapping a rejected repair edit).
 */
export const VALIDATION_RULES = {
  'cd-ratio': {
    id: 'cd-ratio',
    description: 'C/D ratio 0.0–1.0, quantised to 0.05',
    min: 0,
    max: 1,
    step: 0.05,
    outcome: 'warn',
  },
  'grade-1-4': {
    id: 'grade-1-4',
    description: 'Angles / ALR: integer 1–4',
    min: 1,
    max: 4,
    integer: true,
    outcome: 'fail',
  },
  axis: {
    id: 'axis',
    description: 'Axis: integer 0–180',
    min: 0,
    max: 180,
    integer: true,
    outcome: 'warn',
  },
  sphere: {
    id: 'sphere',
    description: 'Sphere −30.00 to +20.00, 0.25 steps',
    min: -30,
    max: 20,
    step: 0.25,
    outcome: 'warn',
  },
  cylinder: {
    id: 'cylinder',
    description: 'Cylinder 0.25 steps; flag if positive — never auto-transpose',
    step: 0.25,
    outcome: 'warn',
  },
  add: {
    id: 'add',
    description: 'Add +0.75 to +4.00, 0.25 steps',
    min: 0.75,
    max: 4,
    step: 0.25,
    outcome: 'warn',
  },
  iop: { id: 'iop', description: 'IOP 0–80 mmHg', min: 0, max: 80, outcome: 'warn' },
  'base-curve': {
    id: 'base-curve',
    description: 'Contact lens base curve 7.0–10.0 mm',
    min: 7,
    max: 10,
    outcome: 'warn',
  },
  diameter: {
    id: 'diameter',
    description: 'Contact lens diameter 12.0–16.0 mm',
    min: 12,
    max: 16,
    outcome: 'warn',
  },
} as const satisfies Record<string, ValidationRule>;

export type ValidationRuleId = keyof typeof VALIDATION_RULES;

// ---------------------------------------------------------------------------
// §6.1 — anterior segment
// ---------------------------------------------------------------------------

const WNL_PATH = choice(['WNL', 'PATH'] as const);

const ANTERIOR_FIELDS = {
  status: leaf(WNL_PATH, { label: 'Anterior segment', widget: 'radio' }),
  lidsLashes: leaf(text, { label: 'Lids / lashes', widget: 'text' }),
  conjunctiva: leaf(text, { label: 'Conjunctiva', widget: 'text' }),
  sclera: leaf(text, { label: 'Sclera', widget: 'text' }),
  angles: leaf(intChoice([1, 2, 3, 4] as const), {
    label: 'Angles',
    widget: 'radio',
    rules: ['grade-1-4'],
  }),
  cornea: leaf(text, { label: 'Cornea', widget: 'text' }),
  irisPupil: leaf(text, { label: 'Iris / pupil', widget: 'text' }),
  anteriorChamber: leaf(text, { label: 'Anterior chamber', widget: 'text' }),
  lensMedia: leaf(text, { label: 'Lens / media', widget: 'text' }),
} as const satisfies Fields;

const ANTERIOR = group('Anterior segment', ANTERIOR_FIELDS);

// ---------------------------------------------------------------------------
// §6.1 — posterior segment
// ---------------------------------------------------------------------------

const POSTERIOR_FIELDS = {
  status: leaf(WNL_PATH, { label: 'Posterior segment', widget: 'radio' }),
  lens: leaf(choice(['20D', '78D', 'Direct'] as const), {
    label: 'Lens used',
    widget: 'radio',
  }),
  media: leaf(text, { label: 'Media', widget: 'text' }),
  cdRatio: group('C/D ratio', {
    horizontal: leaf(decimal, {
      label: 'C/D horizontal',
      widget: 'number',
      rules: ['cd-ratio'],
    }),
    vertical: leaf(decimal, {
      label: 'C/D vertical',
      widget: 'number',
      rules: ['cd-ratio'],
    }),
  }),
  shapeType: leaf(text, { label: 'Shape / type', widget: 'text' }),
  rimTissue: leaf(text, { label: 'Rim tissue', widget: 'text' }),
  venousPulsation: leaf(flag, {
    label: 'Venous pulsation',
    widget: 'radio',
    booleanLabels: ['+', '−'],
  }),
  posteriorPole: leaf(text, { label: 'Posterior pole', widget: 'text' }),
  avRatio: leaf(text, { label: 'A/V ratio', widget: 'text' }),
  alr: leaf(intChoice([1, 2, 3, 4] as const), {
    label: 'Arteriolar light reflex',
    widget: 'radio',
    rules: ['grade-1-4'],
  }),
  macularFLR: leaf(flag, {
    label: 'Macular / foveal light reflex',
    widget: 'radio',
    booleanLabels: ['+', '−'],
  }),
  periphery: leaf(text, { label: 'Periphery', widget: 'text' }),
} as const satisfies Fields;

const POSTERIOR = group('Posterior segment', POSTERIOR_FIELDS);

// ---------------------------------------------------------------------------
// §6.1 — spectacle Rx
// ---------------------------------------------------------------------------

const SPHERO_CYL_FIELDS = {
  sphere: leaf(decimal, { label: 'Sphere', widget: 'number', unit: 'D', rules: ['sphere'] }),
  cylinder: leaf(decimal, {
    label: 'Cylinder',
    widget: 'number',
    unit: 'D',
    rules: ['cylinder'],
  }),
  axis: leaf(integer, { label: 'Axis', widget: 'number', unit: '°', rules: ['axis'] }),
} as const satisfies Fields;

const SPECTACLE_FIELDS = {
  usage: leaf(choice(['DV', 'NV', 'INT', 'Other'] as const), { label: 'Usage', widget: 'radio' }),
  usageOther: leaf(text, { label: 'Usage — other', widget: 'text' }),
  od: group('OD', SPHERO_CYL_FIELDS),
  os: group('OS', SPHERO_CYL_FIELDS),
  prism: leaf(text, { label: 'Prism', widget: 'text' }),
  add: leaf(decimal, { label: 'Add', widget: 'number', unit: 'D', rules: ['add'] }),
} as const satisfies Fields;

const SPECTACLE_RX = group('Spectacle Rx', SPECTACLE_FIELDS);

// ---------------------------------------------------------------------------
// ContactLensRx — ASSUMED (§3.4 affordances: Enzyme Y/N, BC, diameter;
// §6.5 bounds: BC 7.0–10.0 mm, diameter 12.0–16.0 mm)
// ---------------------------------------------------------------------------

const CONTACT_EYE_FIELDS = {
  sphere: leaf(decimal, { label: 'Sphere', widget: 'number', unit: 'D', rules: ['sphere'] }),
  cylinder: leaf(decimal, {
    label: 'Cylinder',
    widget: 'number',
    unit: 'D',
    rules: ['cylinder'],
  }),
  axis: leaf(integer, { label: 'Axis', widget: 'number', unit: '°', rules: ['axis'] }),
  baseCurve: leaf(decimal, {
    label: 'Base curve (BC)',
    widget: 'number',
    unit: 'mm',
    rules: ['base-curve'],
    assumption:
      'BC is recorded per eye. §3.4 lists a single "BC" affordance; a shared BC ' +
      'would make this one field rather than two.',
  }),
  diameter: leaf(decimal, {
    label: 'Diameter',
    widget: 'number',
    unit: 'mm',
    rules: ['diameter'],
    assumption: 'Diameter is recorded per eye, as for BC.',
  }),
} as const satisfies Fields;

const CONTACT_LENS_FIELDS = {
  brand: leaf(text, {
    label: 'Brand / lens',
    widget: 'text',
    assumption:
      'A ruled line for the lens brand accompanies the CL Rx block ' +
      '(§3.4: ruled lines -> text fields).',
  }),
  od: group('OD', CONTACT_EYE_FIELDS),
  os: group('OS', CONTACT_EYE_FIELDS),
  add: leaf(decimal, {
    label: 'Add',
    widget: 'number',
    unit: 'D',
    rules: ['add'],
    assumption: 'Contact lens add is a single value, as on the spectacle Rx block.',
  }),
  enzyme: leaf(flag, {
    label: 'Enzyme',
    widget: 'radio',
    booleanLabels: ['Y', 'N'],
    assumption: '§3.4 names "Enzyme Y/N" as a radio group; modelled as a boolean whose ' +
      'PDF export values are Y and N. Null still means "not stated" (§6.3).',
  }),
  solution: leaf(text, {
    label: 'Solution / care',
    widget: 'text',
    assumption: 'A care-solution line is assumed to sit beside the Enzyme toggle.',
  }),
  wearingSchedule: leaf(text, {
    label: 'Wearing schedule',
    widget: 'text',
    assumption: 'Free-text wearing/replacement schedule; not named in §3.4.',
  }),
} as const satisfies Fields;

const CONTACT_LENS_RX = group('Contact lens Rx', CONTACT_LENS_FIELDS);

// ---------------------------------------------------------------------------
// AdditionalTesting — ASSUMED (§3.4: Topography 1/2/3w/1mo/2mo,
// Fields C-76 vs 24-2, SITA Std vs Fast; §6.5: IOP 0–80 mmHg)
// ---------------------------------------------------------------------------

const TESTING_FIELDS = {
  tonometry: leaf(text, {
    label: 'Tonometry',
    widget: 'text',
    assumption: '§3.4 names `plan.testing.tonometry` as a single field, so it stays a ' +
      'free-text line (method / time of day). The numeric readings live in `iop`.',
  }),
  iop: group('IOP', {
    od: leaf(decimal, { label: 'IOP OD', widget: 'number', unit: 'mmHg', rules: ['iop'] }),
    os: leaf(decimal, { label: 'IOP OS', widget: 'number', unit: 'mmHg', rules: ['iop'] }),
  }),
  topography: leaf(choice(['1w', '2w', '3w', '1mo', '2mo'] as const), {
    label: 'Topography interval',
    widget: 'radio',
    assumption: '§3.4 lists "Topography 1 2 3w 1mo 2mo". Read as a recall interval: ' +
      '1 week, 2 weeks, 3 weeks, 1 month, 2 months. If those digits are instead ' +
      'a count of scans, this becomes intChoice([1,2,3]) plus an interval.',
  }),
  visualFields: group('Visual fields', {
    program: leaf(choice(['C-76', '24-2'] as const), {
      label: 'Fields program',
      widget: 'radio',
      assumption: '§3.4: "Fields C-76 / 24-2" -> one radio group.',
    }),
    strategy: leaf(choice(['SITA Std', 'SITA Fast'] as const), {
      label: 'Fields strategy',
      widget: 'radio',
      assumption: '§3.4: "SITA Std / Fast" -> a second, independent radio group.',
    }),
  }),
} as const satisfies Fields;

const ADDITIONAL_TESTING = group('Additional testing', TESTING_FIELDS);

// ---------------------------------------------------------------------------
// Recommendations — ASSUMED (§3.4 checkboxes: Hi-Index/Asph, UV 400, Polycarb)
// ---------------------------------------------------------------------------

const RECOMMENDATION_FIELDS = {
  hiIndexAsph: leaf(flag, {
    label: 'Hi-Index / Asph',
    widget: 'checkbox',
    assumption: '§3.4 lists this as a checkbox. Unchecked and not-stated are both `null` ' +
      'per §6.3 — only an explicit recommendation sets `true`.',
  }),
  uv400: leaf(flag, {
    label: 'UV 400',
    widget: 'checkbox',
    assumption:
      '§3.4 lists "UV 400" as a checkbox on the recommendations block.',
  }),
  polycarbonate: leaf(flag, {
    label: 'Polycarb',
    widget: 'checkbox',
    assumption:
      '§3.4 lists "Polycarb" as a checkbox on the recommendations block.',
  }),
  other: leaf(text, {
    label: 'Other recommendation',
    widget: 'text',
    assumption: 'A ruled line beside the checkbox group, for recommendations with no box ' +
      '(tint, photochromic, progressive). Not named in §3.4.',
  }),
} as const satisfies Fields;

const RECOMMENDATIONS = group('Recommendations', RECOMMENDATION_FIELDS);

// ---------------------------------------------------------------------------
// The encounter
// ---------------------------------------------------------------------------

/** Ruled lines available for the assessment list on the paper form. */
export const ASSESSMENT_MAX_ITEMS = 6;

const META = group('Provenance', {
  transcriptHash: raw('string', 'Transcript hash'),
  generatedAt: raw('string', 'Generated at'),
  asrModel: raw('string', 'ASR model'),
  llmModel: raw('string', 'LLM model'),
  appVersion: raw('string', 'App version'),
  repairEditCount: raw('number', 'Pass A corrections'),
  lateralityEditCount: raw('number', 'Laterality expansions'),
});

/**
 * The whole chart. Field order here *is* the PDF and review-UI order.
 */
export const ENCOUNTER = group('Encounter', {
  meta: META,
  od: group('OD (right eye)', { anterior: ANTERIOR, posterior: POSTERIOR }),
  os: group('OS (left eye)', { anterior: ANTERIOR, posterior: POSTERIOR }),
  assessment: list(
    'Assessment',
    { maxItems: ASSESSMENT_MAX_ITEMS, itemLabel: 'Assessment' },
    leaf(text, { label: 'Assessment', widget: 'text' }),
  ),
  plan: group('Plan', {
    glasses: tuple('Spectacle Rx', ['Rx 1', 'Rx 2'] as const, SPECTACLE_RX),
    contacts: CONTACT_LENS_RX,
    testing: ADDITIONAL_TESTING,
    recommendations: RECOMMENDATIONS,
    additionalInstructions: leaf(text, {
      label: 'Additional instructions',
      widget: 'textarea',
    }),
  }),
});

// ---------------------------------------------------------------------------
// §6.1 types — derived, never hand-written
// ---------------------------------------------------------------------------

export type AnteriorSegment = Shape<typeof ANTERIOR>;
export type PosteriorSegment = Shape<typeof POSTERIOR>;
export type SpectacleRx = Shape<typeof SPECTACLE_RX>;
export type ContactLensRx = Shape<typeof CONTACT_LENS_RX>;
export type AdditionalTesting = Shape<typeof ADDITIONAL_TESTING>;
export type Recommendations = Shape<typeof RECOMMENDATIONS>;

/** What Pass B produces and the doctor signs (§6.1). */
export type EncounterDraft = Shape<typeof ENCOUNTER>;

// ---------------------------------------------------------------------------
// Walking the tree
// ---------------------------------------------------------------------------

/** One leaf of the field table, resolved to its dotted path. */
export interface FieldEntry {
  /** Dotted schema path, e.g. `plan.glasses[0].od.sphere` (§3.4). */
  readonly path: string;
  /** Which of the six Pass B calls owns it; `null` for provenance (§5.6). */
  readonly section: ExtractionSection | null;
  /** `false` for `meta.*`: stamped by the pipeline, never by the model. */
  readonly extracted: boolean;
  /** `null` for a `raw` provenance scalar. */
  readonly value: ValueSpec | null;
  /** `'string' | 'number'` for a provenance scalar. */
  readonly rawKind: 'string' | 'number' | null;
  readonly label: string;
  /** Ancestor labels joined with ` · `, for the review-UI grouping. */
  readonly groupLabel: string;
  readonly widget: Widget;
  readonly pdfType: PdfFieldType;
  /** Export values for a radio / choice widget; `null` otherwise. */
  readonly options: readonly string[] | null;
  readonly page: number;
  readonly unit: string | null;
  readonly rules: readonly string[];
  readonly assumption: string | null;
  /**
   * The `status` toggle that covers this field, if any (§6.3 review-UI
   * nicety): blank-under-an-active-WNL reads differently from blank-and-
   * forgotten.
   */
  readonly coveredBy: string | null;
  /** Position in the table walk — the PDF and review-UI ordering. */
  readonly order: number;
}

/** Default form page. TODO(#14): calibration confirms the real page count. */
const DEFAULT_PAGE = 1;

function optionsOf(node: LeafNode): readonly string[] | null {
  if (node.value.kind === 'enum') return node.value.options;
  if (node.value.kind === 'intEnum') return node.value.options.map(String);
  if (node.value.kind === 'boolean' && node.booleanLabels !== undefined) {
    return [node.booleanLabels[0], node.booleanLabels[1]];
  }
  if (node.value.kind === 'boolean' && node.widget === 'checkbox') return ['Yes'];
  return null;
}

function sectionOf(path: string): ExtractionSection | null {
  return (
    EXTRACTION_SECTIONS.find(
      (section) => path === section || path.startsWith(`${section}.`) || path.startsWith(`${section}[`),
    ) ?? null
  );
}

interface WalkContext {
  readonly path: string;
  readonly labels: readonly string[];
  readonly coveredBy: string | null;
}

/**
 * Flatten the field table into an ordered list of leaves.
 *
 * Deterministic: object key order is declaration order, which is the order the
 * artefacts are emitted in and the order the review UI shows.
 */
export function flattenLeaves(node: AnyNode = ENCOUNTER): readonly FieldEntry[] {
  const out: FieldEntry[] = [];

  const visit = (current: AnyNode, context: WalkContext): void => {
    switch (current.node) {
      case 'leaf': {
        out.push({
          path: context.path,
          section: sectionOf(context.path),
          extracted: true,
          value: current.value,
          rawKind: null,
          label: current.label,
          groupLabel: context.labels.join(' · '),
          widget: current.widget,
          pdfType: pdfFieldType(current.widget),
          options: optionsOf(current),
          page: current.page ?? DEFAULT_PAGE,
          unit: current.unit ?? null,
          rules: current.rules ?? [],
          assumption: current.assumption ?? null,
          coveredBy: context.coveredBy,
          order: out.length,
        });
        return;
      }
      case 'raw': {
        out.push({
          path: context.path,
          section: null,
          extracted: false,
          value: null,
          rawKind: current.kind,
          label: current.label,
          groupLabel: context.labels.join(' · '),
          widget: 'text',
          pdfType: 'text',
          options: null,
          page: DEFAULT_PAGE,
          unit: null,
          rules: [],
          assumption: null,
          coveredBy: null,
          order: out.length,
        });
        return;
      }
      case 'object': {
        // A `status` sibling is the blanket WNL/PATH toggle for this group.
        const status = current.fields['status'];
        const coveredBy =
          status?.node === 'leaf'
            ? `${context.path}${context.path === '' ? '' : '.'}status`
            : context.coveredBy;
        // The root's own label is not part of any group path, and a tuple slot
        // already contributed `<label> — <slot>`, so do not repeat it.
        const previous = context.labels.at(-1);
        const redundant =
          context.path === '' ||
          previous === current.label ||
          previous?.startsWith(`${current.label} — `) === true;
        const labels = redundant ? context.labels : [...context.labels, current.label];
        for (const [key, child] of Object.entries(current.fields)) {
          visit(child, {
            path: context.path === '' ? key : `${context.path}.${key}`,
            labels,
            coveredBy,
          });
        }
        return;
      }
      case 'tuple': {
        current.items.forEach((itemLabel, index) => {
          visit(current.of, {
            path: `${context.path}[${index}]`,
            labels: [...context.labels, `${current.label} — ${itemLabel}`],
            coveredBy: context.coveredBy,
          });
        });
        return;
      }
      case 'list': {
        for (let index = 0; index < current.maxItems; index += 1) {
          visit(current.of, {
            path: `${context.path}[${index}]`,
            labels: [...context.labels, current.label],
            coveredBy: context.coveredBy,
          });
        }
        return;
      }
    }
  };

  visit(node, { path: '', labels: [], coveredBy: null });
  return out;
}

/** Every leaf of the chart, in declaration order. */
export const FIELDS: readonly FieldEntry[] = flattenLeaves();

/** Leaves the model fills in (everything but `meta.*`). */
export const EXTRACTED_FIELDS: readonly FieldEntry[] = FIELDS.filter((field) => field.extracted);

/** Resolve a dotted path to its node, for the per-section emitters. */
export function nodeAt(path: string): AnyNode {
  let current: AnyNode = ENCOUNTER;
  for (const step of path.split('.')) {
    if (current.node !== 'object') throw new Error(`not an object at ${path}`);
    const next: AnyNode | undefined = current.fields[step];
    if (next === undefined) throw new Error(`no node at ${path}`);
    current = next;
  }
  return current;
}

/** The six Pass B section roots (§5.6), each with its subtree. */
export const SECTION_NODES: readonly { section: ExtractionSection; node: AnyNode }[] =
  EXTRACTION_SECTIONS.map((section) => ({ section, node: nodeAt(section) }));

/** Every assumption recorded against an under-specified field. TODO(#20). */
export const ASSUMPTIONS: readonly { path: string; assumption: string }[] = FIELDS.flatMap(
  (field) => (field.assumption === null ? [] : [{ path: field.path, assumption: field.assumption }]),
);
