/**
 * The shim's job is that a call site cannot tell which database answered.
 *
 * Three things break that promise quietly, and all three were live:
 *
 *   1. `maybeSingle()` handed back `[row]` through the hub and `row` through
 *      Supabase. Nothing threw — call sites just read `undefined` out of the
 *      wrong shape, rendered an empty form, and saved the empty form back.
 *
 *   2. `users` rows came out of D1 carrying `vip_expiry_ms`, while every reader
 *      asks for `vip_expiry`. A renamed column does not throw; it answers
 *      undefined, and undefined reads as "this VIP account has no expiry".
 *
 *   3. An UPDATE or DELETE whose filter chain was never given a `.eq()` is the
 *      whole table.
 *
 * None of these are caught by the mode tests next door, because every one of
 * them returns a successful-looking result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseCalls: string[] = [];

vi.mock('@euro/shared', () => {
  const chain = (table: string) => {
    const q = {
      select: () => q,
      eq: (c: string, v: string) => { supabaseCalls.push(`eq:${c}=${v}`); return q; },
      in: (c: string, v: string[]) => { supabaseCalls.push(`in:${c}=${v.join('|')}`); return q; },
      order: () => q,
      limit: () => q,
      insert: async () => { supabaseCalls.push(`insert:${table}`); return { error: null }; },
      upsert: async () => { supabaseCalls.push(`upsert:${table}`); return { error: null }; },
      update: () => { supabaseCalls.push(`update:${table}`); return q; },
      delete: () => { supabaseCalls.push(`delete:${table}`); return q; },
      then: (resolve: (v: unknown) => unknown) => {
        supabaseCalls.push(`read:${table}`);
        return Promise.resolve(resolve({ data: [{ from: 'supabase' }], error: null }));
      },
    };
    return q;
  };
  return { supabase: () => ({ from: (table: string) => chain(table) }) };
});

vi.mock('../lib/adminAuth', () => ({ adminSecret: () => held }));
let held: string | null = null;

const { db, configureDataSource, hubStats } = await import('../lib/dataHub.js');

const HUB = 'https://data.example.com';
let fetchMock: ReturnType<typeof vi.fn>;

const hubOk = (rows: unknown[]) =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ rows }) });

beforeEach(() => {
  supabaseCalls.length = 0;
  held = null;
  hubStats.errors = 0; hubStats.lastError = '';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  configureDataSource({ mode: 'd1', url: HUB });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The URL of the nth fetch, so a test can read what was actually asked for. */
const urlOf = (n = 0): string => String(fetchMock.mock.calls[n]![0]);
const initOf = (n = 0) => fetchMock.mock.calls[n]![1] as RequestInit;
const bodyOf = (n = 0) => JSON.parse(String(initOf(n).body)) as Record<string, unknown>;

describe('maybeSingle returns a row, not a list', () => {
  it('unwraps the first row', async () => {
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'promo', data: { title: 'hi' } }]));
    const { data } = await db().from('clicks').select('data').eq('id', 'promo').maybeSingle();
    // The shape every call site has always assumed.
    expect(data?.['data']).toEqual({ title: 'hi' });
  });

  it('is null when there is no row, not an empty array', async () => {
    // `[]` is truthy. A caller checking `if (row)` would have carried on into
    // code that reads fields off an empty array and finds undefined in each.
    fetchMock.mockReturnValueOnce(hubOk([]));
    const { data } = await db().from('clicks').select('data').eq('id', 'nope').maybeSingle();
    expect(data).toBeNull();
  });

  it('asks for exactly one row', async () => {
    fetchMock.mockReturnValueOnce(hubOk([]));
    await db().from('clicks').select('data').eq('id', 'promo').maybeSingle();
    expect(urlOf()).toContain('limit=1');
  });

  it('leaves select() returning a list', async () => {
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'a' }, { id: 'b' }]));
    const { data } = await db().from('pairs').select('*');
    expect(data).toHaveLength(2);
  });
});

describe('users rows come back in the shape the app reads', () => {
  it('maps vip_expiry_ms back to an ISO vip_expiry', async () => {
    const ms = Date.UTC(2026, 10, 1, 12, 0, 0);
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'u1', role: 'vip', vip_expiry_ms: ms }]));
    const { data } = await db().from('users').select('*').eq('id', 'u1').maybeSingle();
    expect(data?.['vip_expiry']).toBe(new Date(ms).toISOString());
    // And the D1 spelling is gone, so nothing downstream can read it by accident.
    expect(data).not.toHaveProperty('vip_expiry_ms');
  });

  it('maps created_ms the same way', async () => {
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'u1', created_ms: ms }]));
    const { data } = await db().from('users').select('*').eq('id', 'u1').maybeSingle();
    expect(data?.['created_at']).toBe(new Date(ms).toISOString());
  });

  it('turns a null expiry into null rather than 1970', async () => {
    // `new Date(null)` is the epoch, which reads as an expiry that passed
    // decades ago — it would strip VIP from an account that simply has no
    // expiry recorded.
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'u1', vip_expiry_ms: null }]));
    const { data } = await db().from('users').select('*').eq('id', 'u1').maybeSingle();
    expect(data?.['vip_expiry']).toBeNull();
  });

  it('leaves every other column alone', async () => {
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'u1', role: 'vip', is_banned: 1, device_id: 'd' }]));
    const { data } = await db().from('users').select('*').eq('id', 'u1').maybeSingle();
    expect(data).toMatchObject({ id: 'u1', role: 'vip', is_banned: 1, device_id: 'd' });
  });

  it('does not touch tables that are not users', async () => {
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'b1', created_ms: 5 }]));
    const { data } = await db().from('brokers').select('*').eq('id', 'b1').maybeSingle();
    expect(data?.['created_ms']).toBe(5);
  });
});

