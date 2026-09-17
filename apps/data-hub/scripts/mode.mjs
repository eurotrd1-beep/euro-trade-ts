#!/usr/bin/env node
/**
 * Reads or sets `configs.data_source` — the whole switch, and the whole way back.
 *
 *   node scripts/mode.mjs                 what mode is live
 *   node scripts/mode.mjs supabase        ROLL BACK
 *   node scripts/mode.mjs mirror          read D1, write Supabase, fall back
 *   node scripts/mode.mjs d1              read and write D1, no fallback
 *
 * ── WHY THIS IS A SCRIPT AND NOT A NOTE IN A RUNBOOK ───────────────────────
 *
 * Rolling back has to be one command that works while something is badly
 * wrong, typed by somebody who is not calm. A runbook entry saying "set the
 * data column of the data_source row in configs to a JSON object with mode
 * supabase" is three chances to make it worse.
 *
 * It writes to SUPABASE, deliberately, even when the live mode is `d1`. A
 * switch stored in the database it switches away from cannot be used to leave
 * that database when the database is the thing that is down — which is the
 * only moment the switch matters.
 *
 * Takes effect on each client's next load. Nothing is cached server-side and
 * no deploy is involved.
 *
 * ── AND NOT process.exit() ─────────────────────────────────────────────────
 *
 * On Windows, exiting while a fetch handle is still closing aborts the process
 * with a libuv assertion printed AFTER the output. On a rollback that would
 * look exactly like the rollback having failed, at the moment when guessing
 * wrong is most expensive. So this sets `process.exitCode` and returns.
 */

import './env.mjs';

const SUPABASE_URL = 'https://dlzqdmqkvlvwnjhqxqym.supabase.co';
const KEY = process.env['SUPABASE_SERVICE_KEY'] ?? '';
const HUB = process.env['DATA_HUB_URL'] ?? '';

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function read() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/configs?id=eq.data_source&select=data`,
    { headers },
  );
  const rows = await res.json();
  return rows[0]?.data ?? null;
}

async function apply(wanted) {
  if (wanted !== 'supabase' && wanted !== 'mirror' && wanted !== 'd1') {
    console.error(`unknown mode '${wanted}' — use supabase, mirror or d1`);
    process.exitCode = 1;
    return;
  }

  const previous = await read();
  // The URL is kept even when rolling back, so going forward again does not
  // need it typed a second time. It is ignored in `supabase` mode.
  const url = HUB || previous?.url || '';
  if (wanted !== 'supabase' && !url) {
    console.error('No hub url. Set DATA_HUB_URL, or the app will stay on Supabase.');
    process.exitCode = 1;
    return;
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/configs?on_conflict=id`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ id: 'data_source', data: { mode: wanted, url } }]),
  });

  if (!res.ok) {
    console.error(`failed: HTTP ${res.status}`);
    console.error(await res.text());
    process.exitCode = 1;
    return;
  }

  console.log(`${previous?.mode ?? 'supabase'} → ${wanted}`);
  console.log("Live on each client's next load. No deploy, no cache.");
  if (wanted === 'd1') {
    console.log('\nThe read fallback is OFF in this mode: a failed read is an error,');
    console.log('not a quiet answer from a Supabase that is now behind.');
    console.log('Back out with:  node scripts/mode.mjs supabase');
  }
}

if (!KEY) {
  console.error('Set SUPABASE_SERVICE_KEY (apps/data-hub/.env.local).');
  process.exitCode = 1;
} else {
  const wanted = process.argv[2];
  if (wanted === undefined) {
    const current = await read();
    console.log(current === null
      ? 'data_source is not set — the app is on Supabase'
      : `mode: ${current.mode}\nurl:  ${current.url ?? '(none)'}`);
  } else {
    await apply(wanted);
  }
}
