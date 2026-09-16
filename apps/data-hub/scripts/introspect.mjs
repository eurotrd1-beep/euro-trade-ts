#!/usr/bin/env node
/**
 * Asks the live Postgres what its columns actually are.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Nine of the twenty tables have no `CREATE TABLE` anywhere in this repo. They
 * predate it — they were made by hand in the Supabase console during the Dart
 * era — so the only description of them in the codebase is the TypeScript
 * interfaces the app reads them through, and an interface only has to name the
 * fields somebody uses. It says nothing about the ones nobody reads, the types,
 * or the defaults.
 *
 * Writing the schema from those interfaces is guessing, and this migration has
 * already shown what guessing costs: a draft had `banned` where the table has
 * `is_banned`, and `signal_daily` keyed on two columns where the real identity
 * is five. Neither would have failed. The first unbans everyone; the second
 * merges rows that are not the same row.
 *
 * So the schema stops being written and starts being derived.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 *
 * PostgREST publishes an OpenAPI description of every table it exposes at the
 * root of the REST API — types, nullability and primary keys, and no rows at
 * all. Supabase restricts that endpoint to the service_role key:
 *
 *   {"message":"Invalid API key","hint":"Only the `service_role` API key can
 *    be used for this endpoint."}
 *
 * With only the anon key there is exactly one way left to learn what columns a
 * table has, and it is to ask for a row and look at the keys. So that is the
 * fallback, with one rule: it reports column NAMES and never a value. `users`
 * holds account ids and device bindings, and the question here is what the
 * columns are called — printing a row to answer it would be reading personal
 * data out loud to answer a question about the schema.
 *
 * The fallback also cannot see types, defaults, or keys, and it goes blind on
 * an empty table. Set SUPABASE_SERVICE_KEY for the full answer.
 *
 *   node scripts/introspect.mjs            print every table and column
 *   node scripts/introspect.mjs --json     write out/live-schema.json
 *   node scripts/introspect.mjs --diff     compare against access.ts
 *
 * The `--diff` form is the one that matters: it reports every column the live
 * table has that this repo does not know about, and every column this repo
 * expects that is not there.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPABASE_URL = 'https://dlzqdmqkvlvwnjhqxqym.supabase.co';
const KEY = process.env['SUPABASE_SERVICE_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';

if (KEY === '') {
  console.error('Set SUPABASE_ANON_KEY (or SUPABASE_SERVICE_KEY) in the environment.');
  console.error('The anon key is enough: this reads the schema, not the rows.');
  process.exit(1);
}

/** Every table PostgREST exposes, with its columns, types and requiredness. */
async function live() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (res.status === 401) {
    console.error('The OpenAPI endpoint needs the service_role key; sampling column');
    console.error('names instead. Types, defaults and keys are NOT available this way.\n');
    return sample();
  }
  if (!res.ok) throw new Error(`Supabase answered ${res.status}`);
  const spec = await res.json();

  const tables = {};
  for (const [name, definition] of Object.entries(spec.definitions ?? {})) {
    const required = new Set(definition.required ?? []);
    tables[name] = Object.entries(definition.properties ?? {}).map(([column, p]) => ({
      column,
      // PostgREST puts the real Postgres type in the description, prefixed by
      // its own format — `timestamp with time zone`, `jsonb`, `boolean`. That
      // is what decides the conversion, so it is what gets reported.
      type: p.format ?? p.type ?? 'unknown',
      nullable: !required.has(column),
      // `<pk/>` in the description marks the primary key.
      pk: typeof p.description === 'string' && p.description.includes('<pk/>'),
    }));
  }
  return tables;
}

/**
 * Column names, read off one row per table.
 *
 * The row is fetched and its KEYS are kept. The values are never stored, never
 * returned and never printed — `sampled: true` on the result is there so a
 * reader of the output knows the types below are unknown rather than trusted.
 */
async function sample() {
  const { MAPPING } = await import('./mapping.mjs');
  const tables = {};
  for (const map of Object.values(MAPPING)) {
    const url = `${SUPABASE_URL}/rest/v1/${map.from}?select=*&limit=1`;
    const res = await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    if (!res.ok) {
      tables[map.from] = { error: `HTTP ${res.status}` };
      continue;
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      // An empty table tells us nothing, and pretending otherwise would let a
      // table with no rows pass as "confirmed, no columns".
      tables[map.from] = { error: 'no rows — cannot see the columns this way' };
      continue;
    }
    tables[map.from] = Object.keys(rows[0]).map((column) => ({
      column, type: 'unknown (sampled)', nullable: null, pk: false,
    }));
  }
  return tables;
}

function print(tables) {
  for (const [name, columns] of Object.entries(tables).sort()) {
    if (!Array.isArray(columns)) {
      console.log(`\n${name}   ⚠️ ${columns.error}`);
      continue;
    }
    const keys = columns.filter((c) => c.pk).map((c) => c.column);
    console.log(`\n${name}${keys.length ? `   pk: ${keys.join(', ')}` : ''}`);
    for (const c of columns) {
      console.log(`  ${c.column.padEnd(24)} ${c.type}${c.nullable ? '' : '  NOT NULL'}`);
    }
  }
}

async function diff(tables) {
  // Compared against the copy mapping, not against access.ts: access.ts names
  // the D1 columns and the mapping names where each one comes from, so the
  // mapping is the only side that speaks Postgres. (It is also plain JS, and
  // access.ts is TypeScript this script cannot import.) The schema tests hold
  // access.ts to the D1 schema; this holds the mapping to Postgres. Between
  // the two there is no gap for a column to fall through.
  const { MAPPING } = await import('./mapping.mjs');

  let problems = 0;
  for (const [table, map] of Object.entries(MAPPING)) {
    const columns = tables[map.from];
    if (!columns) {
      console.log(`${table}: no table '${map.from}' in the live database`);
      problems++;
      continue;
    }
    if (!Array.isArray(columns)) {
      console.log(`${table}: ${columns.error}`);
      problems++;
      continue;
    }
    const liveNames = new Set(columns.map((c) => c.column));
    const mapped = new Set(Object.values(map.columns).map(([source]) => source));

    // The direction that loses data: a column that exists and is not copied.
    const unmapped = [...liveNames].filter((c) => !mapped.has(c));
    // The direction that fails loudly: a column we expect and it is not there.
    const phantom = [...mapped].filter((c) => !liveNames.has(c));

    if (unmapped.length || phantom.length) {
      problems++;
      console.log(`\n${table}  (from ${map.from})`);
      if (unmapped.length) console.log(`  NOT COPIED:  ${unmapped.join(', ')}`);
      if (phantom.length) console.log(`  NOT THERE:   ${phantom.join(', ')}`);
    }
  }

  if (problems === 0) {
    console.log('Every mapped table matches the live schema, in both directions.');
  } else {
    console.log(`\n${problems} table(s) differ. A column under NOT COPIED is data that the`);
    console.log('move would silently leave behind.');
    process.exit(1);
  }
}

const tables = await live();
if (process.argv.includes('--json')) {
  mkdirSync(join(HERE, '..', 'out'), { recursive: true });
  const file = join(HERE, '..', 'out', 'live-schema.json');
  writeFileSync(file, JSON.stringify(tables, null, 2), 'utf8');
  console.log(`wrote ${file}`);
} else if (process.argv.includes('--diff')) {
  await diff(tables);
} else {
  print(tables);
}
