import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from `start` until a directory containing `package.json` is found.
 *
 * Used instead of a hard-coded path so the repo can live anywhere, on any
 * drive: there is deliberately no absolute path literal anywhere in this
 * codebase (ARCHITECTURE.md §9 Step 0 — nothing may escape the repo root).
 */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate a package.json above ${start}`);
    }
    dir = parent;
  }
}

/** Directory of the calling module, whether running from `src/` (tsx) or `dist/`. */
export function moduleDir(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}
