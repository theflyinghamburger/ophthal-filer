import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { NotImplementedError } from '../src/cli/not-implemented.js';
import { VERBS, buildProgram } from '../src/cli/program.js';
import { createLogger, type LogEntry } from '../src/util/log.js';

function silentProgram(): { program: ReturnType<typeof buildProgram>; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const program = buildProgram({
    logger: createLogger({ level: 'debug', sink: (entry) => entries.push(entry) }),
  });
  const quieten = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    command.commands.forEach(quieten);
  };
  quieten(program);
  return { program, entries };
}

/** `parse` with the two leading argv entries commander expects. */
async function run(program: ReturnType<typeof buildProgram>, args: string[]): Promise<void> {
  await program.parseAsync(['node', 'ophtha-scribe', ...args]);
}

describe('ophtha-scribe --help', () => {
  it('lists every verb from the build plan', () => {
    const { program } = silentProgram();
    const names = program.commands.map((command) => command.name());

    expect(names).toEqual([
      'transcribe',
      'repair',
      'extract',
      'render',
      'run',
      'eval',
      'assets',
      'lexicon:suggest',
    ]);
  });

  it('shows each verb with a description in the help text', () => {
    const help = silentProgram().program.helpInformation();

    for (const verb of VERBS) {
      expect(help, `help mentions ${verb.name}`).toContain(verb.name);
    }
    expect(help).toContain('ophtha-scribe');
    expect(help).toContain('--log-level');
  });

  it('exposes `assets fetch` as a subcommand', () => {
    const { program } = silentProgram();
    const assets = program.commands.find((command) => command.name() === 'assets');
    expect(assets?.commands.map((command) => command.name())).toEqual(['fetch']);
  });

  it('keeps the VERBS table and the wired commands in sync', () => {
    const { program } = silentProgram();
    expect(program.commands.map((command) => command.name())).toEqual(
      VERBS.map((verb) => verb.name),
    );
  });
});

describe('every verb is a stub that fails loudly', () => {
  const invocations: readonly (readonly [string, string[]])[] = [
    ['transcribe', ['transcribe', 'a.wav', '-o', 'a.json']],
    ['repair', ['repair', 'a.json', '-o', 'b.json']],
    ['extract', ['extract', 'b.json', '-o', 'c.json']],
    ['render', ['render', 'c.json', '-o', 'c.pdf']],
    ['run', ['run', 'a.wav', '-o', 'c.pdf']],
    ['eval', ['eval', 'samples']],
    ['assets fetch', ['assets', 'fetch']],
    ['lexicon:suggest', ['lexicon:suggest']],
  ];

  for (const [verb, args] of invocations) {
    it(`${verb} throws NotImplementedError naming its issue`, async () => {
      const { program, entries } = silentProgram();

      await expect(run(program, args)).rejects.toThrow(NotImplementedError);
      await expect(run(program, args)).rejects.toThrow(/#\d+/);

      const logged = entries.filter((entry) => entry.event === 'cli.not_implemented');
      expect(logged.length).toBeGreaterThan(0);
      expect(logged[0]?.['verb']).toBe(verb.replace(' ', '.'));
    });
  }

  it('reports a non-zero exit code constant', async () => {
    const { program } = silentProgram();
    const error = await run(program, ['run', 'a.wav', '-o', 'c.pdf']).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(NotImplementedError);
    expect((error as NotImplementedError).issue).toBeGreaterThan(0);
  });
});

describe('argument validation happens before the stub', () => {
  it('rejects a missing required output path', async () => {
    const { program } = silentProgram();
    await expect(run(program, ['transcribe', 'a.wav'])).rejects.toThrow(/--out/);
  });

  it('rejects a missing required argument', async () => {
    const { program } = silentProgram();
    await expect(run(program, ['render', '-o', 'c.pdf'])).rejects.toThrow(/argument/i);
  });
});
