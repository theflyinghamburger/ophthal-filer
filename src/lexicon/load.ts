import { readFileSync } from 'node:fs';

import type { Lexicon, LexiconTerm } from './types.js';

/**
 * Parse and shape-check the lexicon.
 *
 * Hand-written rather than zod: the lexicon is the one artefact edited by a
 * human in a text editor, so failures need to name the offending term. The
 * generated artefacts (hotwords, phonetic index, GBNF) land in TODO(#2).
 */

export class LexiconError extends Error {
  override readonly name = 'LexiconError';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseTerm(raw: unknown, index: number): LexiconTerm {
  const where = `terms[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LexiconError(`${where} is not an object`);
  }
  const term = raw as Record<string, unknown>;

  for (const key of ['id', 'term', 'gloss'] as const) {
    if (typeof term[key] !== 'string' || term[key].length === 0) {
      throw new LexiconError(`${where}.${key} must be a non-empty string`);
    }
  }
  for (const key of ['aliases', 'spoken', 'sections'] as const) {
    if (!isStringArray(term[key])) {
      throw new LexiconError(`${where}.${key} must be an array of strings`);
    }
  }
  if (typeof term['boost'] !== 'number' || !Number.isFinite(term['boost'])) {
    throw new LexiconError(`${where}.boost must be a finite number`);
  }

  return {
    id: term['id'] as string,
    term: term['term'] as string,
    aliases: term['aliases'] as string[],
    spoken: term['spoken'] as string[],
    gloss: term['gloss'] as string,
    sections: term['sections'] as string[],
    boost: term['boost'],
  };
}

export function parseLexicon(raw: unknown): Lexicon {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LexiconError('lexicon root is not an object');
  }
  const root = raw as Record<string, unknown>;

  if (typeof root['version'] !== 'number' || !Number.isInteger(root['version'])) {
    throw new LexiconError('lexicon.version must be an integer');
  }
  if (!Array.isArray(root['terms'])) {
    throw new LexiconError('lexicon.terms must be an array');
  }

  const terms = root['terms'].map(parseTerm);

  const seen = new Set<string>();
  for (const term of terms) {
    if (seen.has(term.id)) throw new LexiconError(`duplicate term id: ${term.id}`);
    seen.add(term.id);
  }

  return { version: root['version'], terms };
}

export function loadLexicon(path: string): Lexicon {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new LexiconError(`lexicon not found at ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LexiconError(`lexicon at ${path} is not valid JSON`);
  }
  return parseLexicon(json);
}
