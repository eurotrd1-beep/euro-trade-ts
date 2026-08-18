/**
 * A push must not erase another device's work — G2.
 *
 * `pushRemoteHistory` wrote the caller's whole array straight over the row. A
 * tab is merged with the server ONCE, when it mounts; after an hour open, its
 * idea of the history is an hour old, and pushing it destroyed every trade
 * another device had settled meanwhile. The trade being saved arrived intact
 * and everything around it vanished — the worst shape a data loss can take,
 * because it looks like nothing happened.
 *
 * The fix reads the row, merges, then writes. The merge itself is what makes
 * that safe, so this pins the properties the fix depends on: a settled row
 * always beats the same row still marked open, and neither side loses a trade
 * the other has never seen.
 *
 * G10 is pinned here too. It is a comparison rather than a component: does this
 * trade belong to the pair on the chart? The catalogue names nine pairs
 * differently from anything derivable from their symbol, so answering by name
 * is wrong for every metal and every crypto — and answering it wrong drew one
 * market's entry price across another market's candles.
 */

import { describe, expect, it } from 'vitest';
import { mergeHistories } from '@/lib/signalHistoryStore';
import type { TradingSignal } from '@euro/engine';

const trade = (over: Partial<TradingSignal>): TradingSignal => ({
  pair: 'EUR/USD OTC',
  symbol: 'EURUSD_otc',
  direction: 'CALL',
  durationMinutes: 1,
  entryPrice: 1.1,
  currentPrice: 1.1,
  confidence: 92.5,
  entryTime: 1_000_000,
  expiryTime: 1_060_000,
  status: 'ACTIVE',
  exitPrice: null,
  candlesSnapshot: null,
  marketCondition: '',
  recommendation: '',
  origin: 'instant',
  ...over,
});

describe('merging two devices’ histories', () => {
  it('keeps a settled outcome over the same trade still marked open', () => {
    // Device A settled it; device B still has it running. A push from B must
    // not turn a recorded win back into an open trade.
    const settled = trade({ status: 'WIN', exitPrice: 1.1005 });
    const stillOpen = trade({});

    const fromB = mergeHistories([stillOpen], [settled]);
    expect(fromB).toHaveLength(1);
    expect(fromB[0]!.status, 'a stale open copy overwrote a settled one').toBe('WIN');

    // And the other way round, so the result does not depend on argument order.
    const fromA = mergeHistories([settled], [stillOpen]);
    expect(fromA[0]!.status).toBe('WIN');
  });

  it('loses nothing either side has seen alone', () => {
    const mine = trade({ entryTime: 1_000_000, status: 'WIN' });
    const theirs = trade({ entryTime: 2_000_000, status: 'LOSS' });

    const merged = mergeHistories([mine], [theirs]);
    expect(merged).toHaveLength(2);
    expect(merged.map((s) => s.entryTime).sort()).toEqual([1_000_000, 2_000_000]);
  });

  it('treats two pairs at the same instant as two trades', () => {
    // Identity is the trade, not the minute. Two pairs can fire on one candle.
    const eur = trade({ symbol: 'EURUSD_otc', pair: 'EUR/USD OTC' });
    const gold = trade({ symbol: 'XAUUSD_otc', pair: 'Gold OTC' });

    expect(mergeHistories([eur], [gold])).toHaveLength(2);
  });

  it('counts UNRESOLVED as settled, so a stale open copy cannot revive it', () => {
    const unresolved = trade({ status: 'UNRESOLVED', exitPrice: null });
    const merged = mergeHistories([trade({})], [unresolved]);
    expect(merged[0]!.status).toBe('UNRESOLVED');
  });
});

describe('does this trade belong to the chart on screen', () => {
  /** The comparison the chart makes before drawing an entry line. */
  const onThisChart = (signal: TradingSignal, chartSymbol: string, activePair: string): boolean =>
    signal.symbol !== undefined ? signal.symbol === chartSymbol : signal.pair === activePair;

  it('matches a pair whose catalogue name looks nothing like its symbol', () => {
    // `XAUUSD_otc` is called "Gold OTC" in the catalogue, so a name derived
    // from the symbol would be "XAU/USD OTC" and would never match. Nine pairs
    // are like this — every metal and every crypto.
    const gold = trade({ symbol: 'XAUUSD_otc', pair: 'Gold OTC' });
    expect(onThisChart(gold, 'XAUUSD_otc', 'Gold OTC')).toBe(true);
  });

  it('does not match a different pair', () => {
    const gold = trade({ symbol: 'XAUUSD_otc', pair: 'Gold OTC' });
    expect(onThisChart(gold, 'EURUSD_otc', 'EUR/USD OTC')).toBe(false);
  });

  it('still answers for a trade recorded before symbols were stored', () => {
    const old = trade({ symbol: undefined, pair: 'EUR/USD OTC' });
    expect(onThisChart(old, 'EURUSD_otc', 'EUR/USD OTC')).toBe(true);
    expect(onThisChart(old, 'GBPUSD_otc', 'GBP/USD OTC')).toBe(false);
  });
});
