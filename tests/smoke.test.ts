import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { VERBS } from '../src/cli/program.js';
import { findRepoRoot } from '../src/util/paths.js';
import { appVersion } from '../src/util/version.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = findRepoRoot(process.cwd());
const BIN = resolve(REPO_ROOT, 'bin', 'ophtha-scribe.mjs');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the real launcher end to end, exactly as `npx ophtha-scribe` would. */
async function cli(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, OPHTHA_LOG_LEVEL: 'silent' },
    });
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('ophtha-scribe binary', () => {
  it('prints help listing every verb and exits 0', async () => {
    const { code, stdout } = await cli(['--help']);

    expect(code).toBe(0);
    for (const verb of VERBS) {
      expect(stdout, `help lists ${verb.name}`).toContain(verb.name);
    }
  }, 30_000);

  it('reports the package version', async () => {
    const { code, stdout } = await cli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(appVersion(REPO_ROOT));
  }, 30_000);

  it('exits non-zero with "not implemented" for a stubbed verb', async () => {
    const { code, stderr } = await cli(['transcribe', 'samples/case-01.wav', '-o', 'out/x.json']);

    expect(code).not.toBe(0);
    expect(stderr).toContain('not implemented');
    expect(stderr).toMatch(/#\d+/);
    // Never a stack trace: one containing a transcript is a breach (§7).
    expect(stderr).not.toContain('at ');
  }, 30_000);

  it('exits non-zero for an unknown verb', async () => {
    const { code } = await cli(['diagnose']);
    expect(code).not.toBe(0);
  }, 30_000);
});

describe('repository hygiene', () => {
  it('gitignores the PHI directories', () => {
    const gitignore = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8');
    for (const entry of ['samples/', 'eval/gold/', 'out/', 'logs/']) {
      expect(gitignore, `.gitignore covers ${entry}`).toContain(entry);
    }
  });

  it('declares the ophtha-scribe bin entry', () => {
    const pkg: unknown = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    const bin = (pkg as { bin?: Record<string, string> }).bin;
    expect(bin?.['ophtha-scribe']).toBe('bin/ophtha-scribe.mjs');
  });
});
