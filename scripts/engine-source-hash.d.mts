/**
 * Types for engine-source-hash.mjs.
 *
 * The helper stays plain JavaScript because `build-engine-bundle.mjs` is run
 * with bare `node` and cannot import TypeScript. But `bundle.test.ts` imports
 * it too, and `tsc --noEmit` refuses an untyped module under
 * `noImplicitAny` — which failed the CI typecheck step immediately after the
 * test step it was meant to protect.
 *
 * Hand-written rather than generated: five exports that change about never.
 */

/** Absolute path to the repository root, derived from this file's location. */
export const REPO_ROOT: string;

/** Absolute path to `packages/engine/src`. */
export const ENGINE_SRC: string;

/** Absolute path to `packages/engine/bundle.lock.json`. */
export const LOCK_PATH: string;

/** The comment prefix the builder stamps into the bundle. */
export const STAMP_PREFIX: string;

/**
 * sha256 over every `.ts` file under the engine's src, path and content, with
 * line endings normalised. Throws with an explanatory message — not a bare
 * ENOENT — when the source directory is missing.
 */
export function engineSourceHash(): string;
