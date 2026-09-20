/**
 * The declarative field-table vocabulary (ARCHITECTURE.md §6.4).
 *
 * `form-schema.ts` describes the chart as *data* — a tree of nodes — and every
 * downstream artefact (zod, JSON Schema, GBNF, the PDF field manifest and the
 * review-UI list) is a fold over that tree. §6.4 is explicit about why:
 *
 * > "The moment two of these are hand-maintained they drift, and a drifted
 * > field silently drops a clinical finding."
 *
 * The TypeScript types in §6.1 are *derived* from the same tree by
 * {@link Shape}, so a field cannot exist in the type but be missing from an
 * artefact: there is only one list.
 */

import type { Extracted } from './types.js';

// ---------------------------------------------------------------------------
// Value specs — what a populated field may contain
// ---------------------------------------------------------------------------

/**
 * Closed sets (`enum`, `intEnum`) are enforced by the grammar, because the
 * paper form offers exactly those boxes and nothing else is representable.
 *
 * Open sets (`string`, `number`) are deliberately *not* range-constrained in
 * the grammar. §6.5 requires violations to be "flagged, never silently
 * corrected" — a grammar that can only emit an in-range sphere would silently
 * correct a mis-dictated one, and the validator would never see it.
 */
export type ValueSpec =
  | { readonly kind: 'string' }
  | { readonly kind: 'number'; readonly integer?: boolean }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly options: readonly string[] }
  | { readonly kind: 'intEnum'; readonly options: readonly number[] };

export const text = { kind: 'string' } as const;
export const decimal = { kind: 'number' } as const;
export const integer = { kind: 'number', integer: true } as const;
export const flag = { kind: 'boolean' } as const;

export function choice<const O extends readonly string[]>(
  options: O,
): { readonly kind: 'enum'; readonly options: O } {
  return { kind: 'enum', options };
}

export function intChoice<const O extends readonly number[]>(
  options: O,
): { readonly kind: 'intEnum'; readonly options: O } {
  return { kind: 'intEnum', options };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** How the field is drawn, in both the PDF and the review UI (§3.4). */
export type Widget = 'text' | 'textarea' | 'number' | 'radio' | 'checkbox';

/** AcroForm widget kinds `src/pdf/template.ts` knows how to place (#17). */
export type PdfFieldType = 'text' | 'radio' | 'checkbox';

export function pdfFieldType(widget: Widget): PdfFieldType {
  switch (widget) {
    case 'radio':
      return 'radio';
    case 'checkbox':
      return 'checkbox';
    default:
      return 'text';
  }
}

/** Presentation and validation metadata carried by every extracted field. */
export interface LeafMeta {
  /** Human label, as printed on the paper form. */
  readonly label: string;
  readonly widget: Widget;
  /**
   * Export values for a `boolean` rendered as a radio pair, `[true, false]` —
   * the form writes these as `+ / −` and `Y / N` rather than true/false.
   */
  readonly booleanLabels?: readonly [string, string];
  /** Unit, for the review UI only (never emitted into the grammar). */
  readonly unit?: string;
  /** §6.5 rule ids. TODO(#16): the validator resolves these. */
  readonly rules?: readonly string[];
  /** Page of the paper form (1-based). TODO(#14): calibration confirms. */
  readonly page?: number;
  /** Assumption recorded against this field. TODO(#20): clinician confirms. */
  readonly assumption?: string;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface LeafNode<V extends ValueSpec = ValueSpec> extends LeafMeta {
  readonly node: 'leaf';
  readonly value: V;
}

/** Provenance scalar (`meta.*`): stamped by the pipeline, never extracted. */
export interface RawNode<K extends 'string' | 'number' = 'string' | 'number'> {
  readonly node: 'raw';
  readonly kind: K;
  readonly label: string;
}

export interface ObjectNode<F extends Fields = Fields> {
  readonly node: 'object';
  readonly label: string;
  readonly fields: F;
}

export interface TupleNode<E extends AnyNode = AnyNode, L extends readonly string[] = readonly string[]> {
  readonly node: 'tuple';
  readonly label: string;
  readonly of: E;
  /** One label per slot; the slot count *is* the tuple length. */
  readonly items: L;
}

export interface ListNode<E extends AnyNode = AnyNode> {
  readonly node: 'list';
  readonly label: string;
  readonly of: E;
  /** Ruled lines available on the form — the PDF and review UI stop here. */
  readonly maxItems: number;
  readonly itemLabel: string;
}

export type AnyNode = LeafNode | RawNode | ObjectNode | TupleNode | ListNode;

export type Fields = Readonly<Record<string, AnyNode>>;

export function leaf<const V extends ValueSpec>(value: V, meta: LeafMeta): LeafNode<V> {
  return { node: 'leaf', value, ...meta };
}

export function raw<const K extends 'string' | 'number'>(kind: K, label: string): RawNode<K> {
  return { node: 'raw', kind, label };
}

export function group<const F extends Fields>(label: string, fields: F): ObjectNode<F> {
  return { node: 'object', label, fields };
}

export function tuple<const E extends AnyNode, const L extends readonly string[]>(
  label: string,
  items: L,
  of: E,
): TupleNode<E, L> {
  return { node: 'tuple', label, items, of };
}

export function list<const E extends AnyNode>(
  label: string,
  options: { readonly maxItems: number; readonly itemLabel: string },
  of: E,
): ListNode<E> {
  return { node: 'list', label, of, maxItems: options.maxItems, itemLabel: options.itemLabel };
}

// ---------------------------------------------------------------------------
// Type-level projection: node tree -> the §6.1 TypeScript shapes
// ---------------------------------------------------------------------------

export type ValueTypeOf<V> = V extends { readonly kind: 'string' }
  ? string
  : V extends { readonly kind: 'number' }
    ? number
    : V extends { readonly kind: 'boolean' }
      ? boolean
      : V extends { readonly kind: 'enum'; readonly options: readonly (infer T)[] }
        ? T
        : V extends { readonly kind: 'intEnum'; readonly options: readonly (infer T)[] }
          ? T
          : never;

/**
 * The runtime shape a node describes.
 *
 * This is what makes "every leaf in the TS type appears in all five artefacts"
 * true by construction rather than by test: the type and the artefacts are two
 * projections of one tree.
 */
export type Shape<N> = N extends { readonly node: 'leaf'; readonly value: infer V }
  ? Extracted<ValueTypeOf<V>>
  : N extends { readonly node: 'raw'; readonly kind: infer K }
    ? K extends 'number'
      ? number
      : string
    : N extends { readonly node: 'object'; readonly fields: infer F }
      ? { -readonly [K in keyof F]: Shape<F[K]> }
      : N extends { readonly node: 'tuple'; readonly of: infer E; readonly items: infer L }
        ? { -readonly [K in keyof L]: Shape<E> }
        : N extends { readonly node: 'list'; readonly of: infer E }
          ? Shape<E>[]
          : never;
