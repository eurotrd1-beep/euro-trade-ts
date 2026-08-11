/**
 * A stable fingerprint of the engine's source.
 *
 * Shared by the bundle builder and the test that guards it, so the two can
 * never disagree about what "the engine changed" means.
 *
 * Two details matter more than they look:
 *
 *   LINE ENDINGS ARE NORMALISED. This repo is developed on Windows and built on
 *   Linux, and git rewrites CRLF on checkout. Hashing raw bytes would make the
 *   fingerprint differ between the developer's machine and CI — the guard would
 *   fail on every run and get switched off within a week.
 *
 *   THE PATH IS HASHED WITH THE CONTENT. Otherwise renaming a file, or moving
 *   an indicator between two files without editing it, leaves the fingerprint
 *   unchanged — and a rename is exactly the kind of change that breaks a
 *   vendored copy.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = 'packages/engine/src';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** sha256 over every .ts file under the engine's src, path and content. */
export function engineSourceHash(root = '.') {
  const base = join(root, SRC);
  const hash = createHash('sha256');
  for (const file of walk(base)) {
    // Forward slashes so the fingerprint is identical on Windows and Linux.
    const rel = relative(base, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    hash.update(rel);
    hash.update('\0');
    hash.update(text);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Where the expected fingerprint is recorded. */
export const LOCK_PATH = 'packages/engine/bundle.lock.json';

/** The line the builder stamps into the bundle, so a copy can be identified. */
export const STAMP_PREFIX = '// engine-source-sha256: ';
