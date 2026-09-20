import { CommanderError } from 'commander';

import { assertConfigContained, getConfig } from '../util/config.js';
import { EXIT_NOT_IMPLEMENTED, NotImplementedError } from './not-implemented.js';
import { buildProgram } from './program.js';

/**
 * CLI entry point.
 *
 * Errors are reported to **stderr** as plain text for the human, and never
 * with a stack trace: a stack trace containing a transcript is a breach (§7).
 */
export async function main(argv: readonly string[] = process.argv): Promise<number> {
  try {
    assertConfigContained(getConfig());
    await buildProgram().parseAsync([...argv]);
    return 0;
  } catch (error: unknown) {
    if (error instanceof NotImplementedError) {
      process.stderr.write(`ophtha-scribe: ${error.message}\n`);
      return EXIT_NOT_IMPLEMENTED;
    }
    if (error instanceof CommanderError) {
      // commander has already written its own help/error output.
      return error.exitCode;
    }
    const name = error instanceof Error ? error.name : 'Error';
    process.stderr.write(`ophtha-scribe: ${name}\n`);
    return 1;
  }
}

process.exitCode = await main();
