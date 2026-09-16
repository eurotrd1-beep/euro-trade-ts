/**
 * The access model — and the inventory check that makes forgetting impossible.
 *
 * ── THE FAILURE THIS FILE EXISTS FOR ───────────────────────────────────────
 *
 * Postgres refuses on its own. Code only refuses where somebody wrote a rule,
 * and a table with no rule is not an error — it is an open table, with no
 * exception, no log line and nothing on any dashboard.
 *
 * That already happened in this project: `push_subscriptions` was readable with
 * the public anon key for months, returning every device's push encryption keys
 * next to the account they belong to. Nobody wrote that hole. Somebody wrote a
 * `CREATE TABLE` and no policy.
 *
 * So the last describe block below reads the table names out of the schema file
 * and fails if any of them is missing from POLICY. A new table with no decision
 * about it is a red build.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decide, GOVERNED, POLICY, type Caller } from '../src/access.js';

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../migrations/0001_schema.sql', import.meta.url)),
  'utf8',
);

/**
 * The schema with its comment lines removed — the statements alone.
 *
 * The header explains the conversion in prose ("`timestamptz` becomes
 * INTEGER"), so a check for the banned type against the raw file matches the
 * sentence saying it is banned. Assert against the SQL, not the commentary.
 */
const SQL = SCHEMA.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

const pub: Caller = { kind: 'public' };
const user = (id = 'acct-1'): Caller => ({ kind: 'user', accountId: id });
const admin: Caller = { kind: 'admin' };
const service: Caller = { kind: 'service' };

describe('an unknown table', () => {
  it('is refused, for every caller and every operation', () => {
    for (const caller of [pub, user(), admin, service]) {
      for (const op of ['read', 'write'] as const) {
        expect(decide('secrets', op, caller).allowed).toBe(false);
      }
    }
  });

  it('says why, so a refusal is not mistaken for a bug', () => {
    expect(decide('secrets', 'read', service).reason).toContain('no policy');
  });
});

describe('the tables nobody may read over HTTP', () => {
  // `push_subscriptions` holds p256dh and auth keys per device. There is no
  // caller on the internet with any business reading it — including the admin,
  // who has no screen that shows them.
  for (const t of ['push_subscriptions', 'push_alerts', 'telegram_alerts', 'price_snapshot']) {
    it(`refuses a read of ${t} to everyone, admin and service included`, () => {
      for (const caller of [pub, user(), admin, service]) {
        expect(decide(t, 'read', caller).allowed).toBe(false);
      }
    });
  }

  it('still lets the service write them', () => {
    expect(decide('push_subscriptions', 'write', service).allowed).toBe(true);
  });
});

describe('public data', () => {
  it('is readable without a credential', () => {
    for (const t of ['candles', 'pairs', 'configs', 'brokers', 'signals']) {
      expect(decide(t, 'read', pub).allowed).toBe(true);
    }
  });

  it('is not writable without one', () => {
    for (const t of ['candles', 'pairs', 'configs', 'brokers', 'signals']) {
      expect(decide(t, 'write', pub).allowed).toBe(false);
    }
  });

  it('separates who may write each one', () => {
    // A pair list is an admin decision; candles are the feed's. Collapsing the
    // two would let whoever can write one write the other.
    expect(decide('pairs', 'write', admin).allowed).toBe(true);
    expect(decide('candles', 'write', admin).allowed).toBe(false);
    expect(decide('candles', 'write', service).allowed).toBe(true);
  });
});

