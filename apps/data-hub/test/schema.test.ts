/**
 * The schema, run on a real SQLite engine.
 *
 * ── WHY THIS IS NOT THE SAME AS READING THE FILE ───────────────────────────
 *
 * `access.test.ts` reads the schema as text, which catches a table with no
 * access rule but cannot catch a schema that does not work. A CHECK that never
 * fires, a UNIQUE index that is not on the columns the duplicate guard relies
 * on, a DEFAULT that is not what the code assumes — all of those are valid
 * text and wrong behaviour, and every one of them fails silently at exactly
 * the moment it matters.
 *
 * So this file executes it and then tries to break it.
 *
 * ── AND ONE MORE THING IT CATCHES ──────────────────────────────────────────
 *
 * The `users` case below exists because a draft of this schema invented column
 * names: `banned` where the live table has `is_banned`, a `seen_ms` nothing
 * writes, and four real columns missing. That is not a rename — a copy into a
 * renamed column lands nowhere, and `is_banned` arriving empty unbans every
 * account that was banned. The list here is taken from `UserRow` in
 * packages/shared/src/database.ts, which is what the app and the admin read.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { POLICY } from '../src/access.js';

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../migrations/0001_schema.sql', import.meta.url)),
  'utf8',
);

interface Db {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
}

let db: Db;

beforeAll(() => {
  // `createRequire` rather than a dynamic import, because Vite's resolver does
  // not hand `node:sqlite` through and the import fails on a runtime that has
  // it. Node 22.5+.
  //
  // Deliberately NOT skipped when the module is absent: a verification that
  // quietly does not run is worse than no verification, because the green tick
  // still says it did. CI is pinned to Node 22 in .github/workflows/deploy.yml.
  let DatabaseSync: new (path: string) => Db;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
  } catch {
    throw new Error('node:sqlite is unavailable — run the schema tests on Node 22.5 or newer');
  }
  db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
});

const run = (sql: string, ...args: unknown[]): void => { db.prepare(sql).run(...args); };
const all = (sql: string, ...args: unknown[]): Record<string, unknown>[] =>
  db.prepare(sql).all(...args) as Record<string, unknown>[];
const columnsOf = (table: string): string[] =>
  all(`PRAGMA table_info(${table})`).map((r) => String(r['name']));

describe('the schema runs', () => {
  it('creates all twenty tables', () => {
    const tables = all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).map((r) => String(r['name']));
    expect(tables).toHaveLength(20);
  });

  it('is re-runnable, because every statement is IF NOT EXISTS', () => {
    // A migration that fails the second time it runs is a migration nobody can
    // re-apply after a partial failure — which is when re-applying is needed.
    expect(() => db.exec(SCHEMA)).not.toThrow();
  });
});

describe('users carries every column the app and the admin read', () => {
  // Straight from UserRow. Kept as a literal list on purpose: it has to be
  // possible to compare this against the live table by eye.
  const REQUIRED = [
    'id', 'broker', 'role', 'is_banned', 'ban_reason', 'device_id',
    'fcm_token', 'login_count', 'vip_expiry_ms', 'guaranteed_win',
    'clicked_broker', 'created_ms',
  ];

  it('has no column missing', () => {
    const have = columnsOf('users');
    const missing = REQUIRED.filter((c) => !have.includes(c));
    expect(missing, `users is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no column the app does not read', () => {
    // An extra column is not harmless: it is a field nothing fills, which
    // reads as data that is always empty rather than as a mistake.
    const extra = columnsOf('users').filter((c) => !REQUIRED.includes(c));
    expect(extra, `users has columns nothing reads: ${extra.join(', ')}`).toEqual([]);
  });

  it('defaults a new account to not banned, not guaranteed, standard', () => {
    run("INSERT INTO users (id, created_ms) VALUES ('u1', 1)");
    const row = all("SELECT * FROM users WHERE id='u1'")[0]!;
    expect(row['role']).toBe('standard');
    expect(row['is_banned']).toBe(0);
    // The one that matters most: an account must never arrive with the
    // admin-only flag that makes every one of its trades close as a win.
    expect(row['guaranteed_win']).toBe(0);
  });
});

describe('every column access.ts declares exists in the real table', () => {
  // access.ts decides what may be selected, filtered and ordered by, and those
  // names go into the SQL text. A name that is not a column there is a query
  // that fails at request time for a caller who did nothing wrong — and it is
  // invisible until someone asks for that exact field. This is the same check
  // that turned up `banned` for `is_banned`, one layer up.
  for (const [table, policy] of Object.entries(POLICY)) {
    it(`${table}`, () => {
      const real = columnsOf(table);
      const phantom = policy.columns.filter((c) => !real.includes(c));
      expect(phantom, `${table} declares columns it does not have: ${phantom.join(', ')}`)
        .toEqual([]);
    });
  }

  it('declares every column of every table, so nothing is unreachable by accident', () => {
    // The other direction. A column in the schema that access.ts never lists
    // cannot be read by anyone, which is safe but silent: the field is simply
    // always absent. Better to have to decide about it.
    const undeclared: string[] = [];
    for (const [table, policy] of Object.entries(POLICY)) {
      for (const c of columnsOf(table)) {
        if (!policy.columns.includes(c)) undeclared.push(`${table}.${c}`);
      }
    }
    expect(undeclared, `columns with no entry in access.ts: ${undeclared.join(', ')}`).toEqual([]);
  });
});

describe('the duplicate guard the signal writer depends on', () => {
  it('rejects a second signal with the same identity', () => {
    const insert = `INSERT INTO signals (id, symbol, timeframe, direction, bar_ms,
      strategy_version_id, created_ms) VALUES (?, 'EURUSD_otc', '1m', 'CALL', 100, 'v1', 1)`;
    run(insert, 'sig-1');
    // `record_signals` writes with ON CONFLICT DO NOTHING and reads the
    // conflict as "already recorded". No index, no conflict, and the same
    // signal is written twice under load — with no error either time.
    expect(() => run(insert, 'sig-2')).toThrow(/UNIQUE|constraint/i);
  });

  it('lets a different bar through', () => {
    expect(() => run(`INSERT INTO signals (id, symbol, timeframe, direction, bar_ms,
      strategy_version_id, created_ms) VALUES ('sig-3', 'EURUSD_otc', '1m', 'CALL', 160, 'v1', 1)`,
    )).not.toThrow();
  });
});

describe('the CHECKs actually fire', () => {
  it('refuses a JSON column that is not JSON', () => {
    // The real failure this catches: a serialisation that quietly produced
    // "[object Object]", written and then read back for ever without complaint.
    expect(() => run(
      "INSERT INTO candles (key, data, updated_ms) VALUES ('EURUSD_otc_1', '[object Object]', 1)",
    )).toThrow(/constraint/i);
  });

  it('accepts real JSON in the same column', () => {
    expect(() => run(
      "INSERT INTO candles (key, data, updated_ms) VALUES ('EURUSD_otc_1', '[{\"t\":1}]', 1)",
    )).not.toThrow();
  });

  it('caps a history row so one account cannot become megabytes', () => {
    const many = JSON.stringify(Array.from({ length: 201 }, (_, i) => ({ entryTime: i })));
    expect(() => run(
      'INSERT INTO signal_history (account_id, signals, updated_ms) VALUES (?, ?, 1)',
      'acct-big', many,
    )).toThrow(/constraint/i);
  });

  it('allows a history at the cap', () => {
    const exact = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ entryTime: i })));
    expect(() => run(
      'INSERT INTO signal_history (account_id, signals, updated_ms) VALUES (?, ?, 1)',
      'acct-ok', exact,
    )).not.toThrow();
  });

  it('only lets telegram_alerts hold a kind the sender knows', () => {
    expect(() => run(
      "INSERT INTO telegram_alerts (event_key, kind, sent_ms) VALUES ('k1', 'typo', 1)",
    )).toThrow(/constraint/i);
  });
});

describe('both catalogues arrive switched off', () => {
  it('leaves a new otc_pairs symbol disabled', () => {
    run(`INSERT INTO otc_pairs (id, platform, symbol, updated_ms)
         VALUES ('p1', 'pocketoption', 'NEWPAIR_otc', 1)`);
    expect(all("SELECT enabled FROM otc_pairs WHERE id='p1'")[0]!['enabled']).toBe(0);
  });

  it('leaves a new pairs row disabled', () => {
    run(`INSERT INTO pairs (id, symbol, chart_symbol, created_ms)
         VALUES ('q1', 'New OTC', 'NEWPAIR_otc', 1)`);
    expect(all("SELECT enabled FROM pairs WHERE id='q1'")[0]!['enabled']).toBe(0);
  });
});
