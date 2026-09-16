#!/usr/bin/env node
/**
 * Counts what is actually inside a pg_dump file.
 *
 * ── WHY A BACKUP NEEDS VERIFYING ───────────────────────────────────────────
 *
 * `pg_dump` exits 0 for a dump that is missing tables. It exits 0 when a role
 * could not read a table and the section came back empty. It exits 0 when the
 * connection dropped after the last COPY it happened to finish. None of those
 * look different from a good dump: the file exists, it is large, it has a
 * header and a footer, and it is wrong.
 *
 * The moment that matters is the one where writes are about to be stopped and
 * the whole plan rests on "we can go back". Going back rests on this file. So
 * before anything is frozen, this reads the dump and says how many rows it
 * holds for each table — a number that can be compared against the live
 * database, by eye, in one screen.
 *
 *   node scripts/verify-backup.mjs backup.sql
 *
 * It reads the file and nothing else: no database connection, no credentials.
 *
 * ── HOW TO TAKE THE DUMP ───────────────────────────────────────────────────
 *
 * From the Supabase dashboard: Project Settings → Database → Connection string
 * (session mode). Then, with that in PGURL and never in a file:
 *
 *   pg_dump "$PGURL" --schema=public --no-owner --no-privileges -f backup.sql
 *
 * Plain SQL, not a custom-format archive, so it can be read by a person and by
 * this script. `--no-owner` and `--no-privileges` because the roles on a
 * restore target will not be the same ones, and a dump that only restores onto
 * an identical role setup is a dump with a condition attached.
 */

import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

const file = process.argv[2];
if (!file) {
  console.error('usage: verify-backup.mjs <backup.sql>');
  process.exit(1);
}

/** Every table the migration expects to find. */
const EXPECTED = [
  'brokers', 'candles', 'captcha_stats', 'clicks', 'configs', 'otc_pairs',
  'pairs', 'price_snapshot', 'push_alerts', 'push_subscriptions', 'repair_log',
  'signal_daily', 'signal_history', 'signal_write_budget', 'signals',
  'strategy_versions', 'telegram_alerts', 'telegram_queue', 'users',
];

const rows = new Map();
const created = new Set();
let inCopy = null;
let sawFooter = false;

const stream = createInterface({
  input: createReadStream(file, 'utf8'),
  crlfDelay: Number.POSITIVE_INFINITY,
});

for await (const line of stream) {
  if (inCopy !== null) {
    // A COPY block ends with a lone backslash-dot. Everything before it is one
    // row per line.
    if (line === '\\.') { inCopy = null; continue; }
    rows.set(inCopy, (rows.get(inCopy) ?? 0) + 1);
    continue;
  }

  const copy = line.match(/^COPY public\.(\w+) /);
  if (copy) {
    inCopy = copy[1];
    if (!rows.has(inCopy)) rows.set(inCopy, 0);
    continue;
  }

  const create = line.match(/^CREATE TABLE public\.(\w+)/);
  if (create) { created.add(create[1]); continue; }

  // INSERT-style dumps (--inserts) instead of COPY.
  const insert = line.match(/^INSERT INTO public\.(\w+) /);
  if (insert) rows.set(insert[1], (rows.get(insert[1]) ?? 0) + 1);

  // pg_dump writes this as the very last line of a complete dump. Its absence
  // means the dump was cut off, and a truncated dump is the one failure that
  // looks most like a working one.
  if (line.startsWith('-- PostgreSQL database dump complete')) sawFooter = true;
}

const size = statSync(file).size;
console.log(`${file}  ${(size / 1024 / 1024).toFixed(1)} MB\n`);

let total = 0;
let missing = 0;
for (const table of EXPECTED) {
  const count = rows.get(table);
  const hasSchema = created.has(table);
  if (count === undefined) {
    console.log(`  ${table.padEnd(24)} ${hasSchema ? 'schema only, NO DATA SECTION' : 'ABSENT'}`);
    missing++;
    continue;
  }
  total += count;
  console.log(`  ${table.padEnd(24)} ${String(count).padStart(9)} rows` +
    (hasSchema ? '' : '   ⚠️ data but no CREATE TABLE'));
}

// Anything in the dump that this migration does not know about. Not an error —
// a table nobody told me about is exactly what turned up twice already.
const extra = [...rows.keys()].filter((t) => !EXPECTED.includes(t));
if (extra.length > 0) {
  console.log(`\n  Also in the dump, and NOT in the migration:`);
  for (const t of extra) console.log(`  ${t.padEnd(24)} ${String(rows.get(t)).padStart(9)} rows`);
}

console.log(`\n${total} rows across ${EXPECTED.length - missing} tables.`);

if (!sawFooter) {
  console.log('\n⛔ The dump has no completion marker. It was cut off part-way.');
  console.log('   Take it again. A truncated dump is the failure that looks most like');
  console.log('   a working one — it restores, and it is missing whatever came last.');
  process.exit(1);
}
if (missing > 0) {
  console.log(`\n⛔ ${missing} table(s) have no data section.`);
  console.log('   If any of them has rows in Supabase, this backup cannot restore them.');
  console.log('   Check the dump role could read every table, then take it again.');
  process.exit(1);
}
if (extra.length > 0) {
  console.log('\n⚠️  The dump holds tables the migration does not cover. They are backed up,');
  console.log('   and they would NOT be copied to D1. Decide before freezing writes.');
}
console.log('\n✓ Complete dump, every expected table present with a data section.');
console.log('  Compare the counts above against Supabase before freezing writes.');
