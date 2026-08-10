/**
 * Static-export build for the Capacitor shell and for GitHub Pages.
 *
 * A wrapper instead of `cross-env` so the repo carries one less dependency and
 * the command behaves the same on Windows, macOS and CI.
 *
 * It resolves Next's entry point through Node's own module resolution rather
 * than spawning a bare `next` and hoping the shell can find it. In an npm
 * workspace the binary is hoisted to the ROOT `node_modules/.bin`, which is
 * only on PATH when npm itself launches the script — running
 * `node scripts/build-static.mjs` directly (as CI did) fails with
 * `sh: next: not found`.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let nextBin;
try {
  nextBin = require.resolve('next/dist/bin/next');
} catch {
  console.error('Could not resolve the "next" package. Run `npm install` first.');
  process.exit(1);
}

// No `shell: true` — the binary is invoked through Node directly, so there is
// no shell to mis-resolve it and no quoting to get wrong.
const child = spawn(process.execPath, [nextBin, 'build'], {
  stdio: 'inherit',
  env: { ...process.env, EURO_STATIC_EXPORT: '1' },
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});

child.on('error', (err) => {
  console.error('Failed to start the build:', err.message);
  process.exit(1);
});
