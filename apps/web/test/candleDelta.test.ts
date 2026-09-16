/**
 * The candle window is fetched as a delta and reassembled whole.
 *
 * `/api/otc/candles` was replying with a hundred candles every fifteen seconds
 * when at most one had changed — 1,243 bytes gzipped where 130 would do. It
 * takes `?since=<t>` now and replies with that candle and anything after it.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * Because the failure mode is silent. A merge that drops a candle, keeps a
 * stale copy of the forming bar, or interleaves two timeframes does not throw —
 * it hands the strategy an array that still looks like candles, and the wrong
 * signals come out the other end with nothing in the logs. The whole point of
 * doing the reassembly in `candles.ts` rather than in the engine binding is
 * that the engine keeps receiving exactly what it always received; these tests
 * are what says that is true.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCandles, fetchCandlesBulk, fetchOtcStatus, resetCandleCache, resetStatusCache } from '@/lib/candles';

vi.mock('@euro/shared', () => ({ getProxyUrl: () => 'https://proxy.test' }));

interface Raw { o: number; h: number; l: number; c: number; t: number }
const bar = (t: number, c: number): Raw => ({ o: c, h: c + 0.001, l: c - 0.001, c, t });

/** Every URL the code asked for, in order. */
let calls: string[] = [];
/** The `symbols=` parameter of a bulk call, decoded — `https://` has a colon. */
const symbolsOf = (url: string): string =>
  decodeURIComponent(new URL(url).searchParams.get('symbols') ?? '');
/** Queue of replies, one per call. */
let replies: Array<{ candles: Raw[]; full?: boolean } | null> = [];

beforeEach(() => {
  calls = [];
  replies = [];
  resetCandleCache();
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);
    const next = replies.shift();
    if (next === undefined || next === null) return Promise.resolve({ status: 500 });
    return Promise.resolve({ status: 200, json: () => Promise.resolve(next) });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetCandleCache();
  resetStatusCache();
});

const T = 1_780_000_000; // seconds
const MIN = 60;

describe('the first fetch', () => {
  it('asks for no window and takes what it is given', async () => {
    replies = [{ candles: [bar(T, 1.1), bar(T + MIN, 1.2)], full: true }];
    const out = await fetchCandles('EURUSD_otc', '1m');

    expect(calls[0]).not.toContain('since=');
    expect(out?.map((c) => c.time)).toEqual([T * 1000, (T + MIN) * 1000]);
  });
});