describe('an update or delete with no filter never leaves the browser', () => {
  it('refuses the update', async () => {
    const { error } = await db().from('users').update({ role: 'vip' }).run();
    expect(error?.message).toContain('no filter');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses the delete', async () => {
    const { error } = await db().from('pairs').delete().run();
    expect(error?.message).toContain('no filter');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses it in Supabase mode too, where nothing else would', async () => {
    // The hub refuses an unfiltered write; Postgres with open RLS does not.
    configureDataSource({ mode: 'supabase', url: HUB });
    const { error } = await db().from('pairs').delete().run();
    expect(error).not.toBeNull();
    expect(supabaseCalls).not.toContain('delete:pairs');
  });

  it('allows it once the rows are named', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    const { error } = await db().from('pairs').delete().eq('id', 'p1').run();
    expect(error).toBeNull();
    expect(bodyOf()).toMatchObject({ op: 'delete', where: [{ column: 'id', value: 'p1' }] });
  });
});

describe('naming many rows at once', () => {
  it('sends an IN list on a write', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    await db().from('users').update({ role: 'vip' }).in('id', ['a', 'b', 'c']).run();
    expect(bodyOf()).toMatchObject({
      op: 'update',
      values: { role: 'vip' },
      where: [{ column: 'id', values: ['a', 'b', 'c'] }],
    });
  });

  it('sends an IN list on a read', async () => {
    fetchMock.mockReturnValueOnce(hubOk([]));
    await db().from('users').select('id').in('id', ['a', 'b']);
    expect(decodeURIComponent(urlOf())).toContain('in=id:a,b');
  });

  it('keeps an empty list as a filter rather than dropping it', async () => {
    // Dropped, this becomes an unfiltered UPDATE — every user row.
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    const { error } = await db().from('users').update({ role: 'vip' }).in('id', []).run();
    expect(error).toBeNull();
    expect(bodyOf()).toMatchObject({ where: [{ column: 'id', values: [] }] });
  });

  it('passes an IN list through to Supabase as an IN, not a series of eq', async () => {
    configureDataSource({ mode: 'supabase', url: HUB });
    await db().from('users').update({ role: 'vip' }).in('id', ['a', 'b']).run();
    expect(supabaseCalls).toContain('in:id=a|b');
  });
});

describe('the admin secret rides along when this browser holds one', () => {
  it('is absent by default', async () => {
    fetchMock.mockReturnValueOnce(hubOk([]));
    await db().from('pairs').select('*');
    expect(initOf().headers).not.toHaveProperty('x-admin-secret');
  });

  it('is sent on reads and writes once signed in', async () => {
    held = 'a-secret';
    fetchMock.mockReturnValueOnce(hubOk([]));
    await db().from('pairs').select('*');
    expect((initOf().headers as Record<string, string>)['x-admin-secret']).toBe('a-secret');

    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    await db().from('pairs').update({ enabled: 1 }).eq('id', 'p1').run();
    expect((initOf(1).headers as Record<string, string>)['x-admin-secret']).toBe('a-secret');
  });
});

describe('the tables pinned to Supabase never reach the hub', () => {
  it('reads configs from Supabase even in d1 mode', async () => {
    // Pinned while the admin still wrote it with the anon key. The pin is what
    // keeps the app and the admin looking at the same row, and it is removed
    // in the same change that moves the admin writes.
    await db().from('configs').select('data').eq('id', 'promo').maybeSingle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(supabaseCalls).toContain('read:configs');
  });
});

describe('insert is not upsert', () => {
  it('sends op: insert', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    await db().from('brokers').insert({ id: 'b1', name: 'X' });
    expect(bodyOf()['op']).toBe('insert');
  });

  it('still says upsert when that is what was asked for', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    await db().from('brokers').upsert({ id: 'b1', name: 'X' });
    expect(bodyOf()['op']).toBe('upsert');
  });
});

