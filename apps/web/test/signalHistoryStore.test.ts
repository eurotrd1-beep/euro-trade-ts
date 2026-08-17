/**
 * History persistence.
 *
 * The bug this covers was invisible: the list lived in React state only, so a
 * refresh emptied it and every statistic computed from it rendered as a zero
 * rather than as an error. Nothing looked wrong — there was simply no history.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { TradingSignal } from '@euro/engine';
import { loadHistory, mergeHistories, resolveOpenTrades, saveHistory } from '../lib/signalHistoryStore';

// jsdom is not in play here; a Map-backed stand-in is all the module touches.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
});

function signal(over: Partial<TradingSignal> = {}): TradingSignal {
  return {
    pair: 'EUR/USD OTC', direction: 'CALL', durationMinutes: 1,
    entryPrice: 1.1, currentPrice: 1.1, confidence: 95,
    entryTime: 1_700_000_000_000, expiryTime: 1_700_000_060_000,
    status: 'WIN', exitPrice: 1.2, candlesSnapshot: null,
    marketCondition: '', recommendation: '', origin: 'instant',
    ...over,
  };
}

describe('signal history survives a reload', () => {
  it('reads back what it wrote', () => {
    saveHistory('acct-1', [signal({ status: 'WIN' }), signal({ status: 'LOSS' })]);
    const back = loadHistory('acct-1');
    expect(back).toHaveLength(2);
    expect(back.map((s) => s.status)).toEqual(['WIN', 'LOSS']);
    expect(back[0]!.entryPrice).toBe(1.1);
    expect(back[0]!.exitPrice).toBe(1.2);
  });

  it('starts empty for an account that has never traded', () => {
    // Explicitly NOT the Dart behaviour, which fabricated a mock history here
    // and saved it, so a new account opened the app to trades it never took.
    expect(loadHistory('brand-new')).toEqual([]);
  });

  it('keeps accounts apart', () => {
    saveHistory('acct-1', [signal({ pair: 'EUR/USD OTC' })]);
    saveHistory('acct-2', [signal({ pair: 'GBP/USD OTC' }), signal()]);
    expect(loadHistory('acct-1')).toHaveLength(1);
    expect(loadHistory('acct-2')).toHaveLength(2);
    expect(loadHistory('acct-1')[0]!.pair).toBe('EUR/USD OTC');
  });

  it('caps at fifty, newest first', () => {
    const many = Array.from({ length: 70 }, (_, i) => signal({ entryTime: 1_700_000_000_000 + i }));
    saveHistory('acct-1', many);
    const back = loadHistory('acct-1');
    expect(back).toHaveLength(50);
    expect(back[0]!.entryTime).toBe(1_700_000_000_000);
  });

  it('drops the candle snapshot instead of storing it', () => {
    saveHistory('acct-1', [signal({ candlesSnapshot: [{ open: 1, high: 1, low: 1, close: 1, volume: 1, time: 1 }] })]);
    expect(store.get('signals_acct-1')).not.toContain('"volume"');
    expect(loadHistory('acct-1')[0]!.candlesSnapshot).toBeNull();
  });

  it('survives a corrupt entry without losing the rest', () => {
    // One row written by an older shape must not cost the user the other rows.
    store.set('signals_acct-1', JSON.stringify([
      { nonsense: true },
      { ...signal({ status: 'LOSS' }) },
      null,
    ]));
    const back = loadHistory('acct-1');
    expect(back).toHaveLength(1);
    expect(back[0]!.status).toBe('LOSS');
  });

  it('returns empty rather than throwing on unparseable storage', () => {
    store.set('signals_acct-1', '{not json');
    expect(loadHistory('acct-1')).toEqual([]);
  });

  it('does nothing without an account id', () => {
    saveHistory('', [signal()]);
    expect(store.size).toBe(0);
    expect(loadHistory('')).toEqual([]);
  });
});

/**
 * The merge is what makes the durable copy safe to introduce.
 *
 * Replacing one side with the other would lose trades in both directions: the
 * server holds what another device recorded, and the cache holds what settled
 * while the network was down. And a session closed mid-trade leaves an ACTIVE
 * row behind that must never be allowed to bury its own outcome.
 */
