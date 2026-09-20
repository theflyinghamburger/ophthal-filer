import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { findRepoRoot, moduleDir } from './paths.js';

/**
 * Application version, read from `package.json` at runtime.
 *
 * Stamped into the PDF provenance footer and into `EncounterMeta.appVersion`,
 * so a draft can always be traced back to the code that produced it (§3.4).
 */
export function appVersion(startDir?: string): string {
  const root = findRepoRoot(startDir ?? moduleDir(import.meta.url));
  const raw: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (typeof raw === 'object' && raw !== null) {
    const version: unknown = (raw as { version?: unknown }).version;
    if (typeof version === 'string') return version;
  }
  return '0.0.0';
}
