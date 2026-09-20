#!/usr/bin/env node
/**
 * `ophtha-scribe` launcher.
 *
 * Prefers the compiled `dist/` build. Falls back to running the TypeScript
 * sources through tsx, so the CLI works in a fresh checkout before anyone has
 * run `npm run build`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = new URL('../dist/cli/index.js', import.meta.url);

if (existsSync(fileURLToPath(dist))) {
  await import(dist.href);
} else {
  try {
    const { register } = await import('tsx/esm/api');
    register();
  } catch {
    process.stderr.write(
      'ophtha-scribe: no build found and tsx is unavailable.\n' +
        'Run `npm install && npm run build`, or `npm run cli -- --help` for dev.\n',
    );
    process.exit(1);
  }
  await import(new URL('../src/cli/index.ts', import.meta.url).href);
}
