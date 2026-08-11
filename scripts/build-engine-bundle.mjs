/**
 * Bundles the engine into one CommonJS file for the proxy, and records what it
 * was built from.
 *
 * The signal generator runs inside euro-trade-proxy, which is plain CommonJS
 * Node with no build step. Rather than teach it TypeScript — a second toolchain
 * to keep alive in a service whose only job is to stay up — the engine is
 * compiled here and vendored there as one file.
 *
 * A vendored copy goes stale silently, so this writes a fingerprint of the
 * engine source to `packages/engine/bundle.lock.json` and stamps the same
 * fingerprint into the bundle's first lines. `test/bundle.test.ts` fails the
 * build when the source has moved on, and the proxy logs its stamp at boot so
 * you can tell from production which engine is actually running.
 *
 * Run: node scripts/build-engine-bundle.mjs [outDir]
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCK_PATH, STAMP_PREFIX, engineSourceHash } from './engine-source-hash.mjs';

const OUT_DIR = process.argv[2] ?? resolve('..', 'euro-trade-proxy');
const TMP = resolve('.engine.bundle.tmp.js');
const DEST = resolve(OUT_DIR, 'engine.bundle.js');

const sourceHash = engineSourceHash();

await build({
  entryPoints: ['packages/engine/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: TMP,
  // Not minified on purpose: when this misbehaves at 3am on a server with no
  // debugger, a readable stack trace is worth more than the kilobytes.
  minify: false,
  banner: {
    js:
      '// GENERATED — do not edit. Built from euro_trade_ts/packages/engine by\n' +
      '// scripts/build-engine-bundle.mjs. Edit the source there and rebuild.\n' +
      `${STAMP_PREFIX}${sourceHash}\n`,
  },
  // Exposed so the proxy can log which engine it loaded, and so the guard can
  // read the stamp back out of a committed copy.
  footer: {
    js: `\nmodule.exports.BUNDLE_SOURCE_HASH = ${JSON.stringify(sourceHash)};\n`,
  },
});

const bundle = readFileSync(TMP);
const bundleHash = createHash('sha256').update(bundle).digest('hex');

writeFileSync(
  LOCK_PATH,
  `${JSON.stringify(
    {
      _doc:
        'فحص إن engine.bundle.js في euro-trade-proxy لسه متوافق مع المحرك. ' +
        'مولَّد من scripts/build-engine-bundle.mjs — لا يُحرَّر يدويًا.',
      sourceHash,
      // Informational only. esbuild's output shifts between versions, so the
      // guard checks sourceHash — otherwise upgrading a dev dependency would
      // fail the build for a reason that has nothing to do with the engine.
      bundleHash,
      bundleBytes: bundle.length,
    },
    null,
    2,
  )}\n`,
);

if (existsSync(OUT_DIR)) {
  copyFileSync(TMP, DEST);
  console.log(`كُتب ${DEST} · ${(statSync(DEST).size / 1024).toFixed(0)} كيلوبايت`);
} else {
  // CI has no sibling checkout. The lock is still written, which is what the
  // guard reads — so a rebuild here is never a no-op.
  console.log(`${OUT_DIR} مش موجود — اتكتب القفل بس`);
}

unlinkSync(TMP);
console.log(`بصمة المحرك: ${sourceHash.slice(0, 16)}…`);
