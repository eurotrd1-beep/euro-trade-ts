/**
 * Bundles the engine into one CommonJS file for the proxy.
 *
 * The signal generator runs inside euro-trade-proxy, which is plain CommonJS
 * Node with no build step and no TypeScript. Rather than teach it to compile
 * TypeScript — a second toolchain to keep alive in a service whose only job is
 * to stay up — the engine is compiled here and vendored there as one file.
 *
 * That makes the dependency explicit and one-directional: the proxy never
 * imports from this repo, it carries a build of it. Re-run this after any
 * engine change, or the generator keeps scoring with the old rules.
 *
 * Run: node scripts/build-engine-bundle.mjs [outDir]
 */

import { build } from 'esbuild';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT_DIR = process.argv[2] ?? resolve('..', 'euro-trade-proxy');
const TMP = resolve('.engine.bundle.tmp.js');
const DEST = resolve(OUT_DIR, 'engine.bundle.js');

if (!existsSync(OUT_DIR)) {
  console.error(`مش موجود: ${OUT_DIR}`);
  process.exit(1);
}

await build({
  entryPoints: ['packages/engine/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: TMP,
  // Not minified on purpose: when this thing misbehaves at 3am on a server with
  // no debugger, a readable stack trace is worth more than the kilobytes.
  minify: false,
  banner: {
    js:
      '// GENERATED — do not edit. Built from euro_trade_ts/packages/engine by\n' +
      '// scripts/build-engine-bundle.mjs. Edit the source there and rebuild.\n',
  },
});

copyFileSync(TMP, DEST);
console.log(`كُتب ${DEST} · ${(statSync(DEST).size / 1024).toFixed(0)} كيلوبايت`);
