/**
 * The data client, now that there is one database.
 *
 * ── WHAT THIS FILE USED TO BE ──────────────────────────────────────────────
 *
 * A test of three modes and one rule: a failed read fell back to Supabase in
 * `mirror` and never in `d1`. That rule was the whole safety argument of the
 * migration — in `mirror` both databases held the same rows so a fallback was
 * invisible and correct, while in `d1` they had diverged and the same fallback
 * would have served a stale answer with no sign it was stale.
 *
 * Postgres is gone, so the modes are gone, and the thing worth asserting is
 * what replaced them: a failed read is an ERROR. There is no second source, and
 * the one place in this codebase where refusing to answer is the safe behaviour
 * is still this one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { db, dbBool, hubStats, hubUrl, setDataAccount } = await import('../lib/dataHub.js');

let fetchMock: ReturnType<typeof vi.fn>;

const hubOk = (rows: unknown[]) =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ rows }) });
const hubFail = (status = 500, error = 'query failed') =>
  Promise.resolve({ ok: false, status, json: async () => ({ error }) });

beforeEach(() => {
  hubStats.reads = 0; hubStats.errors = 0; hubStats.lastError = '';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setDataAccount(null);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the address', () => {
  it('is built in, not read from a database', () => {
    // It came from `configs.data_source` in Postgres — a flag that could not
    // live in the database it controlled, because that is exactly the row you
    // need when that database is unreachable. With one database left it named
    // one thing, so it is a constant now and costs a rebuild to change.
    expect(hubUrl).toMatch(/^https:\/\/\S+$/);
    expect(hubUrl).not.toMatch(/\/$/);
  });
});

describe('a failed read is an error', () => {
  it('reports it rather than answering from somewhere else', async () => {
    fetchMock.mockReturnValue(hubFail());
    const { data, error } = await db().from('candles').select('*');
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(hubStats.errors).toBe(1);
    expect(hubStats.lastError).toContain('candles');
  });

  it('counts the attempt either way', async () => {
    fetchMock.mockReturnValue(hubOk([{ from: 'd1' }]));
    await db().from('candles').select('*');
    await db().from('pairs').select('*');
    expect(hubStats.reads).toBe(2);
    expect(hubStats.errors).toBe(0);
  });

  it('turns a thrown fetch into an error, not a crash', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { data, error } = await db().from('candles').select('*');
    expect(data).toBeNull();
    expect(error?.message).toContain('offline');
  });
});

describe('the request the hub receives', () => {
  const urlOf = (): string => String(fetchMock.mock.calls[0]![0]);

  it('names the columns, the filter, the order and the limit', async () => {
    fetchMock.mockReturnValue(hubOk([]));
    await db().from('candles').select('key,data').eq('key', 'EURUSD_otc_1m')
      .order('key', { ascending: false }).limit(5);
    const u = decodeURIComponent(urlOf());
    expect(u).toContain('/v1/candles');
    expect(u).toContain('cols=key,data');
    expect(u).toContain('eq=key:EURUSD_otc_1m');
    expect(u).toContain('order=key.desc');
    expect(u).toContain('limit=5');
  });

  it('sends the account id as a claim, so an owner-scoped read is possible', async () => {
    // Not a credential: the hub scopes to it and refuses everything else
    // regardless. Without it there is no way to ask for your own rows at all.
    setDataAccount('acct-1');
    fetchMock.mockReturnValue(hubOk([]));
    await db().from('signal_history').select('*');
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-account-id']).toBe('acct-1');
  });

  it('omits the account header when nobody is signed in', async () => {
    fetchMock.mockReturnValue(hubOk([]));
    await db().from('pairs').select('*');
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-account-id');
  });

  it('asks for a count without asking for the rows', async () => {
    fetchMock.mockReturnValue(hubOk([{ count: 7 }]));
    const { count } = await db().from('users').select('id', { count: 'exact' });
    expect(decodeURIComponent(urlOf())).toContain('count=1');
    expect(count).toBe(7);
  });
});

describe('dbBool reads a boolean whichever way it is stored', () => {
  it('accepts 1 and true', () => {
    // SQLite has no boolean. `=== true` here would let every banned account
    // straight back in, because the column holds 1.
    expect(dbBool(1)).toBe(true);
    expect(dbBool(true)).toBe(true);
  });

  it('accepts 0, false, null and undefined as false', () => {
    expect(dbBool(0)).toBe(false);
    expect(dbBool(false)).toBe(false);
    expect(dbBool(null)).toBe(false);
    expect(dbBool(undefined)).toBe(false);
  });

  it('does not treat a stray string as true', () => {
    expect(dbBool('false')).toBe(false);
    expect(dbBool('')).toBe(false);
  });
});
