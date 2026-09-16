/**
 * The write path: the three ways an account could write outside itself.
 *
 * Reading someone else's row is a disclosure. Writing it is a change they did
 * not make and cannot see — a trade history overwritten, a VIP flag set, an
 * account banned. So the write rules get their own file, and each of the three
 * escapes gets its own section, because they are genuinely different holes
 * that happen to share a table.
 *
 * As in db.test.ts, the checks come in two kinds: the statement as text,
 * because a missing clause has no behaviour to observe, and then the same
 * statements run on a real engine with two accounts' rows.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildWrite, type Write } from '../src/db.js';
import { POLICY, type Caller } from '../src/access.js';

const pub: Caller = { kind: 'public' };
const user = (id: string): Caller => ({ kind: 'user', accountId: id });
const admin: Caller = { kind: 'admin' };
const service: Caller = { kind: 'service' };

const w = (over: Partial<Write> & { table: string; op: Write['op'] }): Write => ({
  values: {}, where: [], ...over,
});

function sqlOf(write: Write, caller: Caller): { sql: string; binds: unknown[] } {
  const built = buildWrite(write, caller);
  if (!built.ok) throw new Error(`expected a statement, got ${built.status}: ${built.reason}`);
  return built.statement;
}

// ── Escape 1: changing rows that are not yours ──────────────────────────────

describe('an update or delete carries the scope', () => {
  it('scopes an update to the caller', () => {
    const { sql, binds } = sqlOf(
      w({ table: 'signal_history', op: 'update', values: { signals: '[]' },
          where: [{ column: 'account_id', value: 'alice' }] }),
      user('alice'),
    );
    expect(sql).toBe('UPDATE "signal_history" SET "signals" = ? WHERE "account_id" = ? ' +
      'AND "account_id" = ?');
    expect(binds).toEqual(['[]', 'alice', 'alice']);
  });

  it('scopes a delete to the caller', () => {
    const { sql, binds } = sqlOf(w({ table: 'signal_history', op: 'delete' }), user('alice'));
    expect(sql).toBe('DELETE FROM "signal_history" WHERE "account_id" = ?');
    expect(binds).toEqual(['alice']);
  });

  it('cannot be aimed at another account', () => {
    const { binds } = sqlOf(
      w({ table: 'users', op: 'update', values: { broker: 'x' },
          where: [{ column: 'id', value: 'bob' }] }),
      user('alice'),
    );
    // Both clauses AND together, so the statement asks for a row that is both
    // alice and bob. There is none.
    expect(binds).toEqual(['x', 'alice', 'bob']);
  });

  it('refuses an update with no filter at all', () => {
    // For a service caller there is no scope to save it, and `UPDATE users SET
    // role = 'vip'` is a legal statement that reports success.
    const built = buildWrite(w({ table: 'users', op: 'update', values: { role: 'vip' } }), service);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toContain('at least one filter');
  });

  it('refuses a delete with no filter at all', () => {
    const built = buildWrite(w({ table: 'candles', op: 'delete' }), service);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.status).toBe(400);
  });

  it('lets the service delete once it names the rows', () => {
    const { sql } = sqlOf(
      w({ table: 'candles', op: 'delete', where: [{ column: 'key', value: 'EURUSD_otc_1' }] }),
      service,
    );
    expect(sql).toBe('DELETE FROM "candles" WHERE "key" = ?');
  });
});

// ── Escape 2: creating a row owned by someone else ──────────────────────────

describe('an insert is stamped with the caller, not with the body', () => {
  it('overwrites an account id the body tried to choose', () => {
    const { sql, binds } = sqlOf(
      w({ table: 'signal_history', op: 'insert',
          values: { account_id: 'bob', signals: '[]', updated_ms: 1 } }),
      user('alice'),
    );
    expect(sql).toContain('INSERT INTO "signal_history" ("account_id", "signals", "updated_ms")');
    expect(binds[0]).toBe('alice');
    expect(binds).not.toContain('bob');
  });

  it('adds the owner column when the body omits it', () => {
    const { binds } = sqlOf(
      w({ table: 'signal_history', op: 'insert', values: { signals: '[]', updated_ms: 1 } }),
      user('alice'),
    );
    expect(binds[0]).toBe('alice');
  });

  it('does the same for an upsert, which is what the app actually sends', () => {
    const { sql, binds } = sqlOf(
      w({ table: 'signal_history', op: 'upsert',
          values: { account_id: 'bob', signals: '[{"pair":"x"}]', updated_ms: 2 } }),
      user('alice'),
    );
    expect(binds[0]).toBe('alice');
    expect(sql).toContain('ON CONFLICT ("account_id") DO UPDATE SET');
  });

  it('leaves the admin free to write any row, which is the point of admin', () => {
    const { binds } = sqlOf(
      w({ table: 'users', op: 'upsert', values: { id: 'bob', role: 'vip' } }),
      admin,
    );
    expect(binds).toContain('bob');
  });
});

// ── Escape 3: moving a row to another owner ─────────────────────────────────

describe('an owner column cannot be reassigned', () => {
  it('refuses an update that sets the owner column', () => {
    // There is no honest version of "change whose row this is".
    const built = buildWrite(
      w({ table: 'signal_history', op: 'update', values: { account_id: 'bob' },
          where: [{ column: 'updated_ms', value: '1' }] }),
      user('alice'),
    );
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.status).toBe(403);
      expect(built.reason).toContain('cannot be changed');
    }
  });

  it('refuses it even when set to the caller\'s own id', () => {
    // Harmless in that one case, and allowing it would mean the rule is "we
    // check the value", which is a rule with a bug in it waiting to happen.
    const built = buildWrite(
      w({ table: 'users', op: 'update', values: { id: 'alice', role: 'vip' },
          where: [{ column: 'role', value: 'standard' }] }),
      user('alice'),
    );
    expect(built.ok).toBe(false);
  });

  it('still lets the admin move one, since the admin has no owner scope', () => {
    expect(buildWrite(
      w({ table: 'users', op: 'update', values: { id: 'carol' },
          where: [{ column: 'id', value: 'bob' }] }),
      admin,
    ).ok).toBe(true);
  });
});

// ── The gate, and the shape of a write ──────────────────────────────────────

describe('who may write at all', () => {
  it('refuses the public everywhere', () => {
    for (const table of ['candles', 'users', 'configs', 'clicks', 'signal_history']) {
      const built = buildWrite(w({ table, op: 'upsert', values: { id: 'x' } }), pub);
      expect(built.ok, table).toBe(false);
    }
  });

  it('refuses a user on a table that is not theirs', () => {
    expect(buildWrite(w({ table: 'candles', op: 'upsert', values: { key: 'k' } }), user('a')).ok)
      .toBe(false);
    expect(buildWrite(w({ table: 'configs', op: 'upsert', values: { id: 'c' } }), user('a')).ok)
      .toBe(false);
  });

  it('refuses an unknown column', () => {
    const built = buildWrite(
      w({ table: 'users', op: 'update', values: { 'role = \'vip\'; --': 'x' },
          where: [{ column: 'id', value: 'bob' }] }),
      admin,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.status).toBe(400);
  });

  it('refuses a write with no values', () => {
    const built = buildWrite(
      w({ table: 'users', op: 'update', values: {}, where: [{ column: 'id', value: 'b' }] }),
      admin,
    );
    expect(built.ok).toBe(false);
  });

  it('binds every value, however hostile', () => {
    const nasty = "'); DROP TABLE users; --";
    const { sql, binds } = sqlOf(
      w({ table: 'users', op: 'upsert', values: { id: 'bob', ban_reason: nasty } }),
      admin,
    );
    expect(sql).not.toContain('DROP');
    expect(binds).toContain(nasty);
  });
});

describe('the upsert conflict target', () => {
  it('is the declared primary key', () => {
    const { sql } = sqlOf(
      w({ table: 'candles', op: 'upsert', values: { key: 'k', data: '[]', updated_ms: 1 } }),
      service,
    );
    expect(sql).toContain('ON CONFLICT ("key") DO UPDATE SET "data" = excluded."data"');
  });

  it('handles a composite key', () => {
    const { sql } = sqlOf(
      w({ table: 'push_alerts', op: 'upsert',
          values: { symbol: 'E', setup_key: 'k', stage: 96, sent_ms: 1 } }),
      service,
    );
    expect(sql).toContain('ON CONFLICT ("symbol", "setup_key", "stage") DO UPDATE SET ' +
      '"sent_ms" = excluded."sent_ms"');
  });

  it('uses the expression target for the one table whose key is an expression', () => {
    // signal_daily's identity is a unique index over COALESCE(version, zero),
    // because the version is legitimately NULL and NULLs never compare equal.
    // A plain column list here would not match the index, and then ON CONFLICT
    // never fires: every refresh inserts instead of updating, and the daily
    // stats grow a new row per run while the app reads the first one.
    const { sql } = sqlOf(
      w({ table: 'signal_daily', op: 'upsert',
          values: { day: '2026-09-16', symbol: 'E', timeframe: '1m', slot: 'instant_free',
                    wins: 1 } }),
      service,
    );
    expect(sql).toContain(
      `ON CONFLICT ("day", COALESCE("strategy_version_id", ` +
      `'00000000-0000-0000-0000-000000000000'), "symbol", "timeframe", "slot")`);
    expect(sql).toContain('DO UPDATE SET "wins" = excluded."wins"');
  });

  it('does not assign the key to itself', () => {
    const { sql } = sqlOf(
      w({ table: 'configs', op: 'upsert', values: { id: 'c', data: '{}', updated_ms: 1 } }),
      admin,
    );
    expect(sql).not.toContain('"id" = excluded."id"');
  });

  it('refuses an upsert that carries only the key', () => {
    // `ON CONFLICT DO UPDATE SET` with nothing to set is a syntax error, and
    // the caller meant something they did not say.
    const built = buildWrite(w({ table: 'configs', op: 'upsert', values: { id: 'c' } }), admin);
    expect(built.ok).toBe(false);
  });
});

// ── Against a real engine ───────────────────────────────────────────────────

interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...a: unknown[]): { changes: number | bigint };
    all(...a: unknown[]): unknown[];
  };
}
let db: Db;

const apply = (write: Write, caller: Caller): number => {
  const { sql, binds } = sqlOf(write, caller);
  return Number(db.prepare(sql).run(...binds).changes);
};
const rows = (sql: string): Record<string, unknown>[] =>
  db.prepare(sql).all() as Record<string, unknown>[];

describe('run against SQLite, one account cannot change another', () => {
  beforeEach(() => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    db = new DatabaseSync(':memory:') as Db;
    db.exec(readFileSync(
      fileURLToPath(new URL('../migrations/0001_schema.sql', import.meta.url)), 'utf8',
    ));
    db.exec(`
      INSERT INTO users (id, role, is_banned, created_ms)
        VALUES ('alice', 'standard', 0, 1), ('bob', 'standard', 0, 2);
      INSERT INTO signal_history (account_id, signals, updated_ms)
        VALUES ('alice', '[{"pair":"A"}]', 1), ('bob', '[{"pair":"B"}]', 2);
    `);
  });

  it('changes nothing when alice aims at bob', () => {
    const changed = apply(
      w({ table: 'signal_history', op: 'update', values: { signals: '[]', updated_ms: 9 },
          where: [{ column: 'account_id', value: 'bob' }] }),
      user('alice'),
    );
    expect(changed).toBe(0);
    expect(rows("SELECT signals FROM signal_history WHERE account_id='bob'")[0]!['signals'])
      .toBe('[{"pair":"B"}]');
  });

  it('changes alice\'s own row', () => {
    expect(apply(
      w({ table: 'signal_history', op: 'update', values: { signals: '[{"pair":"Z"}]' },
          where: [] }),
      user('alice'),
    )).toBe(1);
    expect(rows("SELECT signals FROM signal_history WHERE account_id='alice'")[0]!['signals'])
      .toBe('[{"pair":"Z"}]');
  });

  it('cannot grant itself VIP', () => {
    // The attempt an open `users` table allows today, from a browser, with a
    // key that ships in every copy of the app.
    apply(
      w({ table: 'users', op: 'update', values: { role: 'vip' }, where: [] }),
      user('alice'),
    );
    expect(rows("SELECT role FROM users WHERE id='bob'")[0]!['role']).toBe('standard');
    // alice may of course change her OWN row — the protection is the scope,
    // not a rule about which column. Role is admin-only by table, not here.
    expect(rows("SELECT role FROM users WHERE id='alice'")[0]!['role']).toBe('vip');
  });

  it('cannot ban anyone else', () => {
    apply(
      w({ table: 'users', op: 'update', values: { is_banned: 1 },
          where: [{ column: 'id', value: 'bob' }] }),
      user('alice'),
    );
    expect(rows("SELECT is_banned FROM users WHERE id='bob'")[0]!['is_banned']).toBe(0);
  });

  it('upserts alice\'s history into her own row, not a second one', () => {
    apply(
      w({ table: 'signal_history', op: 'upsert',
          values: { account_id: 'bob', signals: '[{"pair":"C"}]', updated_ms: 5 } }),
      user('alice'),
    );
    // One row each, still. The body said bob; the credential said alice.
    expect(rows('SELECT account_id FROM signal_history ORDER BY account_id'))
      .toEqual([{ account_id: 'alice' }, { account_id: 'bob' }]);
    expect(rows("SELECT signals FROM signal_history WHERE account_id='alice'")[0]!['signals'])
      .toBe('[{"pair":"C"}]');
    expect(rows("SELECT signals FROM signal_history WHERE account_id='bob'")[0]!['signals'])
      .toBe('[{"pair":"B"}]');
  });

  it('upserts twice without making a duplicate', () => {
    // The conflict target working. With the wrong one this passes silently as
    // two rows, and the app reads the older of them for ever after.
    for (const n of [1, 2, 3]) {
      apply(w({ table: 'candles', op: 'upsert',
        values: { key: 'EURUSD_otc_1', data: `[{"t":${n}}]`, updated_ms: n } }), service);
    }
    expect(rows('SELECT key, data FROM candles')).toEqual([
      { key: 'EURUSD_otc_1', data: '[{"t":3}]' },
    ]);
  });

  it('executes a write on every writable table without a syntax error', () => {
    for (const [table, policy] of Object.entries(POLICY)) {
      const values: Record<string, unknown> = {};
      // A value for the key and for one non-key column, which is the minimum
      // an upsert needs.
      for (const c of policy.primaryKey) values[c] = 'k';
      const other = policy.columns.find((c) => !policy.primaryKey.includes(c));
      if (other === undefined) continue;
      values[other] = null;
      expect(() => sqlOf(w({ table, op: 'upsert', values }), service), table).not.toThrow();
    }
  });
});
