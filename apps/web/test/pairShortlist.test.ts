/**
 * The shortlist is one list, written in three places, and they must agree.
 *
 * The catalogue count has a history of going stale in pieces — its own comment
 * in `constants.ts` records the last time, when two health checks and the login
 * headline each carried a different number. Now there are three statements of
 * the same fact: the count, the offline fallback list, and the SQL that decides
 * what survives in the database. A drift between any two is a bug nobody sees
 * until the health check warns or a pair quietly comes back to life.
 *
 * ── HOW THE TWENTY-FIVE WERE CHOSEN ────────────────────────────────────────
 *
 * On global liquidity and the fame of the pair itself, never on our own numbers
 * — the stored candles are a rolling window of 100 per series, which cannot
 * rank pairs without inventing an edge out of a small sample.
 *
 * The data was used for one thing: dropping the dead. The scraper appends a
 * candle only when the price CHANGES (`if (price !== last.c)` in `_tickIv`), so
 * the number of distinct closes in that window is a direct liveness reading.
 * Silver's real feed stored a hundred candles at ONE price; gold's stopped
 * about a month before the rest. Both were replaced by their OTC pair.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOGUE_SYMBOLS, DEFAULT_CURRENCY_PAIRS } from '@euro/shared';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/20260916_pair_shortlist.sql', import.meta.url)),
  'utf8',
);

/** The symbols `pair_kept()` returns true for, read out of the migration. */
const keptInSql = (): string[] => {
  const body = MIGRATION.match(/SELECT sym IN \(([\s\S]*?)\);/);
  if (body === null) throw new Error('pair_kept() is not shaped as expected');
  return [...body[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
};

const symbols = DEFAULT_CURRENCY_PAIRS.map((p) => p.chartSymbol);

describe('the shortlist', () => {
  it('is twenty-five pairs, and the count says twenty-five', () => {
    // The number is a BUDGET. Candle upserts are the largest write source in
    // the system — 1,611 per pair per day, measured — against D1's 100,000
    // row writes a day. Twenty-five is 49% with the price snapshot included.
    // Thirty was 57%; before the candles_updated index was dropped, thirty was
    // 105% — over the limit, which blocks every query until 00:00 UTC.
    expect(DEFAULT_CURRENCY_PAIRS).toHaveLength(25);
    expect(CATALOGUE_SYMBOLS).toBe(25);
  });

  it('is the same list the migration keeps', () => {
    expect([...keptInSql()].sort()).toEqual([...symbols].sort());
  });

  it('names each pair once', () => {
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it('holds the six largest USD pairs and six known crosses, on the real market', () => {
    for (const s of ['EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'AUDUSD', 'USDCHF',
                     'EURJPY', 'GBPJPY', 'EURCHF', 'AUDJPY', 'CHFJPY', 'CADJPY']) {
      expect(symbols).toContain(s);
      expect(DEFAULT_CURRENCY_PAIRS.find((p) => p.chartSymbol === s)?.isOtc).toBe(false);
    }
  });

  it('keeps enough OTC to trade at the weekend', () => {
    // The real market closes Friday night. Whatever is left has to be OTC, and
    // one or two instruments is not a product.
    const otc = DEFAULT_CURRENCY_PAIRS.filter((p) => p.isOtc);
    // Thirteen. Silver and EUR/GBP stay suspended over the price mismatch, so
    // a Saturday is the same product on fewer instruments rather than a
    // different one.
    expect(otc.length).toBeGreaterThanOrEqual(12);
  });

  it('drops every feed the liveness reading called dead', () => {
    // XAGUSD stored 100 candles at a single price; XAUUSD stopped ~28 days
    // before the rest of the catalogue. Gold survives as its OTC pair; silver
    // does not survive at all — see the suspension below.
    expect(symbols).not.toContain('XAGUSD');
    expect(symbols).not.toContain('XAUUSD');
    expect(symbols).toContain('XAUUSD_otc');
  });

  it('suspends the two pairs whose demo price did not match', () => {
    // The first working demo session quoted silver at 68.22 against a stored
    // 19.25 — not eleven days of market, and not a silver price at all — and
    // EUR/GBP 10.8% out, while every other pair sat within 0.3–2.5%. OTC
    // instruments are synthetic, so a different generator is a real
    // possibility, and a strategy measured on one series and traded on another
    // is worth nothing. Both come back when the gap is explained.
    expect(symbols).not.toContain('XAGUSD_otc');
    expect(symbols).not.toContain('EURGBP_otc');
  });

  it('carries NZD/USD only as OTC, because that is the only one that exists', () => {
    // `isAllowedAsset('NZDUSD')` is already true — our filter is not what keeps
    // it out. Pocket Option simply never advertises it, and `otc_pairs` is
    // filled from that advertisement.
    expect(symbols).toContain('NZDUSD_otc');
    expect(symbols).not.toContain('NZDUSD');
  });


  it('takes the OTC pair wherever the real feed went stale AND the OTC one holds up', () => {
    // The rule was "drop the dead feed, keep the pair", and gold is the case
    // where it still applies. It did NOT survive contact with the demo prices
    // for silver or EUR/GBP: a dead real feed and an unexplained OTC one leave
    // no series to trust on either side, so the pair goes rather than the feed.
    expect(symbols).not.toContain('XAUUSD');
    expect(symbols).toContain('XAUUSD_otc');

    for (const gone of ['EURGBP', 'EURGBP_otc', 'XAGUSD', 'XAGUSD_otc']) {
      expect(symbols).not.toContain(gone);
    }
  });

  it('doubles up only on the pairs the weekend needs', () => {
    // Eleven pairs are carried in both forms on purpose: the weekend has to be
    // the same product as the weekday, so every major and every cross that has
    // a live OTC twin carries one. Everything else appears exactly once.
    //
    // NZD/USD and gold are the exceptions in the other direction — they exist
    // ONLY as OTC, because Pocket Option advertises no real-market NZD/USD and
    // the real gold feed is dead.
    const both = symbols
      .filter((s) => s.endsWith('_otc'))
      .map((s) => s.slice(0, -4))
      .filter((base) => symbols.includes(base));
    expect(both.sort()).toEqual([
      'AUDJPY', 'AUDUSD', 'CHFJPY', 'EURCHF', 'EURJPY',
      'EURUSD', 'GBPJPY', 'GBPUSD', 'USDCAD', 'USDCHF', 'USDJPY',
    ].sort());

    // And the two that are OTC-only.
    expect(symbols).toContain('NZDUSD_otc');
    expect(symbols).not.toContain('NZDUSD');
    expect(symbols).toContain('XAUUSD_otc');
    expect(symbols).not.toContain('XAUUSD');
  });

  it('has no crypto anywhere', () => {
    for (const s of symbols) {
      expect(s).not.toMatch(/BTC|ETH|SOL|XRP|DOGE|LTC|BCH/i);
    }
    expect(DEFAULT_CURRENCY_PAIRS.every((p) => p.category !== 'crypto')).toBe(true);
  });

  it('uses only categories the app already renders', () => {
    for (const p of DEFAULT_CURRENCY_PAIRS) {
      expect(['currencies', 'commodities']).toContain(p.category);
      expect(p.enabled).toBe(true);
      expect(p.source).toBe('po');
    }
  });

  it('marks OTC on exactly the symbols whose name says OTC', () => {
    for (const p of DEFAULT_CURRENCY_PAIRS) {
      expect(p.isOtc).toBe(p.chartSymbol.endsWith('_otc'));
      expect(p.isOtc).toBe(p.symbol.includes('OTC'));
    }
  });
});

describe('what the migration does with the rest', () => {
  it('deletes the candles, which is where the space actually is', () => {
    expect(MIGRATION).toContain('DELETE FROM public.candles');
  });

  it('disables the other pairs rather than deleting them', () => {
    // A deleted `otc_pairs` row comes back on the next asset scan, because
    // `_upsertLibrary` upserts everything the platform advertises. `enabled` is
    // deliberately absent from that payload, so a disabled row stays disabled.
    expect(MIGRATION).toContain('UPDATE public.otc_pairs');
    expect(MIGRATION).not.toContain('DELETE FROM public.otc_pairs');
  });

  it('makes a newly advertised symbol arrive switched off', () => {
    expect(MIGRATION).toContain('ALTER COLUMN enabled SET DEFAULT false');
  });
});
