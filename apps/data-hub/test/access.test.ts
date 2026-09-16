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
const SQL = SCHEMA
  .split('\n')
  // Trailing comments too, not just whole-comment lines: a column carrying
  // `-- was timestamptz vip_expiry` is documentation of the conversion, and a
  // check that reads it as the banned type is reading the note, not the column.
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

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

/**
 * Every place the admin panel relies on reading or writing rows that are not
 * its own, found by reading the panel rather than by guessing. Closing `users`
 * to owner-only is the right fix for the public, and it would take the whole
 * admin down with it unless the admin arrives as an admin.
 *
 * Each case names the file, so a future change to the panel can be checked
 * against the rule instead of discovered in production.
 */
describe('what the admin panel actually does', () => {
  it('lists every user — app/admin/page.tsx:38', () => {
    const d = decide('users', 'read', admin);
    expect(d.allowed).toBe(true);
    // No scope. An admin list scoped to one account would render one row and
    // look like an empty database rather than a refusal.
    expect(d.scope).toBeUndefined();
  });

  it('patches any user by id — app/admin/page.tsx:57 (ban, role, guaranteed_win)', () => {
    expect(decide('users', 'write', admin).allowed).toBe(true);
    expect(decide('users', 'write', admin).scope).toBeUndefined();
  });

  it('grants and revokes VIP in bulk — app/admin/vip/page.tsx:78,102,133', () => {
    // `.in('id', batch)` touches up to BATCH_SIZE rows at once, none of them
    // the caller's own.
    expect(decide('users', 'write', admin).allowed).toBe(true);
    expect(decide('users', 'read', admin).allowed).toBe(true);
  });

  it('counts guaranteed-win accounts — lib/healthChecks.ts:1101', () => {
    expect(decide('users', 'read', admin).allowed).toBe(true);
  });

  it('reads the analytics counters — clicks', () => {
    expect(decide('clicks', 'read', admin).allowed).toBe(true);
  });

  it('keeps the public OUT of all of it', () => {
    // The same five operations, from a browser with no admin credential. This
    // is the hole being closed: today every one of them succeeds with the
    // public anon key, so anyone can grant themselves VIP or ban an account.
    expect(decide('users', 'read', pub).allowed).toBe(false);
    expect(decide('users', 'write', pub).allowed).toBe(false);
    expect(decide('clicks', 'read', pub).allowed).toBe(false);
    expect(decide('clicks', 'write', pub).allowed).toBe(false);
  });

  it('keeps a signed-in USER out of it too', () => {
    // An account id is typed, not proven. Whatever it buys must stop at that
    // account's own rows — a user reaching the admin's view of `users` would
    // be the same hole with an extra header.
    const d = decide('users', 'read', user('acct-1'));
    expect(d.allowed).toBe(true);
    expect(d.scope).toEqual({ column: 'id', value: 'acct-1' });
    expect(decide('clicks', 'read', user('acct-1')).allowed).toBe(false);
    expect(decide('telegram_queue', 'read', user('acct-1')).allowed).toBe(false);
  });
});

/**
 * The user's own app, which must keep working unchanged after the close.
 * Each of these is scoped by `.eq('id', accountId)` today, so `owner` is a
 * match rather than a restriction — but that is worth a test, because if any
 * of them broke, the symptom is a user who cannot sign in.
 */
describe('what the user app actually does', () => {
  it('reads its own account row — lib/auth.ts:92, lib/boot.ts:50, lib/realtime.ts:183', () => {
    expect(decide('users', 'read', user('acct-1')).scope?.value).toBe('acct-1');
  });

  it('writes its own device binding and broker — lib/auth.ts:123,133', () => {
    const d = decide('users', 'write', user('acct-1'));
    expect(d.allowed).toBe(true);
    expect(d.scope).toEqual({ column: 'id', value: 'acct-1' });
  });

  it('reads and writes its own trade history — lib/signalHistoryStore.ts', () => {
    expect(decide('signal_history', 'read', user('acct-1')).scope?.value).toBe('acct-1');
    expect(decide('signal_history', 'write', user('acct-1')).scope?.value).toBe('acct-1');
  });

  it('still reads candles, pairs, configs and brokers with no credential', () => {
    // The app reads these before anyone has signed in. Closing them would put
    // a blank chart behind the login screen.
    for (const t of ['candles', 'pairs', 'configs', 'brokers']) {
      expect(decide(t, 'read', pub).allowed).toBe(true);
    }
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
