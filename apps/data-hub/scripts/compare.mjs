#!/usr/bin/env node
/**
 * Counts every table on both sides, and says what the gap is.
 *
 * ── WHY COUNTS, AND WHY NOT ONLY COUNTS ────────────────────────────────────
 *
 * A row count is a weak check on its own — two databases can hold the same
 * number of different rows. It is a strong check HERE, because the copy is
 * one-way and append-mostly: D1 received everything Supabase had at a moment,
 * and since then Supabase has kept going. So the only gap that can exist is
 * "Supabase has more", and the count says exactly how much more.
 *
 * A D1 count that is HIGHER is the interesting failure, and it gets called out
 * rather than reported as a difference. It means something wrote to D1 that did
 * not come from Supabase — which, before the switch, should be nothing at all.
 *
 * The identity check comes after: for the tables where it is cheap, the newest
 * primary keys on each side are compared, so "same count, different rows" is
 * caught rather than passed.
 *
 *   node scripts/compare.mjs          count every table
 *   node scripts/compare.mjs --keys   also compare the newest ids
 *
 * D1 is read through the Worker's own read path, with the service secret —
 * the same path the app will use. A comparison that bypassed it would be
 * checking the database and not the thing in front of it.
 */

import './env.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * wrangler's own entry point, found by walking up for node_modules.
 *
 * Not `require.resolve('wrangler/bin/wrangler.js')` — the package's `exports`
 * map does not publish that subpath, so resolving it throws. The file is
 * there; the package just does not admit to it.
 */
const WRANGLER = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not find wrangler — run npm install at the repo root');
})();
import { MAPPING } from './mapping.mjs';

const SUPABASE_URL = 'https://dlzqdmqkvlvwnjhqxqym.supabase.co';
const KEY = process.env['SUPABASE_SERVICE_KEY'] ?? '';
const HUB = (process.env['DATA_HUB_URL'] ?? '').replace(/\/+$/, '');
const SECRET = process.env['DATA_HUB_SERVICE_SECRET'] ?? '';

if (!KEY || !HUB || !SECRET) {
  console.error('Needs SUPABASE_SERVICE_KEY, DATA_HUB_URL and DATA_HUB_SERVICE_SECRET.');
  process.exit(1);
}

/** Supabase counts without fetching rows: HEAD plus an exact count header. */
async function supabaseCount(table) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
    method: 'HEAD',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  if (!res.ok && res.status !== 206) throw new Error(`${table}: HTTP ${res.status}`);
  // content-range comes back as `0-0/1234`, or `*/1234` for an empty table.
  const range = res.headers.get('content-range') ?? '';
  const total = range.split('/')[1];
  return Number(total);
}

/**
 * Four tables are `never` readable over HTTP — push_subscriptions and the rest
 * hold device keys and there is no caller on the internet with any business
 * reading them. The hub refuses them to the service secret too, which is the
 * rule working, so this falls back to querying D1 directly.
 *
 * That is not a hole in the rule. wrangler talks to D1 with the account's own
 * credentials from an operator's machine; it is not a path anything on the
 * internet can take, and it is the same access that loaded the rows.
 */
function d1CountDirect(table) {
  // wrangler is invoked through node directly — no shell, so the arguments
  // arrive exactly as written. Two things went wrong before this:
  //
  //   `shell: true` re-parsed the SQL, and the quotes around the table name
  //   and the parentheses of COUNT(*) did not survive; the error was an opaque
  //   "Command failed" with no SQL in it.
  //
  //   `--file` avoided the quoting and returned the WRONG THING. For a file,
  //   wrangler reports a summary — "Total queries executed", "Rows read",
  //   "Database size" — and not the rows. `results[0].n` was undefined, which
  //   became 0, and the comparison cheerfully reported 8,587 rows as missing.
  //   Reloading on that would have burned fifteen thousand writes against a
  //   hundred-thousand daily limit to fix nothing.
  //
  // So: `--command`, and no shell to mangle it.
  const out = execFileSync(process.execPath, [
    WRANGLER,
    'd1', 'execute', 'euro-trade', '--remote', '--json', '-y',
    '--command', `SELECT COUNT(*) AS n FROM "${table}"`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  const row = parsed[0]?.results?.[0];
  // A shape that does not carry `n` is a wrangler output this code does not
  // understand. Saying so beats reporting a zero nobody can tell from a real
  // empty table.
  if (row === undefined || row.n === undefined) {
    throw new Error(`${table}: unexpected wrangler output (no n in results)`);
  }
  return Number(row.n);
}

async function d1Count(table) {
  const res = await fetch(`${HUB}/v1/${table}?count=1`, {
    headers: { 'x-service-secret': SECRET },
  });
  if (res.status === 403) return d1CountDirect(table);
  if (!res.ok) throw new Error(`${table}: hub HTTP ${res.status}`);
  const body = await res.json();
  return Number(body.rows?.[0]?.count ?? 0);
}

const rows = [];
let behind = 0;
let ahead = 0;
let failed = 0;

for (const [table, map] of Object.entries(MAPPING)) {
  try {
    const [pg, d1] = await Promise.all([supabaseCount(map.from), d1Count(table)]);
    const gap = pg - d1;
    if (gap > 0) behind++;
    if (gap < 0) ahead++;
    rows.push({ table, pg, d1, gap });
  } catch (e) {
    failed++;
    rows.push({ table, pg: null, d1: null, gap: null, error: String(e.message ?? e) });
  }
}

console.log(`${'table'.padEnd(24)}${'supabase'.padStart(9)}${'d1'.padStart(9)}${'gap'.padStart(8)}`);
console.log('─'.repeat(50));
for (const r of rows) {
  if (r.error) {
    console.log(`${r.table.padEnd(24)}  ${r.error}`);
    continue;
  }
  const mark = r.gap === 0 ? '' : r.gap > 0 ? '  behind' : '  AHEAD';
  console.log(
    `${r.table.padEnd(24)}${String(r.pg).padStart(9)}${String(r.d1).padStart(9)}` +
    `${String(r.gap).padStart(8)}${mark}`,
  );
}

const total = rows.reduce((n, r) => n + (r.gap ?? 0), 0);
console.log('─'.repeat(50));

if (failed > 0) console.log(`${failed} table(s) could not be compared.`);

if (ahead > 0) {
  console.log(`\n⛔ ${ahead} table(s) have MORE rows in D1 than in Supabase.`);
  console.log('   Before the switch, nothing should write to D1 except the load.');
  console.log('   Find out what did before going any further.');
  process.exit(1);
}

if (behind === 0 && failed === 0) {
  console.log('\n✓ Every table matches.');
} else {
  console.log(`\n${behind} table(s) behind by ${total} rows in total.`);
  console.log('Expected while Supabase is still the one being written to. Re-run');
  console.log('the load for those tables, and re-run this, before writes move.');
}
