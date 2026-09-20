/**
 * GBNF emission and verification (ARCHITECTURE.md §5.6, §6.4).
 *
 * One grammar per Pass B section, because "a single 120-field grammar on a
 * 4–8B model degrades badly". Two invariants the emitter guarantees:
 *
 *  1. **Every field can be `null`.** Nothing is required to be populated —
 *     §6.3 decided that a blank stays blank, so the grammar must never force a
 *     value out of the model.
 *  2. **A non-null `value` requires a non-empty `evidence` string.** The two
 *     are emitted as a single alternation, so "a value with no citation" is
 *     not a representable state (§6.1, §6.2).
 *
 * What the grammar deliberately does *not* constrain: numeric ranges and
 * steps. §6.5 requires violations to be "flagged, never silently corrected",
 * and a grammar that can only emit an in-range sphere would silently correct a
 * mis-dictated one before the validator ever saw it. Closed sets (`WNL|PATH`,
 * `1|2|3|4`, `C-76|24-2`) *are* enforced, because the paper form offers
 * exactly those boxes and nothing else is representable.
 *
 * The parser and {@link gbnfToRegExp} below exist so the generated grammars
 * can be checked in CI rather than trusted: a grammar that does not parse, or
 * that rejects an all-null instance, fails the build.
 */

