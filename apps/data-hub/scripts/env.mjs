/**
 * Reads `.env.local`, without a dependency and without overriding the shell.
 *
 * The environment wins over the file, deliberately. Someone who exports a
 * secret for one command is choosing not to leave it on disk, and a loader
 * that overwrote that choice would silently undo it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');

try {
  for (const line of readFileSync(FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    // Quotes are stripped so a pasted value that arrived wrapped in them still
    // works — a connection string that silently keeps its quotes fails with a
    // host-not-found that looks like a network problem.
    const value = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, '');
    if (value !== '' && process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // No .env.local. Everything may still come from the shell.
}
