import { describe, expect, it } from 'vitest';

import { LexiconError, loadLexicon, parseLexicon } from '../src/lexicon/load.js';
import { loadConfig } from '../src/util/config.js';
import { findRepoRoot } from '../src/util/paths.js';

const REPO_ROOT = findRepoRoot(process.cwd());
const config = loadConfig({}, REPO_ROOT);

/** A minimal well-formed term, cloned and broken in the failure cases. */
function term(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pseudophakia',
    term: 'pseudophakia',
    aliases: ['pseudophakic'],
    spoken: ['sudo fake ia'],
    gloss: 'Eye with an implanted intraocular lens.',
    sections: ['od.anterior.lensMedia'],
    boost: 2.5,
    ...overrides,
  };
}

describe('the checked-in lexicon', () => {
  it('parses and every term is well formed', () => {
    const lexicon = loadLexicon(config.lexiconPath);

    expect(lexicon.version).toBe(0);
    expect(lexicon.terms.length).toBeGreaterThan(0);
    for (const entry of lexicon.terms) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/);
      expect(entry.gloss.length).toBeGreaterThan(0);
      expect(entry.boost).toBeGreaterThan(0);
    }
  });

  it('includes the floor set of ubiquitous terms (§5.3)', () => {
    const ids = new Set(loadLexicon(config.lexiconPath).terms.map((entry) => entry.id));
    for (const id of ['od', 'os', 'ou', 'cd-ratio', 'wnl', 'iop']) {
      expect(ids, `floor term ${id}`).toContain(id);
    }
  });

  it('has unique ids', () => {
    const ids = loadLexicon(config.lexiconPath).terms.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parseLexicon', () => {
  it('accepts a well-formed lexicon', () => {
    const lexicon = parseLexicon({ version: 1, terms: [term()] });
    expect(lexicon.terms[0]?.term).toBe('pseudophakia');
  });

  it('names the offending term when a field is the wrong type', () => {
    expect(() => parseLexicon({ version: 1, terms: [term(), term({ boost: 'high' })] })).toThrow(
      /terms\[1\]\.boost/,
    );
    expect(() => parseLexicon({ version: 1, terms: [term({ aliases: 'pseudophakic' })] })).toThrow(
      /terms\[0\]\.aliases/,
    );
    expect(() => parseLexicon({ version: 1, terms: [term({ gloss: '' })] })).toThrow(
      /terms\[0\]\.gloss/,
    );
  });

  it('rejects duplicate ids, which would silently collapse the phonetic index', () => {
    expect(() => parseLexicon({ version: 1, terms: [term(), term()] })).toThrow(
      /duplicate term id: pseudophakia/,
    );
  });

  it('rejects a malformed root', () => {
    expect(() => parseLexicon([])).toThrow(LexiconError);
    expect(() => parseLexicon({ terms: [] })).toThrow(/version/);
    expect(() => parseLexicon({ version: 1 })).toThrow(/terms/);
  });
});

describe('loadLexicon', () => {
  it('reports a missing file as a LexiconError', () => {
    expect(() => loadLexicon(`${config.lexiconPath}.missing`)).toThrow(LexiconError);
  });
});