import type { AnyNode, LeafNode, ValueSpec } from './field-spec.js';

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/** Escape a JSON fragment for use as a GBNF string literal. */
function literal(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `plan.glasses[0].od.sphere` -> `plan-glasses-0-od-sphere`. */
export function ruleName(path: string): string {
  const slug = path.replace(/\[(\d+)\]/g, '-$1').replace(/\./g, '-');
  return slug === '' ? 'root' : slug;
}

/** Shared terminals, emitted only when the section actually uses them. */
const SHARED: Readonly<Record<string, string>> = {
  // A non-empty JSON string. `evidence` uses this too, which is what makes
  // "populated but uncited" unrepresentable.
  'json-string': '"\\"" json-char+ "\\""',
  'json-char': '[^"\\\\\\x00-\\x1F\\x7F] | "\\\\" ["\\\\/bfnrt] | "\\\\u" hex hex hex hex',
  hex: '[0-9a-fA-F]',
  'json-number': '"-"? json-int ("." [0-9]+)?',
  'json-int': '"0" | [1-9] [0-9]*',
  'json-boolean': '"true" | "false"',
};

interface Emitter {
  readonly rules: Map<string, string>;
  readonly used: Set<string>;
}

function useShared(emitter: Emitter, name: string): string {
  emitter.used.add(name);
  if (name === 'json-string') useShared(emitter, 'json-char');
  if (name === 'json-char') emitter.used.add('hex');
  if (name === 'json-number') emitter.used.add('json-int');
  return name;
}

/** The grammar fragment a populated `value` may take. */
function valueExpr(emitter: Emitter, spec: ValueSpec): string {
  switch (spec.kind) {
    case 'string':
      return useShared(emitter, 'json-string');
    case 'number':
      return spec.integer === true
        ? `("-"? ${useShared(emitter, 'json-int')})`
        : useShared(emitter, 'json-number');
    case 'boolean':
      return useShared(emitter, 'json-boolean');
    case 'enum':
      return `(${spec.options.map((option) => literal(JSON.stringify(option))).join(' | ')})`;
    case 'intEnum':
      return `(${spec.options.map((option) => literal(String(option))).join(' | ')})`;
  }
}

/**
 * `{"value": null, "evidence": null}` or `{"value": V, "evidence": "…"}`.
 *
 * Note there is no third alternative: a populated field without a citation
 * cannot be generated at all.
 */
function leafExpr(emitter: Emitter, node: LeafNode): string {
  const nulls = literal('{"value":null,"evidence":null}');
  const open = literal('{"value":');
  const mid = literal(',"evidence":');
  const close = literal('}');
  return `${nulls} | ${open} ${valueExpr(emitter, node.value)} ${mid} ${useShared(emitter, 'json-string')} ${close}`;
}

function define(emitter: Emitter, name: string, expr: string): string {
  emitter.rules.set(name, expr);
  return name;
}

function emitNode(emitter: Emitter, node: AnyNode, path: string, name: string): string {
  switch (node.node) {
    case 'leaf':
      return define(emitter, name, leafExpr(emitter, node));
    case 'raw':
      // Provenance is stamped by the pipeline, never generated. Reaching here
      // would mean a `meta` field leaked into an extraction section.
      throw new Error(`provenance field ${path} cannot appear in a grammar`);
    case 'object': {
      const parts: string[] = [];
      let first = true;
      for (const [key, child] of Object.entries(node.fields)) {
        const childPath = path === '' ? key : `${path}.${key}`;
        const childName = emitNode(emitter, child, childPath, ruleName(childPath));
        parts.push(literal(`${first ? '{' : ','}${JSON.stringify(key)}:`), childName);
        first = false;
      }
      parts.push(literal('}'));
      return define(emitter, name, parts.join(' '));
    }
    case 'tuple': {
      const parts: string[] = [];
      node.items.forEach((_item, index) => {
        const childPath = `${path}[${index}]`;
        const childName = emitNode(emitter, node.of, childPath, ruleName(childPath));
        parts.push(literal(index === 0 ? '[' : ','), childName);
      });
      parts.push(literal(']'));
      return define(emitter, name, parts.join(' '));
    }
    case 'list': {
      const itemName = emitNode(emitter, node.of, `${path}[]`, `${name}-item`);
      // The empty array is the "nothing was said" case, so it must be legal.
      return define(
        emitter,
        name,
        `${literal('[')} ( ${itemName} ( ${literal(',')} ${itemName} )* )? ${literal(']')}`,
      );
    }
  }
}

/** Header stamped on every generated grammar. Carries no timestamp: see #3. */
export const GENERATED_HEADER = [
  '# GENERATED FILE - do not edit.',
  '# Source: src/schema/form-schema.ts (npm run schema:build).',
  '# Every field may be null; a non-null value requires non-empty evidence.',
].join('\n');

/** Emit the GBNF grammar for one section subtree. */
export function emitGbnf(node: AnyNode, path: string): string {
  const emitter: Emitter = { rules: new Map(), used: new Set() };
  emitNode(emitter, node, path, 'root');

  const lines: string[] = [GENERATED_HEADER, `# Section: ${path}`, ''];
  // `root` first: llama.cpp starts there, and so does a human reading this.
  const ordered = [...emitter.rules].sort(([a], [b]) =>
    a === 'root' ? -1 : b === 'root' ? 1 : 0,
  );
  for (const [name, expr] of ordered) lines.push(`${name} ::= ${expr}`);
  lines.push('');
  for (const name of Object.keys(SHARED)) {
    if (!emitter.used.has(name)) continue;
    const expr = SHARED[name];
    /* c8 ignore next */
    if (expr === undefined) continue;
    lines.push(`${name} ::= ${expr}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Parsing — so the generated grammars are verified, not trusted
// ---------------------------------------------------------------------------

export type GbnfTerm =
  | { readonly t: 'lit'; readonly value: string }
  | { readonly t: 'class'; readonly negated: boolean; readonly ranges: readonly (readonly [number, number])[] }
  | { readonly t: 'ref'; readonly name: string }
  | { readonly t: 'group'; readonly alternatives: readonly GbnfSeq[] }
  | { readonly t: 'repeat'; readonly term: GbnfTerm; readonly min: number; readonly max: number | null };

export type GbnfSeq = readonly GbnfTerm[];

export interface GbnfGrammar {
  readonly rules: ReadonlyMap<string, readonly GbnfSeq[]>;
  /** Rule names in file order. */
  readonly order: readonly string[];
}

const RULE_HEADER = /^([A-Za-z0-9_-]+)\s*::=/gm;

class Cursor {
  private index = 0;
  constructor(private readonly source: string) {}

  get done(): boolean {
    this.skipSpace();
    return this.index >= this.source.length;
  }

  skipSpace(): void {
    while (this.index < this.source.length) {
      const character = this.source[this.index] ?? '';
      if (character === '#') {
        while (this.index < this.source.length && this.source[this.index] !== '\n') this.index += 1;
        continue;
      }
      if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
        this.index += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skipSpace();
    return this.source[this.index] ?? '';
  }

  take(): string {
    this.skipSpace();
    const character = this.source[this.index] ?? '';
    this.index += 1;
    return character;
  }

  /** Raw peek, no whitespace skipping — inside literals, classes and names. */
  peekRaw(): string {
    return this.source[this.index] ?? '';
  }

  /** Raw read, no whitespace skipping — inside literals and classes. */
  raw(): string {
    const character = this.source[this.index] ?? '';
    this.index += 1;
    return character;
  }

  get atEnd(): boolean {
    return this.index >= this.source.length;
  }
}

/** Decode one GBNF escape (already past the backslash). */
function readEscape(cursor: Cursor): number {
  const character = cursor.raw();
  switch (character) {
    case 'n':
      return 0x0a;
    case 'r':
      return 0x0d;
    case 't':
      return 0x09;
    case 'x':
      return Number.parseInt(`${cursor.raw()}${cursor.raw()}`, 16);
    case 'u':
      return Number.parseInt(`${cursor.raw()}${cursor.raw()}${cursor.raw()}${cursor.raw()}`, 16);
    default:
      return character.codePointAt(0) ?? 0;
  }
}

function parseLiteral(cursor: Cursor): GbnfTerm {
  cursor.take(); // opening quote
  let value = '';
  for (;;) {
    if (cursor.atEnd) throw new Error('unterminated GBNF string literal');
    const character = cursor.raw();
    if (character === '"') break;
    value += character === '\\' ? String.fromCodePoint(readEscape(cursor)) : character;
  }
  return { t: 'lit', value };
}

function parseClass(cursor: Cursor): GbnfTerm {
  cursor.take(); // '['
  let negated = false;
  if (cursor.peek() === '^') {
    cursor.take();
    negated = true;
  }

  // Read the whole class body first; deciding what is a range and what is a
  // literal `-` is far easier once the members are in hand.
  const members: { code: number; dash: boolean }[] = [];
  for (;;) {
    if (cursor.atEnd) throw new Error('unterminated GBNF character class');
    const character = cursor.raw();
    if (character === ']') break;
    if (character === '\\') {
      members.push({ code: readEscape(cursor), dash: false });
      continue;
    }
    members.push({ code: character.codePointAt(0) ?? 0, dash: character === '-' });
  }

  const ranges: (readonly [number, number])[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    /* c8 ignore next */
    if (member === undefined) continue;
    const next = members[index + 1];
    const after = members[index + 2];
    if (next?.dash === true && after !== undefined) {
      ranges.push([member.code, after.code]);
      index += 2;
      continue;
    }
    ranges.push([member.code, member.code]);
  }
  return { t: 'class', negated, ranges };
}

function parseSequence(cursor: Cursor, insideGroup: boolean): GbnfSeq {
  const terms: GbnfTerm[] = [];
  for (;;) {
    const character = cursor.peek();
    if (character === '' || character === '|') return terms;
    if (character === ')') {
      if (!insideGroup) throw new Error('unbalanced ) in GBNF');
      return terms;
    }

    let term: GbnfTerm;
    if (character === '"') term = parseLiteral(cursor);
    else if (character === '[') term = parseClass(cursor);
    else if (character === '(') {
      cursor.take();
      const alternatives = parseAlternatives(cursor, true);
      if (cursor.take() !== ')') throw new Error('expected ) in GBNF');
      term = { t: 'group', alternatives };
    } else if (/[A-Za-z0-9_-]/.test(character)) {
      // Raw reads: a rule name ends at the first non-name character, and
      // whitespace separates two references rather than joining them.
      let name = '';
      while (!cursor.atEnd && /[A-Za-z0-9_-]/.test(cursor.peekRaw())) name += cursor.raw();
      term = { t: 'ref', name };
    } else {
      throw new Error(`unexpected character in GBNF: ${JSON.stringify(character)}`);
    }

    const suffix = cursor.peek();
    if (suffix === '*' || suffix === '+' || suffix === '?') {
      cursor.take();
      const min = suffix === '+' ? 1 : 0;
      const max = suffix === '?' ? 1 : null;
      term = { t: 'repeat', term, min, max };
    }
    terms.push(term);
  }
}

function parseAlternatives(cursor: Cursor, insideGroup: boolean): readonly GbnfSeq[] {
  const alternatives: GbnfSeq[] = [parseSequence(cursor, insideGroup)];
  while (cursor.peek() === '|') {
    cursor.take();
    alternatives.push(parseSequence(cursor, insideGroup));
  }
  return alternatives;
}

/** Parse a GBNF document. Throws on anything it cannot make sense of. */
export function parseGbnf(source: string): GbnfGrammar {
  const headers = [...source.matchAll(RULE_HEADER)];
  if (headers.length === 0) throw new Error('no rules in GBNF document');

  const rules = new Map<string, readonly GbnfSeq[]>();
  const order: string[] = [];

  headers.forEach((header, index) => {
    const name = header[1];
    /* c8 ignore next */
    if (name === undefined) throw new Error('malformed GBNF rule header');
    const start = (header.index ?? 0) + header[0].length;
    const end = index + 1 < headers.length ? (headers[index + 1]?.index ?? source.length) : source.length;
    const cursor = new Cursor(source.slice(start, end));
    const alternatives = parseAlternatives(cursor, false);
    if (!cursor.done) throw new Error(`trailing input in rule ${name}`);
    if (rules.has(name)) throw new Error(`duplicate GBNF rule ${name}`);
    rules.set(name, alternatives);
    order.push(name);
  });

  return { rules, order };
}

/** Structural problems with a grammar: undefined refs, unused rules, no root. */
export function validateGbnf(source: string): readonly string[] {
  const grammar = parseGbnf(source);
  const problems: string[] = [];
  if (!grammar.rules.has('root')) problems.push('missing `root` rule');

  const referenced = new Set<string>();
  const walk = (term: GbnfTerm): void => {
    switch (term.t) {
      case 'ref':
        referenced.add(term.name);
        return;
      case 'group':
        term.alternatives.forEach((sequence) => {
          sequence.forEach(walk);
        });
        return;
      case 'repeat':
        walk(term.term);
        return;
      default:
        return;
    }
  };
  for (const alternatives of grammar.rules.values()) {
    alternatives.forEach((sequence) => {
      sequence.forEach(walk);
    });
  }

  for (const name of referenced) {
    if (!grammar.rules.has(name)) problems.push(`undefined rule: ${name}`);
  }
  for (const name of grammar.order) {
    if (name !== 'root' && !referenced.has(name)) problems.push(`unused rule: ${name}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Matching — the generated grammars are non-recursive, so they expand to a
// regular expression, which is enough to assert what §6.4 cares about.
// ---------------------------------------------------------------------------

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classSource(term: Extract<GbnfTerm, { t: 'class' }>): string {
  const body = term.ranges
    .map(([low, high]) => {
      const one = (code: number): string => `\\u${code.toString(16).padStart(4, '0')}`;
      return low === high ? one(low) : `${one(low)}-${one(high)}`;
    })
    .join('');
  return `[${term.negated ? '^' : ''}${body}]`;
}

/**
 * Compile a grammar to an anchored regular expression.
 *
 * Throws on a recursive rule — the emitter never produces one, and a
 * recursive grammar is the one case this cannot model.
 */
export function gbnfToRegExp(source: string, root = 'root'): RegExp {
  const grammar = parseGbnf(source);
  const memo = new Map<string, string>();
  const visiting = new Set<string>();

  const sequenceSource = (sequence: GbnfSeq): string => sequence.map(termSource).join('');

  const alternativesSource = (alternatives: readonly GbnfSeq[]): string =>
    `(?:${alternatives.map(sequenceSource).join('|')})`;

  function termSource(term: GbnfTerm): string {
    switch (term.t) {
      case 'lit':
        return escapeForRegExp(term.value);
      case 'class':
        return classSource(term);
      case 'group':
        return alternativesSource(term.alternatives);
      case 'repeat': {
        const inner = termSource(term.term);
        if (term.min === 0 && term.max === null) return `(?:${inner})*`;
        if (term.min === 1 && term.max === null) return `(?:${inner})+`;
        return `(?:${inner})?`;
      }
      case 'ref':
        return ruleSource(term.name);
    }
  }

  function ruleSource(name: string): string {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    if (visiting.has(name)) throw new Error(`recursive GBNF rule: ${name}`);
    const alternatives = grammar.rules.get(name);
    if (alternatives === undefined) throw new Error(`undefined GBNF rule: ${name}`);
    visiting.add(name);
    const compiled = alternativesSource(alternatives);
    visiting.delete(name);
    memo.set(name, compiled);
    return compiled;
  }

  return new RegExp(`^${ruleSource(root)}$`, 'u');
}
