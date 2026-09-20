import { Command, Option } from 'commander';

import { LOG_LEVELS, type LogLevel, getConfig } from '../util/config.js';
import { createLogger, type Logger } from '../util/log.js';
import { appVersion } from '../util/version.js';
import { notImplemented } from './not-implemented.js';

/**
 * The headless CLI (ARCHITECTURE.md §9).
 *
 * ```
 * ophtha-scribe transcribe samples/case-01.wav          -o out/case-01.transcript.json
 * ophtha-scribe repair     out/case-01.transcript.json  -o out/case-01.repaired.json
 * ophtha-scribe extract    out/case-01.repaired.json    -o out/case-01.draft.json
 * ophtha-scribe render     out/case-01.draft.json       -o out/case-01.pdf
 * ophtha-scribe run        samples/case-01.wav          -o out/case-01.pdf
 * ophtha-scribe eval       samples/                     --report eval/report.html
 * ```
 *
 * Every stage reads and writes JSON, so any stage can be re-run in isolation
 * and every intermediate is inspectable.
 *
 * At Step 0 every verb is a stub that exits non-zero. The wiring exists so
 * later issues have a named place to land, and so nobody mistakes a
 * half-finished pipeline for a working one.
 */

/** A verb, the issue that implements it, and its shape. */
export interface VerbSpec {
  readonly name: string;
  readonly issue: number;
  readonly summary: string;
}

/** Declared here so tests and `--help` cannot drift apart. */
export const VERBS = [
  { name: 'transcribe', issue: 9, summary: 'audio -> Transcript JSON (sherpa-onnx + Parakeet, CPU)' },
  { name: 'repair', issue: 12, summary: 'Transcript -> Transcript + anchored repair edits (Pass A)' },
  { name: 'extract', issue: 15, summary: 'Transcript -> EncounterDraft (Pass B, six sectioned calls)' },
  { name: 'render', issue: 17, summary: 'EncounterDraft -> filled AcroForm PDF' },
  { name: 'run', issue: 18, summary: 'audio -> filled PDF (the whole pipeline)' },
  { name: 'eval', issue: 6, summary: 'score a sample directory against the gold labels' },
  { name: 'assets', issue: 7, summary: 'fetch and verify models and binaries' },
  { name: 'lexicon:suggest', issue: 19, summary: 'propose new spoken aliases from logged corrections' },
] as const satisfies readonly VerbSpec[];

export type VerbName = (typeof VERBS)[number]['name'];

function issueFor(name: VerbName): number {
  const spec = VERBS.find((verb) => verb.name === name);
  /* c8 ignore next */
  if (spec === undefined) throw new Error(`unknown verb: ${name}`);
  return spec.issue;
}

export interface BuildProgramOptions {
  /** Injected in tests so log output can be asserted on. */
  readonly logger?: Logger;
}

export function buildProgram(options: BuildProgramOptions = {}): Command {
  const program = new Command();

  // Resolved lazily inside actions so `--log-level` is honoured and so
  // `--help` never has to touch the filesystem.
  let logger: Logger | undefined = options.logger;
  const log = (): Logger => {
    if (logger === undefined) {
      const level = program.opts<{ logLevel?: LogLevel }>().logLevel ?? getConfig().logLevel;
      logger = createLogger({ level });
    }
    return logger;
  };

  program
    .name('ophtha-scribe')
    .description(
      'Ophthalmic dictation -> structured chart. Local-first, offline.\n' +
        'Output is an AI-assisted draft; a physician reviews and signs it.',
    )
    .version(appVersion(), '-V, --version')
    .addOption(
      new Option('--log-level <level>', 'structured log verbosity (stderr, NDJSON)').choices([
        ...LOG_LEVELS,
      ]),
    )
    .showHelpAfterError();

  program
    .command('transcribe')
    .description(VERBS[0].summary)
    .argument('<audio>', 'input audio file (wav/m4a/mp3)')
    .requiredOption('-o, --out <file>', 'output Transcript JSON')
    .action(() => notImplemented(log(), 'transcribe', issueFor('transcribe')));

  program
    .command('repair')
    .description(VERBS[1].summary)
    .argument('<transcript>', 'Transcript JSON from `transcribe`')
    .requiredOption('-o, --out <file>', 'output Transcript JSON with repair edits')
    .option('--no-diff', 'suppress the coloured edit diff')
    .action(() => notImplemented(log(), 'repair', issueFor('repair')));

  program
    .command('extract')
    .description(VERBS[2].summary)
    .argument('<transcript>', 'repaired Transcript JSON')
    .requiredOption('-o, --out <file>', 'output EncounterDraft JSON')
    .action(() => notImplemented(log(), 'extract', issueFor('extract')));

  program
    .command('render')
    .description(VERBS[3].summary)
    .argument('<draft>', 'EncounterDraft JSON')
    .requiredOption('-o, --out <file>', 'output PDF')
    .option('--flatten', 'flatten form fields (do this only on sign)', false)
    .action(() => notImplemented(log(), 'render', issueFor('render')));

  program
    .command('run')
    .description(VERBS[4].summary)
    .argument('<audio>', 'input audio file')
    .requiredOption('-o, --out <file>', 'output PDF')
    .action(() => notImplemented(log(), 'run', issueFor('run')));

  program
    .command('eval')
    .description(VERBS[5].summary)
    .argument('<samples>', 'directory of sample audio with gold labels')
    .option('--report <file>', 'write an HTML report')
    .action(() => notImplemented(log(), 'eval', issueFor('eval')));

  const assets = program.command('assets').description(VERBS[6].summary);
  assets
    .command('fetch')
    .description('download models and binaries into assets/, verifying SHA-256')
    .option('--only <component>', 'asr | llm | ffmpeg')
    .action(() => notImplemented(log(), 'assets fetch', issueFor('assets')));

  program
    .command('lexicon:suggest')
    .description(VERBS[7].summary)
    .option('--corrections <file>', 'learning-loop JSONL (defaults to logs/corrections.jsonl)')
    .option('-o, --out <file>', 'write suggested lexicon patch')
    .action(() => notImplemented(log(), 'lexicon:suggest', issueFor('lexicon:suggest')));

  return program;
}