describe('owner-scoped data', () => {
  // Postgres has `allow all` on signal_history today: any holder of the anon
  // key can read AND overwrite any account's trade history. Same for `users`,
  // which carries role, VIP expiry and the device binding.
  for (const t of ['signal_history', 'users']) {
    it(`gives ${t} to its owner and nobody else`, () => {
      const d = decide(t, 'read', user('acct-1'));
      expect(d.allowed).toBe(true);
      expect(d.scope?.value).toBe('acct-1');
    });

    it(`refuses ${t} to an unidentified caller`, () => {
      expect(decide(t, 'read', pub).allowed).toBe(false);
      expect(decide(t, 'write', pub).allowed).toBe(false);
    });

    it(`scopes ${t} by a real column`, () => {
      // An owner rule with no column can scope nothing. Falling back to
      // unscoped would hand every row to whoever asked, so it must refuse.
      expect(POLICY[t]!.ownerColumn).toBeTruthy();
      expect(SQL).toContain(POLICY[t]!.ownerColumn!);
    });
  }

  it('scopes each caller to their OWN id, never a shared one', () => {
    expect(decide('signal_history', 'read', user('a')).scope?.value).toBe('a');
    expect(decide('signal_history', 'read', user('b')).scope?.value).toBe('b');
  });

  it('names an owner column on EVERY owner-scoped table', () => {
    // `decide` refuses an `owner` rule with no column rather than falling back
    // to unscoped — but a refusal at request time is an outage, not a fix. This
    // is the check that stops the misconfiguration from shipping at all.
    const unscoped = Object.entries(POLICY)
      .filter(([, p]) => (p.read === 'owner' || p.write === 'owner') && !p.ownerColumn)
      .map(([t]) => t);
    expect(unscoped, `owner-scoped with no column: ${unscoped.join(', ')}`).toEqual([]);
  });

  it('does not hand an owner table to a caller with no account', () => {
    // The two kinds that carry no account id at all. Neither may be scoped to
    // anything, so neither may be allowed by an `owner` rule.
    expect(decide('users', 'read', pub).allowed).toBe(false);
    expect(decide('users', 'read', pub).reason).toContain('signed-in');
  });
});

describe('rank', () => {
  it('lets a stronger caller satisfy a weaker rule', () => {
    expect(decide('pairs', 'write', service).allowed).toBe(true);   // admin rule
    expect(decide('telegram_queue', 'read', service).allowed).toBe(true);
  });

  it('does not let a weaker one satisfy a stronger rule', () => {
    expect(decide('telegram_queue', 'read', user()).allowed).toBe(false);
    expect(decide('repair_log', 'read', pub).allowed).toBe(false);
  });

  it('never lets rank override `never`', () => {
    // Rank is an ordering, not an override. `never` is outside it.
    expect(decide('push_subscriptions', 'read', service).allowed).toBe(false);
  });
});

describe('the inventory — every table has a decision', () => {
  /** Table names as the schema actually declares them. */
  const inSchema = (): string[] =>
    [...SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!).sort();

  it('governs every table in the schema', () => {
    const missing = inSchema().filter((t) => POLICY[t] === undefined);
    expect(missing, `tables with no access rule: ${missing.join(', ')}`).toEqual([]);
  });

  it('governs nothing that is not in the schema', () => {
    // A rule for a table that no longer exists is a rule nobody is maintaining,
    // and it hides the fact that the real table went somewhere else.
    const schema = inSchema();
    const stale = GOVERNED.filter((t) => !schema.includes(t));
    expect(stale, `rules for tables that do not exist: ${stale.join(', ')}`).toEqual([]);
  });

  it('covers all twenty', () => {
    expect(inSchema()).toHaveLength(20);
    expect(GOVERNED).toHaveLength(20);
  });
});

describe('the schema avoids the two types SQLite does not have', () => {
  it('stores time as integer milliseconds, never text', () => {
    // '2026-09-16T12:00:00Z' < '2026-09-16T9:00:00Z' is TRUE as text, so a
    // pruning query written that way deletes the wrong rows and succeeds.
    expect(SQL).not.toMatch(/\btimestamptz\b/i);
    expect(SQL).not.toMatch(/\w+_at\s+TEXT/i);
    const timeCols = [...SQL.matchAll(/(\w+_ms)\s+INTEGER/g)].map((m) => m[1]!);
    expect(timeCols.length).toBeGreaterThan(10);
  });

  it('checks that every JSON column really holds JSON', () => {
    // Without the CHECK, a failed serialisation writes "[object Object]" and
    // every later read returns it without complaint.
    expect(SQL).not.toMatch(/\bjsonb\b/i);
    const jsonCols = SQL.match(/json_valid\(/g) ?? [];
    expect(jsonCols.length).toBeGreaterThanOrEqual(12);
  });

  it('keeps the uniqueness the duplicate guards depend on', () => {
    // `record_signals` relies on ON CONFLICT DO NOTHING against this index. No
    // index, no conflict, and the same signal is recorded twice under load.
    expect(SQL).toContain('signals_identity');
    expect(SQL).toMatch(/UNIQUE INDEX[^;]*signals \(strategy_version_id, symbol, timeframe, bar_ms\)/);
  });

  it('keeps both catalogues closed by default', () => {
    // A symbol the platform starts advertising tomorrow arrives switched off.
    expect(SQL).toMatch(/otc_pairs[\s\S]*?enabled\s+INTEGER NOT NULL DEFAULT 0/);
    expect(SQL).toMatch(/pairs[\s\S]*?enabled\s+INTEGER NOT NULL DEFAULT 0/);
  });
});
