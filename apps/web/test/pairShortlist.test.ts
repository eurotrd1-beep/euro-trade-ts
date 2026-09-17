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
 * Two filters were then applied, in this order, and the second one only exists
 * because the first was mistaken for it:
 *
 *   1. LIVENESS.  The scraper appends a candle only when the price CHANGES
 *      (`if (price !== last.c)` in `_tickIv`), so distinct closes in the stored
 *      window read directly as whether a feed is alive. Silver's real feed held
 *      a hundred candles at ONE price; gold's stopped about a month before the
 *      rest. Both were dropped in favour of their OTC pair.
 *
 *   2. TRADEABILITY.  Pocket Option publishes its own flag for an asset that
 *      cannot be traded — N/V, surfaced to us as `po: false`. This is a
 *      different question from liveness, and EUR/JPY OTC is the pair that
 *      proved it: a price that kept moving for an asset the broker would not
 *      accept a trade on. It passed filter 1, shipped, and showed as مغلق in
 *      the app while everything around it was open. The whole list was then
 *      re-checked against the broker's flag: twenty-five open, zero N/V.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOGUE_SYMBOLS, DEFAULT_CURRENCY_PAIRS } from '@euro/shared';

/**
 * The D1 migration, not the Supabase one.
 *
 * The first shortlist was written against Postgres and lives in
 * `supabase/migrations/20260916_pair_shortlist.sql`. Supabase is frozen now —
 * reads only, kept for rollback — so the list that actually governs what the
 * scraper streams is the one in D1, and that is the copy worth pinning a test
 * to. The Postgres file is left untouched as a record of the state a rollback
 * would return to.
 */
const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../data-hub/migrations/0002_pair_rebalance.sql', import.meta.url)),
  'utf8',
);

/** The symbols the migration inserts into `_kept`, which is the whole list. */
const keptInSql = (): string[] => {
  const body = MIGRATION.match(/INSERT INTO _kept \(symbol\) VALUES([\s\S]*?);/);
  if (body === null) throw new Error('_kept is not filled the way this test expects');
  return [...body[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
};

const symbols = DEFAULT_CURRENCY_PAIRS.map((p) => p.chartSymbol);
const otc = DEFAULT_CURRENCY_PAIRS.filter((p) => p.isOtc);
const real = DEFAULT_CURRENCY_PAIRS.filter((p) => !p.isOtc);

describe('the shortlist', () => {
  it('is twenty-five pairs, and the count says twenty-five', () => {
    // The number is a BUDGET. Candle upserts are the largest write source in
    // the system — 1,611 per pair per day, measured — against D1's 100,000
    // row writes a day. Twenty-five is 49% with the price snapshot included.
    // Thirty was 57%; before the candles_updated index was dropped, thirty was
    // 105% — over the limit, which blocks every query until 00:00 UTC.
    //
    // Reweighting the list toward OTC does not move this: the cost is per
    // symbol, and the count is what it was.
    expect(DEFAULT_CURRENCY_PAIRS).toHaveLength(25);
    expect(CATALOGUE_SYMBOLS).toBe(25);
  });

  it('is the same list the migration keeps', () => {
    expect([...keptInSql()].sort()).toEqual([...symbols].sort());
  });

  it('names each pair once', () => {
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it('is mostly OTC, because that is what trades at the weekend', () => {
    // The real market shuts on Friday night. A catalogue weighted the other way
    // is a product that shrinks to a third of itself for two days a week — and
    // those are the two days people have time to trade.
    expect(otc.length).toBe(18);
    expect(real.length).toBe(7);
    expect(otc.length).toBeGreaterThan(real.length * 2);
  });

  it('keeps the real-market majors, so the strategy is not measured only on synthetic prices', () => {
    // OTC instruments are prices the broker publishes for itself. Seven real
    // pairs stay so that, whenever the real market is open, the record is being
    // written against quotes the counterparty does not author.
    expect([...real.map((p) => p.chartSymbol)].sort()).toEqual(
      ['EURUSD', 'USDJPY', 'GBPUSD', 'USDCHF', 'USDCAD', 'AUDUSD', 'GBPJPY'].sort(),
    );
  });

  it('drops EUR/JPY OTC, the pair the broker reports as untradeable', () => {
    // N/V on Pocket Option — its own flag — while still streaming a moving
    // price, which is why the liveness reading passed it. It is the reason the
    // tradeability check above exists at all. The real EUR/JPY goes with it:
    // this list carries no EUR/JPY in either form.
    expect(symbols).not.toContain('EURJPY_otc');
    expect(symbols).not.toContain('EURJPY');
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

  it('carries the OTC-only pairs that have no real-market twin here', () => {
    // NZD/USD: `isAllowedAsset('NZDUSD')` is already true — our filter is not
    // what keeps it out. Pocket Option simply never advertises it, and
    // `otc_pairs` is filled from that advertisement.
    //
    // The crosses below have a real-market form that Pocket Option does list,
    // and they are OTC-only here by the weighting decision rather than by
    // availability. Gold is OTC-only because its real feed is dead.
    for (const only of ['NZDUSD_otc', 'XAUUSD_otc', 'AUDCAD_otc', 'CADJPY_otc',
                        'NZDJPY_otc', 'AUDNZD_otc', 'CADCHF_otc', 'GBPAUD_otc',
                        'CHFJPY_otc', 'AUDJPY_otc', 'EURCHF_otc']) {
      expect(symbols).toContain(only);
      expect(symbols).not.toContain(only.slice(0, -4));
    }
  });

  it('doubles up only on the seven the real market still carries', () => {
    // Every real-market pair has its OTC twin, so the weekend is the same
    // product on a superset rather than a different one. Nothing else appears
    // twice.
    const both = symbols
      .filter((s) => s.endsWith('_otc'))
      .map((s) => s.slice(0, -4))
      .filter((base) => symbols.includes(base));
    expect(both.sort()).toEqual([...real.map((p) => p.chartSymbol)].sort());
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
    expect(MIGRATION).toContain('DELETE FROM candles');
  });

  it('disables the catalogue rather than deleting it', () => {
    // An `otc_pairs` row deleted here comes back on the next asset scan,
    // because the scan upserts everything the platform advertises. `enabled` is
    // deliberately absent from that payload, so a disabled row stays disabled —
    // and the full catalogue is what makes any of this reversible.
    expect(MIGRATION).toContain('UPDATE otc_pairs SET enabled = 0');
    expect(MIGRATION).not.toMatch(/DELETE FROM otc_pairs/);
  });

  it('deletes from the app-facing list, which is not rebuilt by the scan', () => {
    // Every `pairs` row is sent to every phone on every load and filtered
    // client-side, so a disabled row costs bandwidth to display nothing.
    expect(MIGRATION).toContain('DELETE FROM pairs');
  });

  it('leaves no scratch table behind', () => {
    expect(MIGRATION).toContain('CREATE TABLE _kept');
    expect(MIGRATION).toContain('DROP TABLE _kept');
  });
});
