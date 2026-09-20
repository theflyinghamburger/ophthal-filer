import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ENV_KEYS,
  assertConfigContained,
  configPaths,
  loadConfig,
} from '../src/util/config.js';
import { findRepoRoot, isInside } from '../src/util/paths.js';

const REPO_ROOT = findRepoRoot(process.cwd());

describe('findRepoRoot', () => {
  it('finds the directory holding package.json', () => {
    expect(existsSync(resolve(REPO_ROOT, 'package.json'))).toBe(true);
    expect(findRepoRoot(resolve(REPO_ROOT, 'src', 'util'))).toBe(REPO_ROOT);
  });
});

describe('isInside', () => {
  it('accepts a directory itself and its descendants', () => {
    expect(isInside(REPO_ROOT, REPO_ROOT)).toBe(true);
    expect(isInside(REPO_ROOT, resolve(REPO_ROOT, 'assets', 'models'))).toBe(true);
  });

  it('rejects siblings, parents and near-miss prefixes', () => {
    expect(isInside(REPO_ROOT, resolve(REPO_ROOT, '..'))).toBe(false);
    expect(isInside(REPO_ROOT, resolve(REPO_ROOT, '..', 'elsewhere'))).toBe(false);
    // `…/ophthal-filer` must not swallow `…/ophthal-filer-backup`.
    expect(isInside(REPO_ROOT, `${REPO_ROOT}-backup`)).toBe(false);
  });
});

describe('loadConfig', () => {
  it('derives every default from the repository root', () => {
    const config = loadConfig({}, REPO_ROOT);

    expect(config.repoRoot).toBe(REPO_ROOT);
    for (const [key, path] of configPaths(config)) {
      expect(isInside(REPO_ROOT, path), `${key} -> ${path}`).toBe(true);
    }
    expect(config.overridden).toEqual([]);
    expect(() => {
      assertConfigContained(config);
    }).not.toThrow();
  });

  it('places assets, lexicon, samples and gold where the architecture says', () => {
    const config = loadConfig({}, REPO_ROOT);

    expect(config.assetsDir).toBe(resolve(REPO_ROOT, 'assets'));
    expect(config.modelsDir).toBe(resolve(REPO_ROOT, 'assets', 'models'));
    expect(config.binDir).toBe(resolve(REPO_ROOT, 'assets', 'bin'));
    expect(config.formDir).toBe(resolve(REPO_ROOT, 'assets', 'form'));
    expect(config.lexiconPath).toBe(resolve(REPO_ROOT, 'lexicon', 'ophthalmology.json'));
    expect(config.samplesDir).toBe(resolve(REPO_ROOT, 'samples'));
    expect(config.goldDir).toBe(resolve(REPO_ROOT, 'eval', 'gold'));
  });

  it('contains no absolute system-drive literal', () => {
    // The Step 0 acceptance criterion: nothing lands outside the repo. A
    // default that names a drive root can only have come from a literal.
    const config = loadConfig({}, REPO_ROOT);
    for (const [key, path] of configPaths(config)) {
      expect(/^[A-Za-z]:\\(Users|Windows|Program|ProgramData)/i.test(path), key).toBe(false);
    }
  });

  it('binds the model endpoint to loopback by default', () => {
    expect(loadConfig({}, REPO_ROOT).llm.host).toBe('127.0.0.1');
    // 0 means "pick a free port per launch".
    expect(loadConfig({}, REPO_ROOT).llm.port).toBe(0);
  });

  it('lets the environment override any path, and records that it did', () => {
    const elsewhere = resolve(REPO_ROOT, '..', 'model-share');
    const config = loadConfig(
      {
        [ENV_KEYS.modelsDir]: elsewhere,
        [ENV_KEYS.llmPort]: '8123',
        [ENV_KEYS.logLevel]: 'DEBUG',
      },
      REPO_ROOT,
    );

    expect(config.modelsDir).toBe(elsewhere);
    // Children of an overridden directory follow it.
    expect(config.asr.modelDir.startsWith(elsewhere + sep)).toBe(true);
    expect(config.llm.port).toBe(8123);
    expect(config.logLevel).toBe('debug');
    expect(config.overridden).toContain('modelsDir');
    expect(config.overridden).toContain('llmPort');
  });

  it('ignores blank overrides and unknown log levels', () => {
    const config = loadConfig(
      { [ENV_KEYS.outDir]: '   ', [ENV_KEYS.logLevel]: 'chatty' },
      REPO_ROOT,
    );
    expect(config.outDir).toBe(resolve(REPO_ROOT, 'out'));
    expect(config.logLevel).toBe('info');
    expect(config.overridden).not.toContain('outDir');
  });
});

describe('assertConfigContained', () => {
  it('passes when an escape was an explicit environment override', () => {
    const config = loadConfig(
      { [ENV_KEYS.modelsDir]: resolve(REPO_ROOT, '..', 'model-share') },
      REPO_ROOT,
    );
    expect(() => {
      assertConfigContained(config);
    }).not.toThrow();
  });

  it('lets an overridden directory carry its derived paths with it', () => {
    // OPHTHA_MODELS_DIR legitimately drags the ASR model directory and the
    // GGUF path out of the repo; those are not independent escapes.
    const share = resolve(REPO_ROOT, '..', 'model-share');
    const config = loadConfig({ [ENV_KEYS.modelsDir]: share }, REPO_ROOT);

    expect(config.asr.modelDir.startsWith(share)).toBe(true);
    expect(config.overridden).not.toContain('asrModelDir');
    expect(() => {
      assertConfigContained(config);
    }).not.toThrow();
  });

  it('throws when a non-overridden path escaped the repository root', () => {
    const config = loadConfig({}, REPO_ROOT);
    const escaped = { ...config, outDir: resolve(REPO_ROOT, '..', 'out') };

    expect(() => {
      assertConfigContained(escaped);
    }).toThrow(/escaped the repository root \(outDir\)/);
  });
});