describe('the second fetch', () => {
  it('asks from the newest candle it holds', async () => {
    replies = [
      { candles: [bar(T, 1.1), bar(T + MIN, 1.2)], full: true },
      { candles: [bar(T + MIN, 1.25), bar(T + 2 * MIN, 1.3)], full: false },
    ];
    await fetchCandles('EURUSD_otc', '1m');
    await fetchCandles('EURUSD_otc', '1m');

    expect(calls[1]).toContain(`since=${T + MIN}`);
  });

  it('replaces the overlap candle instead of keeping the stale one', async () => {
    // The newest bar was still forming when we first saw it. The server's copy
    // is the newer truth — keeping ours would freeze the live candle on screen
    // and feed the strategy a close that never happened.
    replies = [
      { candles: [bar(T, 1.1), bar(T + MIN, 1.2)], full: true },
      { candles: [bar(T + MIN, 1.25), bar(T + 2 * MIN, 1.3)], full: false },
    ];
    await fetchCandles('EURUSD_otc', '1m');
    const out = await fetchCandles('EURUSD_otc', '1m');

    expect(out).toHaveLength(3);
    expect(out?.[1]?.close).toBe(1.25);
    expect(out?.map((c) => c.time)).toEqual([T, T + MIN, T + 2 * MIN].map((x) => x * 1000));
  });

  it('returns the whole window, not the delta', async () => {
    // What the engine gets must be indistinguishable from the old behaviour.
    replies = [
      { candles: Array.from({ length: 40 }, (_, i) => bar(T + i * MIN, 1 + i / 1000)), full: true },
      { candles: [bar(T + 39 * MIN, 1.039), bar(T + 40 * MIN, 1.04)], full: false },
    ];
    await fetchCandles('EURUSD_otc', '1m');
    const out = await fetchCandles('EURUSD_otc', '1m');
    expect(out).toHaveLength(41);
  });

  it('stays sorted and free of duplicates however the delta arrives', async () => {
    replies = [
      { candles: [bar(T, 1.1), bar(T + MIN, 1.2)], full: true },
      // Out of order and re-sending a candle we already hold.
      { candles: [bar(T + 2 * MIN, 1.3), bar(T + MIN, 1.25), bar(T, 1.11)], full: false },
    ];
    await fetchCandles('EURUSD_otc', '1m');
    const out = await fetchCandles('EURUSD_otc', '1m')!;

    const times = out!.map((c) => c.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });
});

describe('when the server says start again', () => {
  it('throws the held window away on full: true', async () => {
    // The window rolled past the candle we asked from. Merging would splice a
    // gap into the middle of the array and nothing downstream would notice.
    replies = [
      { candles: [bar(T, 1.1), bar(T + MIN, 1.2)], full: true },
      { candles: [bar(T + 50 * MIN, 1.5), bar(T + 51 * MIN, 1.6)], full: true },
    ];
    await fetchCandles('EURUSD_otc', '1m');
    const out = await fetchCandles('EURUSD_otc', '1m');

    expect(out).toHaveLength(2);
    expect(out?.[0]?.time).toBe((T + 50 * MIN) * 1000);
  });

  it('treats a reply with no `full` field as a whole window', async () => {
    // A proxy too old to know about `since` answers the way it always did.
    // Merging that onto a held buffer would resurrect rolled-off candles.
    replies = [
      { candles: [bar(T, 1.1), bar(T + MIN, 1.2)] },
      { candles: [bar(T + 5 * MIN, 1.5)] },
    ];
    await fetchCandles('EURUSD_otc', '1m');
    const out = await fetchCandles('EURUSD_otc', '1m');
    expect(out).toHaveLength(1);
  });
});

describe('the cache key', () => {
  it('never merges one timeframe onto another', async () => {
    // Two candle grids folded into one array would look sorted and be nonsense.
    replies = [
      { candles: [bar(T, 1.1), bar(T + MIN, 1.2)], full: true },
      { candles: [bar(T, 1.1), bar(T + 5 * MIN, 1.5)], full: true },
    ];
    await fetchCandles('EURUSD_otc', '1m');
    await fetchCandles('EURUSD_otc', '5m');

    // The 5m call must not carry the 1m window's `since`.
    expect(calls[1]).not.toContain('since=');
  });

  it('never merges one symbol onto another', async () => {
    replies = [
      { candles: [bar(T, 1.1)], full: true },
      { candles: [bar(T, 190.5)], full: true },
    ];
    await fetchCandles('EURUSD_otc', '1m');
    await fetchCandles('USDJPY_otc', '1m');
    expect(calls[1]).not.toContain('since=');
  });
});

describe('failure', () => {
  it('returns null and keeps the buffer when the request fails', async () => {
    replies = [{ candles: [bar(T, 1.1), bar(T + MIN, 1.2)], full: true }, null];
    await fetchCandles('EURUSD_otc', '1m');
    expect(await fetchCandles('EURUSD_otc', '1m')).toBeNull();

    // And the next success still merges onto the window we held throughout.
    replies = [{ candles: [bar(T + MIN, 1.22), bar(T + 2 * MIN, 1.3)], full: false }];
    const out = await fetchCandles('EURUSD_otc', '1m');
    expect(out).toHaveLength(3);
  });

  it('returns null on an empty payload rather than wiping the engine', async () => {
    replies = [{ candles: [], full: true }];
    expect(await fetchCandles('EURUSD_otc', '1m')).toBeNull();
  });
});

describe('the bulk sweep', () => {
  it('asks plainly the first time and gets whole windows', async () => {
    replies = [{ candles: { A: [bar(T, 1)], B: [bar(T, 2)] }, full: { A: true, B: true } } as never];
    const out = await fetchCandlesBulk(['A', 'B'], '1m');

    expect(symbolsOf(calls[0]!)).toBe('A,B');
    expect(out.get('A')).toHaveLength(1);
    expect(out.get('B')).toHaveLength(1);
  });

  it('carries a since PER SYMBOL on the next sweep', async () => {
    // One shared timestamp cannot work: pairs tick at different moments, so
    // their newest candles differ and one `since` is wrong for all but one.
    replies = [
      { candles: { A: [bar(T, 1)], B: [bar(T + MIN, 2)] }, full: { A: true, B: true } } as never,
      { candles: {}, full: {} } as never,
    ];
    await fetchCandlesBulk(['A', 'B'], '1m');
    await fetchCandlesBulk(['A', 'B'], '1m');

    expect(symbolsOf(calls[1]!)).toBe(`A:${T},B:${T + MIN}`);
  });

  it('extends the held window with a delta', async () => {
    replies = [
      { candles: { A: [bar(T, 1), bar(T + MIN, 2)] }, full: { A: true } } as never,
      { candles: { A: [bar(T + MIN, 2.5), bar(T + 2 * MIN, 3)] }, full: { A: false } } as never,
    ];
    await fetchCandlesBulk(['A'], '1m');
    const out = await fetchCandlesBulk(['A'], '1m');

    expect(out.get('A')).toHaveLength(3);
    expect(out.get('A')?.[1]?.close).toBe(2.5);   // the forming bar was replaced
  });

  it('replaces the window when the server says full', async () => {
    replies = [
      { candles: { A: [bar(T, 1), bar(T + MIN, 2)] }, full: { A: true } } as never,
      { candles: { A: [bar(T + 50 * MIN, 9)] }, full: { A: true } } as never,
    ];
    await fetchCandlesBulk(['A'], '1m');
    const out = await fetchCandlesBulk(['A'], '1m');
    expect(out.get('A')).toHaveLength(1);
  });

  it('treats a proxy with no `full` map as sending whole windows', async () => {
    // Older proxy. Merging its window onto a held one would resurrect candles
    // it has already rolled off.
    replies = [
      { candles: { A: [bar(T, 1), bar(T + MIN, 2)] } } as never,
      { candles: { A: [bar(T + 5 * MIN, 9)] } } as never,
    ];
    await fetchCandlesBulk(['A'], '1m');
    const out = await fetchCandlesBulk(['A'], '1m');
    expect(out.get('A')).toHaveLength(1);
  });

  it('shares its window with the single fetch, both ways', async () => {
    // Same cache, same merge — a pair fetched by either path leaves a window
    // the other can extend, so neither re-downloads what the other just had.
    replies = [
      { candles: { A: [bar(T, 1), bar(T + MIN, 2)] }, full: { A: true } } as never,
      { candles: [bar(T + MIN, 2.5), bar(T + 2 * MIN, 3)], full: false } as never,
    ];
    await fetchCandlesBulk(['A'], '1m');
    const out = await fetchCandles('A', '1m');

    expect(calls[1]).toContain(`since=${T + MIN}`);
    expect(out).toHaveLength(3);
  });

  it('keeps one timeframe out of another', async () => {
    replies = [
      { candles: { A: [bar(T, 1)] }, full: { A: true } } as never,
      { candles: { A: [bar(T, 1)] }, full: { A: true } } as never,
    ];
    await fetchCandlesBulk(['A'], '1m');
    await fetchCandlesBulk(['A'], '5m');
    expect(symbolsOf(calls[1]!)).toBe('A');
  });
});

describe('the status poll, shared between its two callers', () => {
  // `useOtcStatus` (20 s) and the engine's price poll (10 s) ask the same URL
  // for the same payload. At 315 bytes of body against 315 of response headers,
  // the second request costs almost what the first did.
  const statusBody = [
    { id: 'otc_prices', data: { A: { p: 1.5, o: true, t: T, st: 'live', po: true, no: 0 } } },
  ];

  it('joins a request already in flight instead of making a second', async () => {
    let started = 0;
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      started++;
      return new Promise((res) =>
        setTimeout(() => res({ status: 200, headers: new Map(), json: () => Promise.resolve(statusBody) }), 10),
      );
    });
    resetStatusCache();

    const [a, b] = await Promise.all([fetchOtcStatus('A'), fetchOtcStatus('A')]);
    expect(started).toBe(1);
    expect(a).toBe(b); // literally the same object — zero staleness
  });

  it('reuses a fresh result rather than asking again', async () => {
    let started = 0;
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      started++;
      return Promise.resolve({ status: 200, headers: new Map(), json: () => Promise.resolve(statusBody) });
    });
    resetStatusCache();

    await fetchOtcStatus('A');
    await fetchOtcStatus('A');
    await fetchOtcStatus('A');
    expect(started).toBe(1);
  });

  it('does not cache a failure, so the banner still counts two real polls', async () => {
    let started = 0;
    vi.stubGlobal('fetch', () => {
      started++;
      return Promise.resolve({ status: 500 });
    });
    resetStatusCache();

    expect(await fetchOtcStatus('A')).toBeNull();
    expect(await fetchOtcStatus('A')).toBeNull();
    expect(started).toBe(2);
  });

  it('asks again once the result is older than the TTL', async () => {
    let started = 0;
    vi.stubGlobal('fetch', () => {
      started++;
      return Promise.resolve({ status: 200, headers: new Map(), json: () => Promise.resolve(statusBody) });
    });
    resetStatusCache();
    vi.useFakeTimers();
    try {
      await fetchOtcStatus('A');
      vi.setSystemTime(Date.now() + 9001);
      await fetchOtcStatus('A');
      expect(started).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
