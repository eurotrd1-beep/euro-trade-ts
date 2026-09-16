/**
 * The three modes, and the one rule that makes the migration reversible.
 *
 * ── WHAT IS ACTUALLY BEING CHECKED ─────────────────────────────────────────
 *
 * That a fallback to Supabase happens in `mirror` and never in `d1`.
 *
 * It sounds like a detail and it is the whole safety argument. In `mirror` the
 * two databases hold the same rows, so falling back is invisible and correct.
 * In `d1` they have diverged: writes are landing in D1 while Supabase gets
 * staler by the hour, and a fallback would serve that stale answer with no
 * indication it was stale. A user's trade history would simply stop growing,
 * every screen would render, and nothing would be reported.
 *
 * So the `d1` cases below assert an ERROR — the one place in this codebase
 * where refusing to answer is the safe behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseCalls: string[] = [];

/** A Supabase client that records what was asked of it. */
vi.mock('@euro/shared', () => {
  const chain = (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      upsert: async () => { supabaseCalls.push(`upsert:${table}`); return { error: null }; },
      update: () => q,
      then: (resolve: (v: unknown) => unknown) => {
        supabaseCalls.push(`read:${table}`);
        return Promise.resolve(resolve({ data: [{ from: 'supabase' }], error: null, count: 7 }));
      },
    };
    return q;
  };
  return { supabase: () => ({ from: (table: string) => chain(table) }) };
});

const {
  db, configureDataSource, currentMode, hubStats, setDataAccount, dbBool,
} = await import('../lib/dataHub.js');

const HUB = 'https://data.example.com';
let fetchMock: ReturnType<typeof vi.fn>;

const hubOk = (rows: unknown[]) =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ rows }) });
const hubFail = (status = 500, error = 'query failed') =>
  Promise.resolve({ ok: false, status, json: async () => ({ error }) });

beforeEach(() => {
  supabaseCalls.length = 0;
  hubStats.reads = 0; hubStats.fallbacks = 0; hubStats.errors = 0; hubStats.lastError = '';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setDataAccount(null);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the mode comes from the config row', () => {
  it('defaults to Supabase when the row says nothing', () => {
    configureDataSource(undefined);
    expect(currentMode()).toBe('supabase');
    configureDataSource({});
    expect(currentMode()).toBe('supabase');
  });

  it('refuses to leave Supabase without a hub url', () => {
    // A half-filled row — a mode set, a url forgotten — must not take the app
    // off the database that works. It would be a wall of failed reads with a
    // cause nobody could see from the outside.
    configureDataSource({ mode: 'd1' });
    expect(currentMode()).toBe('supabase');
    expect(hubStats.lastError).toContain('no url');
  });

  it('ignores a mode nobody defined', () => {
    configureDataSource({ mode: 'postgres-but-faster', url: HUB });
    expect(currentMode()).toBe('supabase');
  });

  it('accepts the two real ones', () => {
    configureDataSource({ mode: 'mirror', url: HUB });
    expect(currentMode()).toBe('mirror');
    configureDataSource({ mode: 'd1', url: HUB });
    expect(currentMode()).toBe('d1');
  });
});

