#!/usr/bin/env node
/**
 * Probes the hub the way the app does, and records every failure.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE HEALTH SCREEN ────────────────────────────
 *
 * `hubStats` counts what one browser saw, in one session, since it last
 * loaded. It is the right number for "is this user having a bad time" and the
 * wrong one for "is mirror mode safe to leave" — nobody is watching at 04:00,
 * and a reload resets it.
 *
 * So this runs the app's exact read set on a timer and writes a line per
 * round. A failure here is a fallback the app WOULD have made, recorded with a
 * timestamp, whether or not anyone had the screen open.
 *
 *   node scripts/watch-mirror.mjs                  every 15 minutes, forever
 *   node scripts/watch-mirror.mjs --every 60       every 60 seconds
 *   node scripts/watch-mirror.mjs --once           one round and exit
 *
 * Output goes to out/mirror-watch.log, appended, one line per round.
 */

import './env.mjs';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'out');
const LOG = join(OUT, 'mirror-watch.log');

const HUB = (process.env['DATA_HUB_URL'] ?? '').replace(/\/+$/, '');
if (!HUB) {
  console.error('Set DATA_HUB_URL.');
  process.exit(1);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const EVERY_S = arg('--every', 900);
const ONCE = process.argv.includes('--once');

/**
 * Exactly what the app asks for on boot, in the same shapes.
 *
 * An account id is needed for the owner-scoped two: without it the hub
 * refuses them, which is correct and would make this probe report a failure
 * that is really the rule working.
 */
const ACCOUNT = process.env['PROBE_ACCOUNT_ID'] ?? '';
/**
 * `mustHaveRows` is the third field, and it is not pedantry.
 *
 * For a config row, empty IS the failure — it is the shape that makes a
 * default look like an answer, which is how this app once ran the SIMULATOR
 * for the length of a round trip because `price_system` had not arrived.
 *
 * For an owner-scoped row it is not a failure at all: an account with no
 * trades has no history row, and most do not. Flagging that would fill the log
 * with noise and train whoever reads it to ignore the column that matters.
 */
const READS = [
  ['configs/maintenance', '/v1/configs?cols=data&eq=id:maintenance&limit=1', true],
  ['configs/chart_settings', '/v1/configs?cols=data&eq=id:chart_settings&limit=1', true],
  ['configs/price_system', '/v1/configs?cols=data&eq=id:price_system&limit=1', true],
  ['configs/display_source', '/v1/configs?cols=data&eq=id:display_source&limit=1', true],
  ['configs/social', '/v1/configs?cols=data&eq=id:social&limit=1', true],
  ['pairs', '/v1/pairs?order=order.asc', true],
  ...(ACCOUNT ? [
    ['users/own', `/v1/users?eq=id:${ACCOUNT}&limit=1`, true],
    ['signal_history/own', `/v1/signal_history?cols=signals&eq=account_id:${ACCOUNT}&limit=1`, false],
  ] : []),
];

async function round() {
  const failures = [];
  let slowest = 0;

  for (const [label, path, mustHaveRows] of READS) {
    const started = Date.now();
    try {
      const headers = ACCOUNT ? { 'x-account-id': ACCOUNT } : {};
      const res = await fetch(HUB + path, { headers, signal: AbortSignal.timeout(15_000) });
      const ms = Date.now() - started;
      slowest = Math.max(slowest, ms);
      if (!res.ok) {
        failures.push(`${label}:${res.status}`);
        continue;
      }
      const body = await res.json();
      if (!Array.isArray(body.rows)) failures.push(`${label}:shape`);
      else if (body.rows.length === 0 && mustHaveRows) failures.push(`${label}:empty`);
    } catch (e) {
      failures.push(`${label}:${e instanceof Error ? e.name : 'threw'}`);
    }
  }

  const line = `${new Date().toISOString()}  reads=${READS.length}  ` +
    `failures=${failures.length}  slowest=${slowest}ms` +
    (failures.length ? `  [${failures.join(' ')}]` : '');
  mkdirSync(OUT, { recursive: true });
  appendFileSync(LOG, line + '\n', 'utf8');
  console.log(line);
  return failures.length;
}

/** Reads the log back and says whether the day was clean. */
export function summarise() {
  let text = '';
  try {
    text = readFileSync(LOG, 'utf8');
  } catch {
    return 'no rounds recorded yet';
  }
  const lines = text.trim().split('\n').filter(Boolean);
  const bad = lines.filter((l) => !/failures=0\b/.test(l));
  return `${lines.length} rounds, ${bad.length} with a failure`;
}

if (ONCE) {
  process.exit((await round()) === 0 ? 0 : 1);
}

console.log(`probing ${READS.length} reads every ${EVERY_S}s → ${LOG}`);
await round();
setInterval(() => { void round(); }, EVERY_S * 1000);