describe('a boolean filter reaches each database in its own spelling', () => {
  it('becomes 1 on the way to D1, where there is no boolean type', async () => {
    // `enabled=eq.true` against a column holding 1 matches nothing, and
    // "no enabled pairs" is not an error — it is an empty backtest.
    fetchMock.mockReturnValueOnce(hubOk([]));
    await db().from('pairs').select('chart_symbol').eq('enabled', true);
    expect(decodeURIComponent(urlOf())).toContain('eq=enabled:1');
  });

  it('becomes 0 for false', async () => {
    fetchMock.mockReturnValueOnce(hubOk([]));
    await db().from('pairs').select('chart_symbol').eq('enabled', false);
    expect(decodeURIComponent(urlOf())).toContain('eq=enabled:0');
  });

  it('stays a real boolean on the way to Postgres', async () => {
    // The rollback target still has a `boolean` column, and '1' is not one.
    configureDataSource({ mode: 'supabase', url: HUB });
    await db().from('pairs').select('chart_symbol').eq('enabled', true);
    expect(supabaseCalls).toContain('eq:enabled=true');
  });
});

describe('a renamed column is translated in both directions', () => {
  it('orders by the D1 spelling', async () => {
    // `order=created_at` would be a 400 from the hub: there is no such column.
    fetchMock.mockReturnValueOnce(hubOk([]));
    await db().from('users').select('*').order('created_at', { ascending: false });
    expect(decodeURIComponent(urlOf())).toContain('order=created_ms.desc');
  });

  it('asks for the D1 spelling in cols', async () => {
    fetchMock.mockReturnValueOnce(hubOk([]));
    await db().from('users').select('id,vip_expiry');
    expect(decodeURIComponent(urlOf())).toContain('cols=id,vip_expiry_ms');
  });

  it('filters on the D1 spelling', async () => {
    fetchMock.mockReturnValueOnce(hubOk([]));
    await db().from('users').select('*').eq('vip_expiry', 123);
    expect(decodeURIComponent(urlOf())).toContain('eq=vip_expiry_ms:123');
  });

  it('leaves the Postgres spelling alone in Supabase mode', async () => {
    configureDataSource({ mode: 'supabase', url: HUB });
    await db().from('users').select('*').eq('vip_expiry', 123);
    expect(supabaseCalls).toContain('eq:vip_expiry=123');
  });

  it('translates a write filter too', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    await db().from('users').update({ role: 'standard' }).eq('vip_expiry', 1).run();
    expect(bodyOf()).toMatchObject({ where: [{ column: 'vip_expiry_ms', value: '1' }] });
  });
});

describe('jsonb columns survive the crossing to TEXT and back', () => {
  it('parses a config read out of D1', async () => {
    // Left alone this is the string '{"enabled":true}', and `data['enabled']`
    // on a string is undefined — an admin screen of switches, all off, which
    // then saves those offs over the real settings.
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'promo', data: '{"enabled":true,"title":"x"}' }]));
    const { data } = await db().from('clicks').select('*').eq('id', 'promo').maybeSingle();
    expect(data?.['data']).toEqual({ enabled: true, title: 'x' });
  });

  it('serialises one on the way in', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    await db().from('clicks').upsert({ id: 'promo', data: { views: 0, cta: 0 } });
    expect((bodyOf()['values'] as Record<string, unknown>)['data']).toBe('{"views":0,"cta":0}');
  });

  it('does not double-encode a value the caller already stringified', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    await db().from('clicks').upsert({ id: 'promo', data: '{"views":1}' });
    expect((bodyOf()['values'] as Record<string, unknown>)['data']).toBe('{"views":1}');
  });

  it('leaves a string that will not parse alone rather than nulling it', async () => {
    // Nulling would empty the row on the next save. The CHECK constraint makes
    // this near-impossible, which is exactly why the failure mode should be
    // "unchanged" and not "destroyed".
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'x', data: 'not json' }]));
    const { data } = await db().from('clicks').select('*').eq('id', 'x').maybeSingle();
    expect(data?.['data']).toBe('not json');
  });

  it('touches only the declared columns', async () => {
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'x', data: '{"a":1}', name: '{"b":2}' }]));
    const { data } = await db().from('clicks').select('*').eq('id', 'x').maybeSingle();
    expect(data?.['data']).toEqual({ a: 1 });
    expect(data?.['name']).toBe('{"b":2}');
  });

  it('leaves tables with no json column untouched', async () => {
    fetchMock.mockReturnValueOnce(hubOk([{ id: 'p1', data: '{"a":1}' }]));
    const { data } = await db().from('pairs').select('*').eq('id', 'p1').maybeSingle();
    expect(data?.['data']).toBe('{"a":1}');
  });

  it('is not applied on the Supabase path, where jsonb is already an object', async () => {
    configureDataSource({ mode: 'supabase', url: HUB });
    await db().from('clicks').upsert({ id: 'promo', data: { views: 0 } });
    expect(supabaseCalls).toContain('upsert:clicks');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