describe('supabase mode', () => {
  beforeEach(() => configureDataSource({ mode: 'supabase' }));

  it('never touches the hub, even for a read', async () => {
    const { data } = await db().from('candles').select('*').eq('key', 'EURUSD_otc_1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data).toEqual([{ from: 'supabase' }]);
  });

  it('is what rollback means: one row edit and nothing else changes', async () => {
    configureDataSource({ mode: 'd1', url: HUB });
    configureDataSource({ mode: 'supabase' });
    await db().from('users').select('*').eq('id', 'alice');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(supabaseCalls).toEqual(['read:users']);
  });
});

describe('mirror mode reads D1 and falls back', () => {
  beforeEach(() => configureDataSource({ mode: 'mirror', url: HUB }));

  it('reads from the hub when the hub answers', async () => {
    fetchMock.mockReturnValue(hubOk([{ from: 'd1' }]));
    const { data } = await db().from('candles').select('*');
    expect(data).toEqual([{ from: 'd1' }]);
    expect(supabaseCalls).toEqual([]);
  });

  it('falls back to Supabase when it does not', async () => {
    fetchMock.mockReturnValue(hubFail());
    const { data, error } = await db().from('candles').select('*');
    // Both databases hold the same rows in this mode, so the user sees the
    // right answer and no error at all.
    expect(error).toBeNull();
    expect(data).toEqual([{ from: 'supabase' }]);
    expect(supabaseCalls).toEqual(['read:candles']);
  });

  it('counts the fallback instead of hiding it', async () => {
    fetchMock.mockReturnValue(hubFail(503, 'upstream down'));
    await db().from('pairs').select('*');
    expect(hubStats.fallbacks).toBe(1);
    expect(hubStats.lastError).toContain('pairs');
    // A migration judged by "it seems fine" is a migration finished on a
    // feeling. The health screen reads this.
    expect(hubStats.lastError).toContain('503');
  });

  it('falls back when the network throws, not just on a bad status', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { data } = await db().from('configs').select('*');
    expect(data).toEqual([{ from: 'supabase' }]);
    expect(hubStats.fallbacks).toBe(1);
  });

  it('still WRITES to Supabase — that is what makes the fallback safe', async () => {
    fetchMock.mockReturnValue(hubOk([]));
    await db().from('signal_history').upsert({ account_id: 'alice', signals: '[]' });
    expect(supabaseCalls).toEqual(['upsert:signal_history']);
    // The write did not go to the hub. If it had, the two databases would
    // diverge and the read fallback would start returning stale rows.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('d1 mode does NOT fall back', () => {
  beforeEach(() => configureDataSource({ mode: 'd1', url: HUB }));

  it('returns an error rather than a stale answer', async () => {
    fetchMock.mockReturnValue(hubFail());
    const { data, error } = await db().from('signal_history').select('*');
    expect(error).toBeTruthy();
    expect(data).toBeNull();
    // The important half: Supabase was never asked. By now it is behind, and
    // its answer would look exactly like a current one.
    expect(supabaseCalls).toEqual([]);
    expect(hubStats.fallbacks).toBe(0);
    expect(hubStats.errors).toBe(1);
  });

  it('sends writes to the hub and nowhere else', async () => {
    fetchMock.mockReturnValue(Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    await db().from('signal_history').upsert({ signals: '[]' });
    expect(supabaseCalls).toEqual([]);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({ op: 'upsert' });
  });

  it('never double-writes when a write fails', async () => {
    // A write that lands in one database and not the other is a divergence,
    // and afterwards neither side knows which one is wrong.
    fetchMock.mockReturnValue(hubFail(403, 'forbidden'));
    const { error } = await db().from('signal_history').upsert({ signals: '[]' });
    expect(error).toBeTruthy();
    expect(supabaseCalls).toEqual([]);
  });
});

describe('the request the hub receives', () => {
  beforeEach(() => configureDataSource({ mode: 'd1', url: HUB }));

  it('carries the filters, the order and the limit', async () => {
    fetchMock.mockReturnValue(hubOk([]));
    await db().from('signals').select('id,symbol').eq('outcome', 'win')
      .order('created_ms', { ascending: false }).limit(25);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v1/signals');
    expect(url.searchParams.get('cols')).toBe('id,symbol');
    expect(url.searchParams.getAll('eq')).toEqual(['outcome:win']);
    expect(url.searchParams.get('order')).toBe('created_ms.desc');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('asks for a count without asking for the rows', async () => {
    fetchMock.mockReturnValue(hubOk([{ count: 42 }]));
    const { count } = await db().from('users').select('id', { count: 'exact' });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('count')).toBe('1');
    expect(count).toBe(42);
  });

  it('sends the account id only once there is one', async () => {
    fetchMock.mockReturnValue(hubOk([]));
    await db().from('candles').select('*');
    expect((fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers)
      .not.toHaveProperty('x-account-id');

    setDataAccount('alice');
    await db().from('signal_history').select('*');
    expect((fetchMock.mock.calls[1]![1] as { headers: Record<string, string> }).headers)
      .toMatchObject({ 'x-account-id': 'alice' });
  });

  it('does not let a trailing slash on the url double up', async () => {
    configureDataSource({ mode: 'd1', url: `${HUB}/` });
    fetchMock.mockReturnValue(hubOk([]));
    await db().from('candles').select('*');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/candles');
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('//v1');
  });
});

/**
 * The boolean that would have unbanned everyone.
 *
 * SQLite has no boolean type, so `true` in Postgres comes back from D1 as the
 * number 1 — and `1 === true` is false. Two checks in the app were written
 * exactly that way, and the day the mode flipped they would have let every
 * banned account back in and switched guaranteed-win off for everyone holding
 * it. No error, no log line; the values would simply have been false.
 */
describe('dbBool reads a boolean from either database', () => {
  it('accepts what Postgres sends', () => {
    expect(dbBool(true)).toBe(true);
    expect(dbBool(false)).toBe(false);
  });

  it('accepts what D1 sends', () => {
    expect(dbBool(1)).toBe(true);
    expect(dbBool(0)).toBe(false);
  });

  it('is the check `=== true` is not', () => {
    // The whole point, stated as an assertion so it cannot quietly regress.
    expect(1 === (true as unknown)).toBe(false);
    expect(dbBool(1)).toBe(true);
  });

  it('treats anything unrecognised as false', () => {
    // A ban flag that cannot be read must not read as "banned" — an outage
    // would lock out every user at once. Guaranteed-win defaulting off is the
    // safe direction too.
    for (const v of [null, undefined, {}, [], 'yes', '']) {
      expect(dbBool(v)).toBe(false);
    }
  });

  it('accepts the string forms a config row might hold', () => {
    expect(dbBool('true')).toBe(true);
    expect(dbBool('t')).toBe(true);
    expect(dbBool('1')).toBe(true);
    expect(dbBool('false')).toBe(false);
  });
});