describe('merging the cached and durable copies', () => {
  it('keeps trades only one side has', () => {
    const local = [signal({ entryTime: 3000 })];
    const remote = [signal({ entryTime: 2000 }), signal({ entryTime: 1000 })];
    const merged = mergeHistories(local, remote);
    expect(merged.map((s) => s.entryTime)).toEqual([3000, 2000, 1000]);
  });

  it('does not duplicate the same trade', () => {
    const one = signal({ entryTime: 5000, pair: 'EUR/USD OTC', direction: 'CALL' });
    expect(mergeHistories([one], [{ ...one }])).toHaveLength(1);
  });

  it('prefers the settled row over the same trade still marked open', () => {
    const open = signal({ entryTime: 7000, status: 'ACTIVE', exitPrice: null });
    const done = signal({ entryTime: 7000, status: 'LOSS', exitPrice: 1.05 });
    expect(mergeHistories([open], [done])[0]!.status).toBe('LOSS');
    // Order of the arguments must not decide the outcome.
    expect(mergeHistories([done], [open])[0]!.status).toBe('LOSS');
  });

  it('treats the same minute on a different pair as a different trade', () => {
    const a = signal({ entryTime: 9000, pair: 'EUR/USD OTC' });
    const b = signal({ entryTime: 9000, pair: 'GBP/USD OTC' });
    expect(mergeHistories([a], [b])).toHaveLength(2);
  });

  it('sorts newest first and caps at fifty', () => {
    const a = Array.from({ length: 40 }, (_, i) => signal({ entryTime: 1000 + i }));
    const b = Array.from({ length: 40 }, (_, i) => signal({ entryTime: 5000 + i }));
    const merged = mergeHistories(a, b);
    expect(merged).toHaveLength(50);
    expect(merged[0]!.entryTime).toBe(5039);
    expect(merged.every((s, i) => i === 0 || merged[i - 1]!.entryTime >= s.entryTime)).toBe(true);
  });

  it('handles either side being empty', () => {
    const one = [signal({ entryTime: 4000 })];
    expect(mergeHistories([], one)).toHaveLength(1);
    expect(mergeHistories(one, [])).toHaveLength(1);
    expect(mergeHistories([], [])).toEqual([]);
  });
});

/**
 * An open trade is now stored the moment it is placed, so the list can contain
 * a trade with no outcome. What happens to it on the next launch is the part
 * that has to be exactly right: a trade still inside its window resumes, and one
 * whose window has passed must be marked unknown rather than settled — the exit
 * price at that instant is gone, and settling it against a later price would
 * manufacture a result.
 */
describe('trades that were still open when the app closed', () => {
  const PAIR = 'EUR/USD OTC';
  const now = Date.now();

  it('leaves a running trade on its own pair alone, so it can resume', () => {
    const running = signal({ status: 'ACTIVE', entryTime: now, expiryTime: now + 60_000, pair: PAIR });
    expect(resolveOpenTrades([running], PAIR, null)[0]!.status).toBe('ACTIVE');
  });

  it('marks a trade whose window has passed as PENDING, never as a win or a loss', () => {
    const abandoned = signal({ status: 'ACTIVE', entryTime: now - 600_000, expiryTime: now - 540_000, pair: PAIR });
    const out = resolveOpenTrades([abandoned], PAIR, null)[0]!;
    expect(out.status).toBe('PENDING');
    // The result was never observed, so nothing may be filled in for it.
    expect(out.exitPrice).toBe(abandoned.exitPrice);
  });

  it('does not keep a running trade active on a different pair', () => {
    // Settlement reads the live price of whatever chart is open, so there is no
    // price here that could settle this trade.
    const running = signal({ status: 'ACTIVE', entryTime: now, expiryTime: now + 60_000, pair: PAIR });
    expect(resolveOpenTrades([running], 'GBP/JPY OTC', null)[0]!.status).toBe('PENDING');
  });

  it('never touches the trade currently being counted down', () => {
    // Same trade, expiry already passed while the tick was in flight — the
    // settlement path owns it, not this one.
    const live = signal({ status: 'ACTIVE', entryTime: now - 120_000, expiryTime: now - 1000, pair: PAIR });
    expect(resolveOpenTrades([live], PAIR, live)[0]!.status).toBe('ACTIVE');
  });

  it('leaves settled trades exactly as they are', () => {
    const rows = [signal({ status: 'WIN' }), signal({ status: 'LOSS', entryTime: 5 }), signal({ status: 'TIE', entryTime: 6 })];
    expect(resolveOpenTrades(rows, PAIR, null).map((s) => s.status)).toEqual(['WIN', 'LOSS', 'TIE']);
  });

  it('a settled trade beats the stored open copy of itself when merged', () => {
    // The abandoned copy must not bury the outcome once it is known.
    const open = signal({ status: 'ACTIVE', entryTime: 9000, exitPrice: null, pair: PAIR });
    const settled = signal({ status: 'WIN', entryTime: 9000, exitPrice: 1.25, pair: PAIR });
    const merged = mergeHistories([open], [settled]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe('WIN');
    expect(resolveOpenTrades(merged, PAIR, null)[0]!.status).toBe('WIN');
  });
});
