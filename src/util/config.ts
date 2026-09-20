import { resolve } from 'node:path';

import { findRepoRoot, isInside, moduleDir } from './paths.js';

/**
 * Central path/runtime configuration.
 *
 * Two rules, both from ARCHITECTURE.md §7 and the Step 0 acceptance criteria:
 *
 *   1. Every default is derived from the repository root. There is no absolute
 *      path literal in this file, so nothing can land on the system drive by
 *      accident — models, binaries, logs and output all stay beside the repo.
 *   2. Every entry is overridable by an `OPHTHA_*` environment variable, so a
 *      deployment can point at a shared model directory without a code change.
 *
 * `assertConfigContained` re-checks rule 1 at runtime for the paths that were
 * NOT explicitly overridden.
 */

/** Environment variable names recognised by {@link loadConfig}. */
export const ENV_KEYS = {
  repoRoot: 'OPHTHA_REPO_ROOT',
  assetsDir: 'OPHTHA_ASSETS_DIR',
  modelsDir: 'OPHTHA_MODELS_DIR',
  binDir: 'OPHTHA_BIN_DIR',
  formDir: 'OPHTHA_FORM_DIR',
  buildDir: 'OPHTHA_BUILD_DIR',
  lexiconPath: 'OPHTHA_LEXICON',
  samplesDir: 'OPHTHA_SAMPLES_DIR',
  goldDir: 'OPHTHA_GOLD_DIR',
  outDir: 'OPHTHA_OUT_DIR',
  logDir: 'OPHTHA_LOG_DIR',
  asrModelDir: 'OPHTHA_ASR_MODEL_DIR',
  llmModelPath: 'OPHTHA_LLM_MODEL',
  llmServerBin: 'OPHTHA_LLM_SERVER_BIN',
  llmHost: 'OPHTHA_LLM_HOST',
  llmPort: 'OPHTHA_LLM_PORT',
  logLevel: 'OPHTHA_LOG_LEVEL',
} as const satisfies Record<string, string>;

export type ConfigKey = keyof typeof ENV_KEYS;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AsrConfig {
  /** Directory holding the sherpa-onnx Parakeet model files. */
  readonly modelDir: string;
  /** Generated from the lexicon. TODO(#2): written by the hotwords codegen. */
  readonly hotwordsFile: string;
}

export interface LlmConfig {
  /** `llama-server` executable, fetched into `assets/bin/`. */
  readonly serverBin: string;
  /** GGUF weights, fetched into `assets/models/`. */
  readonly modelPath: string;
  /** Always loopback — the model endpoint never leaves the machine (§7). */
  readonly host: string;
  /** `0` means "pick a free port per launch" (ARCHITECTURE.md §3.3). */
  readonly port: number;
}

export interface Config {
  readonly repoRoot: string;
  readonly assetsDir: string;
  readonly modelsDir: string;
  readonly binDir: string;
  readonly formDir: string;
  /** Generated artefacts (hotwords, phonetic index, grammars). Gitignored. */
  readonly buildDir: string;
  readonly lexiconPath: string;
  /** PHI. Gitignored. */
  readonly samplesDir: string;
  /** PHI. Gitignored. */
  readonly goldDir: string;
  readonly outDir: string;
  readonly logDir: string;
  readonly asr: AsrConfig;
  readonly llm: LlmConfig;
  readonly logLevel: LogLevel;
  /** Config keys whose value came from the environment rather than a default. */
  readonly overridden: readonly ConfigKey[];
}

export type Env = Readonly<Partial<Record<string, string>>>;

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Build the configuration. Pure: everything it reads comes from `env` and
 * `startDir`, which is what makes it testable without touching the process.
 */
