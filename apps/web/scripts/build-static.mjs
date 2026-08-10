/**
 * Static-export build for the Capacitor shell.
 *
 * A tiny wrapper instead of `cross-env` so the repo carries one less
 * dependency, and so the command works identically on Windows, macOS and CI.
 */

import { spawn } from 'node:child_process';

const child = spawn('next', ['build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, EURO_STATIC_EXPORT: '1' },
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
