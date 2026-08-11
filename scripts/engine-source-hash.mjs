/**
 * A stable fingerprint of the engine's source.
 *
 * Shared by the bundle builder and the test that guards it, so the two can
 * never disagree about what "the engine changed" means.
 *
 * ── PATHS ARE ABSOLUTE, DERIVED FROM THIS FILE ─────────────────────────────
 *
 * The first version resolved `packages/engine/src` against the process's
 * working directory. That works when the whole repo is the cwd and fails
 * everywhere else — CI runs the suite as `npm --workspace @euro/engine run
 * test`, whose cwd is `packages/engine`, so the path became
 * `packages/engine/packages/engine/src` and the guard took the deploy down with
 * an ENOENT. A check that exists to prevent a mistake must not be able to cause
 * a worse one.
 *
 * Every other test in this package already resolved its fixtures from
 * `import.meta.url`. This now does the same, and nothing here reads the cwd.
 *
 * ── TWO DETAILS THAT MATTER MORE THAN THEY LOOK ────────────────────────────
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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This file lives at <repo>/scripts/, so the repo root is one level up. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ENGINE_SRC = join(REPO_ROOT, 'packages', 'engine', 'src');

/** Where the expected fingerprint is recorded. */
export const LOCK_PATH = join(REPO_ROOT, 'packages', 'engine', 'bundle.lock.json');

/** The line the builder stamps into the bundle, so a copy can be identified. */
export const STAMP_PREFIX = '// engine-source-sha256: ';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** sha256 over every .ts file under the engine's src, path and content. */
export function engineSourceHash() {
  if (!existsSync(ENGINE_SRC)) {
    // Say which path was tried and where it came from. A bare ENOENT sent
    // someone hunting through CI logs for a cwd that was never the problem.
    throw new Error(
      `مصدر المحرك مش موجود: ${ENGINE_SRC}\n` +
        `(اتحسب من موقع scripts/engine-source-hash.mjs — يعني نسخة الريبو ناقصة، ` +
        `مش مشكلة مجلد تشغيل)`,
    );
  }

  const hash = createHash('sha256');
  for (const file of walk(ENGINE_SRC)) {
    // Forward slashes so the fingerprint is identical on Windows and Linux.
    const rel = relative(ENGINE_SRC, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    hash.update(rel);
    hash.update('\0');
    hash.update(text);
    hash.update('\0');
  }
  return hash.digest('hex');
}
