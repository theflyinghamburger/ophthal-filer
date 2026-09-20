/**
 * zod schemas for runtime validation (ARCHITECTURE.md §6.4, artefact 1).
 *
 * Two projections of the same tree, side by side so they cannot drift:
 *
 *  - {@link zodFor} builds the schemas in memory. This is what the pipeline
 *    uses to parse a model response or a draft read back off disk.
 *  - {@link emitZodSource} writes the equivalent TypeScript to
 *    `build/schema/zod-schemas.ts`, so the generated artefact is reviewable
 *    and diffable in CI like the other four.
 *
 * **Scope note.** These schemas check *shape*, not sense. A value present with
 * no evidence parses fine here — §6.2 treats a missing or non-verbatim
 * citation as a `FieldSignal` to flag, not a parse failure, because a
 * human-edited draft legitimately has values the model never cited.
 * TODO(#16): `src/schema/validate.ts` applies the §6.5 clinical rules and the
 * cross-field checks on top of a successfully parsed draft.
 */

import { z } from 'zod';

import type { AnyNode, LeafNode, ValueSpec } from './field-spec.js';
import { GENERATED_NOTE } from './artefacts.js';
import { ENCOUNTER, SECTION_NODES, type EncounterDraft } from './form-schema.js';
import { EXTRACTION_SECTIONS, type ExtractionSection } from './types.js';

/** Any schema, however it was built. zod's generics do not survive a fold. */
export type AnySchema = z.ZodType;

// ---------------------------------------------------------------------------
// Runtime construction
// ---------------------------------------------------------------------------

function zodValue(spec: ValueSpec): AnySchema {
  switch (spec.kind) {
    case 'string':
      return z.string().min(1);
    case 'number':
      return spec.integer === true ? z.number().int() : z.number();
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum([...spec.options]);
    case 'intEnum':
      return z.union(spec.options.map((option) => z.literal(option)));
  }
}

/** `Extracted<T>`: both members always present, both always nullable (§6.1). */
function zodExtracted(node: LeafNode): AnySchema {
  return z.strictObject({
    value: zodValue(node.value).nullable(),
    evidence: z.string().nullable(),
  });
}

/** Build the zod schema for any node of the field table. */
export function zodFor(node: AnyNode): AnySchema {
  switch (node.node) {
    case 'leaf':
      return zodExtracted(node);
    case 'raw':
      return node.kind === 'number' ? z.number() : z.string();
    case 'object': {
      const shape: Record<string, AnySchema> = {};
      for (const [key, child] of Object.entries(node.fields)) shape[key] = zodFor(child);
      return z.strictObject(shape);
    }
    case 'tuple': {
      const items = node.items.map(() => zodFor(node.of));
      return z.tuple(items as [AnySchema, ...AnySchema[]]);
    }
    case 'list':
      return z.array(zodFor(node.of)).max(node.maxItems);
  }
}

/** The whole chart. Parses what `ophtha-scribe extract -o …` wrote. */
export const encounterDraftSchema = zodFor(ENCOUNTER) as z.ZodType<EncounterDraft>;

/** One schema per Pass B call (§5.6), for parsing each section's response. */
export const sectionSchemas: Record<ExtractionSection, AnySchema> = Object.fromEntries(
  SECTION_NODES.map(({ section, node }) => [section, zodFor(node)]),
) as Record<ExtractionSection, AnySchema>;

// ---------------------------------------------------------------------------
// Source emission
// ---------------------------------------------------------------------------

const INDENT = '  ';

function sourceForValue(spec: ValueSpec): string {
  switch (spec.kind) {
    case 'string':
      return 'z.string().min(1)';
    case 'number':
      return spec.integer === true ? 'z.number().int()' : 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'enum':
      return `z.enum([${spec.options.map((option) => JSON.stringify(option)).join(', ')}])`;
    case 'intEnum':
      return `z.union([${spec.options.map((option) => `z.literal(${option})`).join(', ')}])`;
  }
}

function sourceForNode(node: AnyNode, depth: number): string {
  const pad = INDENT.repeat(depth);
  const inner = INDENT.repeat(depth + 1);
  switch (node.node) {
    case 'leaf':
      return [
        'z.strictObject({',
        `${inner}value: ${sourceForValue(node.value)}.nullable(),`,
        `${inner}evidence: z.string().nullable(),`,
        `${pad}})`,
      ].join('\n');
    case 'raw':
      return node.kind === 'number' ? 'z.number()' : 'z.string()';
    case 'object': {
      const entries = Object.entries(node.fields).map(
        ([key, child]) => `${inner}${JSON.stringify(key)}: ${sourceForNode(child, depth + 1)},`,
      );
      return ['z.strictObject({', ...entries, `${pad}})`].join('\n');
    }
    case 'tuple': {
      const entries = node.items.map(() => `${inner}${sourceForNode(node.of, depth + 1)},`);
      return ['z.tuple([', ...entries, `${pad}])`].join('\n');
    }
    case 'list':
      return `z.array(${sourceForNode(node.of, depth)}).max(${node.maxItems})`;
  }
}

/** `od.anterior` -> `odAnteriorSchema`. */
export function schemaIdentifier(section: string): string {
  const camel = section.replace(/[.-](\w)/g, (_match, character: string) => character.toUpperCase());
  return `${camel}Schema`;
}

/** The generated `build/schema/zod-schemas.ts` artefact. */
export function emitZodSource(): string {
  const lines: string[] = [
    `// ${GENERATED_NOTE}`,
    '// Runtime equivalent: src/schema/zod.ts (both fold the same field table).',
    '',
    "import { z } from 'zod';",
    '',
  ];

  for (const { section, node } of SECTION_NODES) {
    lines.push(`export const ${schemaIdentifier(section)} = ${sourceForNode(node, 0)};`, '');
  }

  lines.push('/** The six Pass B section schemas (ARCHITECTURE.md §5.6). */');
  lines.push('export const sectionSchemas = {');
  for (const section of EXTRACTION_SECTIONS) {
    lines.push(`${INDENT}${JSON.stringify(section)}: ${schemaIdentifier(section)},`);
  }
  lines.push('} as const;', '');

  lines.push(`export const encounterDraftSchema = ${sourceForNode(ENCOUNTER, 0)};`, '');
  return lines.join('\n');
}
