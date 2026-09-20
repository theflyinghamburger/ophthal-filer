import type { Logger } from '../util/log.js';

/**
 * Every verb is wired but unimplemented at Step 0. Each one fails loudly with
 * the issue that will implement it, so a half-built pipeline can never be
 * mistaken for a working one.
 */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  /** CLI verb, e.g. `transcribe` or `assets fetch`. */
  readonly verb: string;
  /** GitHub issue number that implements it. */
  readonly issue: number;

  constructor(verb: string, issue: number) {
    super(`not implemented: \`${verb}\` lands in #${issue}`);
    this.verb = verb;
    this.issue = issue;
  }
}

/** Exit code used for every unimplemented verb. */
export const EXIT_NOT_IMPLEMENTED = 1;

/**
 * Throw {@link NotImplementedError}, logging the attempt first.
 *
 * The verb name is an allowlisted token, so this log line carries no input.
 */
export function notImplemented(logger: Logger, verb: string, issue: number): never {
  logger.warn('cli.not_implemented', { verb: verb.replace(/[^A-Za-z0-9:_-]/g, '.'), code: issue });
  throw new NotImplementedError(verb, issue);
}