export function loadConfig(env: Env = process.env, startDir?: string): Config {
  const overridden: ConfigKey[] = [];

  const fromEnv = (key: ConfigKey): string | undefined => {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    overridden.push(key);
    return trimmed;
  };

  /** Environment override if present, otherwise `resolve(base, ...fallback)`. */
  const pick = (key: ConfigKey, base: string, ...fallback: string[]): string => {
    const override = fromEnv(key);
    return override === undefined ? resolve(base, ...fallback) : resolve(override);
  };

  const repoRoot = pick('repoRoot', findRepoRoot(startDir ?? moduleDir(import.meta.url)));

  const assetsDir = pick('assetsDir', repoRoot, 'assets');
  const modelsDir = pick('modelsDir', assetsDir, 'models');
  const binDir = pick('binDir', assetsDir, 'bin');
  const formDir = pick('formDir', assetsDir, 'form');
  const buildDir = pick('buildDir', repoRoot, 'build');
  const lexiconPath = pick('lexiconPath', repoRoot, 'lexicon', 'ophthalmology.json');
  const samplesDir = pick('samplesDir', repoRoot, 'samples');
  const goldDir = pick('goldDir', repoRoot, 'eval', 'gold');
  const outDir = pick('outDir', repoRoot, 'out');
  const logDir = pick('logDir', repoRoot, 'logs');

  const asr: AsrConfig = {
    modelDir: pick('asrModelDir', modelsDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'),
    hotwordsFile: resolve(buildDir, 'hotwords.txt'),
  };

  const exe = process.platform === 'win32' ? '.exe' : '';
  const llm: LlmConfig = {
    serverBin: pick('llmServerBin', binDir, `llama-server${exe}`),
    modelPath: pick('llmModelPath', modelsDir, 'qwen3-8b-q4_k_m.gguf'),
    host: fromEnv('llmHost') ?? '127.0.0.1',
    port: Number.parseInt(fromEnv('llmPort') ?? '0', 10) || 0,
  };

  const levelRaw = fromEnv('logLevel')?.toLowerCase();
  const logLevel: LogLevel = levelRaw !== undefined && isLogLevel(levelRaw) ? levelRaw : 'info';

  return {
    repoRoot,
    assetsDir,
    modelsDir,
    binDir,
    formDir,
    buildDir,
    lexiconPath,
    samplesDir,
    goldDir,
    outDir,
    logDir,
    asr,
    llm,
    logLevel,
    overridden,
  };
}

/** Every filesystem path in the config, paired with the key that produced it. */
export function configPaths(config: Config): readonly (readonly [ConfigKey, string])[] {
  return [
    ['assetsDir', config.assetsDir],
    ['modelsDir', config.modelsDir],
    ['binDir', config.binDir],
    ['formDir', config.formDir],
    ['buildDir', config.buildDir],
    ['lexiconPath', config.lexiconPath],
    ['samplesDir', config.samplesDir],
    ['goldDir', config.goldDir],
    ['outDir', config.outDir],
    ['logDir', config.logDir],
    ['asrModelDir', config.asr.modelDir],
    ['llmServerBin', config.llm.serverBin],
    ['llmModelPath', config.llm.modelPath],
  ];
}

/**
 * Throw if any non-overridden path escaped the repository root.
 *
 * This is the guard behind "nothing is written outside the repo": a default can
 * only ever be repo-relative, so an escape means an absolute literal crept in.
 * Explicit `OPHTHA_*` overrides are exempt — pointing at a shared model
 * directory is a deliberate, visible act.
 */
export function assertConfigContained(config: Config): void {
  const overridden = new Set<ConfigKey>(config.overridden);
  const paths = configPaths(config);

  // A default may live under the repo root, or under a directory the operator
  // explicitly redirected — `OPHTHA_MODELS_DIR` legitimately drags the ASR
  // model directory and the GGUF path along with it.
  const allowedRoots = [
    config.repoRoot,
    ...paths.filter(([key]) => overridden.has(key)).map(([, path]) => path),
  ];

  const escaped = paths
    .filter(
      ([key, path]) =>
        !overridden.has(key) && !allowedRoots.some((root) => isInside(root, path)),
    )
    .map(([key]) => key);

  if (escaped.length > 0) {
    throw new Error(
      `config paths escaped the repository root (${escaped.join(', ')}); ` +
        'defaults must be repo-relative',
    );
  }
}

let cached: Config | undefined;

/** Process-wide config, built once. Tests should call {@link loadConfig} instead. */
export function getConfig(): Config {
  if (cached === undefined) {
    const config = loadConfig();
    assertConfigContained(config);
    cached = config;
  }
  return cached;
}

/** Test seam: forget the memoized config. */
export function resetConfigCache(): void {
  cached = undefined;
}
