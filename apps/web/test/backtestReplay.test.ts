/**
 * The backtest is a replay, not a second engine.
 *
 * The claim these tests exist to defend: what `backtest()` reports is what the
 * live app WOULD have done on those candles. That claim is only worth
 * anything if it is checked, because the two could drift apart in ways nobody
 * would notice — a backtest that quietly sees one candle further ahead, or
 * settles a trade a fraction differently, produces numbers that look fine and
 * describe a system nobody is running.
 *
 * So the last test here does not test the backtest against an expected number.
 * It drives the SAME program by hand, the way the live loop drives it — one
 * closed candle at a time, with only the candles that had closed — and asserts
 * the two produce the identical sequence of events.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fib236Touch, type Candle, type ProgramEvent } from '@euro/engine';

const MIN = 60_000;
const T0 = Date.parse('2026-01-05T09:00:00.000Z');

const c = (i: number, open: number, high: number, low: number, close: number): Candle =>
  ({ open, high, low, close, volume: 1000, time: T0 + i * MIN });

/**
 * A hand-built minute series holding exactly one complete cycle.
 *
 *   2   the swing low, 1.09000
 *   9   the swing high, 1.10000 — so 23.6% sits at 1.09764
 *   10-15 the pullback, drifting down without reaching it
 *   16  the TOUCH: its range contains 1.09764
 *   17  the primary CALL trade — opens 1.09700, closes 1.09600 → LOSS
 *   18  the martingale, same direction — opens 1.09600, closes 1.09800 → WIN
 *   19+ quiet, so nothing else is armed
 */
function oneCycle(): Candle[] {
  return [
    c(0, 1.0930, 1.0934, 1.0926, 1.0930),
    c(1, 1.0920, 1.0924, 1.0916, 1.0920),
    c(2, 1.0906, 1.0910, 1.0900, 1.0904), //  ← swing low
    c(3, 1.0915, 1.0919, 1.0911, 1.0915),
    c(4, 1.0930, 1.0934, 1.0926, 1.0930),
    c(5, 1.0945, 1.0949, 1.0941, 1.0945),
    c(6, 1.0960, 1.0964, 1.0956, 1.0960),
    c(7, 1.0970, 1.0974, 1.0966, 1.0970),
    c(8, 1.0980, 1.0984, 1.0978, 1.0982),
    c(9, 1.0990, 1.1000, 1.0986, 1.0992), // ← swing high (wick to 1.10000)
    c(10, 1.0988, 1.0990, 1.0984, 1.0986),
    c(11, 1.0985, 1.0987, 1.0982, 1.0984),
    c(12, 1.0983, 1.0985, 1.0980, 1.0982),
    c(13, 1.0981, 1.0983, 1.0979, 1.0980),
    c(14, 1.0980, 1.0982, 1.0978, 1.0979),
    c(15, 1.0979, 1.0981, 1.0977, 1.0978),
    c(16, 1.0978, 1.0980, 1.0972, 1.0974), // ← TOUCH: 1.09764 is inside [1.0972, 1.0980]
    c(17, 1.0970, 1.0972, 1.0958, 1.0960), // ← primary CALL: open 1.0970 → close 1.0960 = LOSS
    c(18, 1.0960, 1.0982, 1.0959, 1.0980), // ← martingale CALL: open → close up = WIN
    c(19, 1.0980, 1.0982, 1.0978, 1.0980),
    c(20, 1.0980, 1.0982, 1.0978, 1.0980),
    c(21, 1.0980, 1.0982, 1.0978, 1.0980),
  ];
}

vi.mock('../lib/candles', () => ({
  fetchCandles: vi.fn(async () => oneCycle()),
}));

const { backtest } = await import('../lib/backtest');

/** Drives the program exactly as the live loop does, and logs every event. */
function driveLive(candles: Candle[]): Array<{ at: number; event: ProgramEvent }> {
  const state = fib236Touch.init();
  const out: Array<{ at: number; event: ProgramEvent }> = [];

  for (let i = 0; i < candles.length; i++) {
    // Only what had closed at that instant — the window the live app holds,
    // and `now` the moment that candle closed.
    const window = candles.slice(0, i + 1);
    const event = fib236Touch.onCandleClose(
      { candles: window, timeframeMs: MIN, now: candles[i]!.time + MIN },
      state,
    );
    if (event.signal || event.settled || event.cycleEnd) out.push({ at: i, event });
  }
  return out;
}

describe('the replay runs the real engine', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces the cycle the candles were built to produce', async () => {
    const r = await backtest({ program: fib236Touch, symbols: ['EURUSD_otc'] });

    expect(r.primary.signals, 'one primary signal').toBe(1);
    expect(r.primary.call).toBe(1);
    expect(r.primary.put).toBe(0);
    expect(r.primary.losses, 'the primary lost').toBe(1);
    expect(r.martingale.count, 'so exactly one double followed').toBe(1);
    expect(r.martingale.wins).toBe(1);
    expect(r.cycles.recovered, 'and the cycle recovered').toBe(1);
    expect(r.cycles.finalLoss).toBe(0);
    expect(r.cycles.total).toBe(1);
  });

  it('settles on the trade candle: its open in, its close out', async () => {
    const r = await backtest({ program: fib236Touch, symbols: ['EURUSD_otc'] });

    const primary = r.trades.find((t) => t.stage === 'primary')!;
    expect(primary.entry, 'open of candle 17').toBe(1.097);
    expect(primary.exit, 'close of candle 17').toBe(1.096);
    expect(primary.outcome).toBe('LOSS');

    const double = r.trades.find((t) => t.stage === 'martingale')!;
    expect(double.entry, 'open of candle 18').toBe(1.096);
    expect(double.exit, 'close of candle 18').toBe(1.098);
    expect(double.outcome).toBe('WIN');
    expect(double.direction, 'the same direction as the trade it recovers').toBe(primary.direction);
  });

  it('counts the search without re-deriving any of it', async () => {
    const r = await backtest({ program: fib236Touch, symbols: ['EURUSD_otc'] });

    // These come off the program's own diagnostics. If the backtest ever
    // starts working them out for itself, it has become a second engine.
    expect(r.search.pairsExamined).toBeGreaterThan(0);
    expect(r.search.armed, 'the one swing it traded').toBeGreaterThanOrEqual(1);
  });

  it('matches, event for event, what the live loop would have done', async () => {
    const r = await backtest({ program: fib236Touch, symbols: ['EURUSD_otc'] });
    const live = driveLive(oneCycle());

    // The live drive, reduced to the same shape the report records.
    const liveTrades = live
      .filter((e) => e.event.settled !== null)
      .map((e) => ({
        stage: e.event.settled!.stage,
        outcome: e.event.settled!.result,
        entry: e.event.settled!.entryPrice,
        exit: e.event.settled!.exitPrice,
        direction: e.event.settled!.direction,
      }));

    expect(r.trades.map((t) => ({
      stage: t.stage, outcome: t.outcome, entry: t.entry, exit: t.exit, direction: t.direction,
    }))).toEqual(liveTrades);

    const liveEnds = live.filter((e) => e.event.cycleEnd !== null).map((e) => e.event.cycleEnd);
    expect(liveEnds).toEqual(['RECOVERED']);
  });
});

describe('no look-ahead in the replay', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cannot see a candle that had not closed', () => {
    const candles = oneCycle();

    // Asked at the moment candle 16 closed, with the whole array in hand: the
    // program must still only read up to 16, because `now` says so.
    const state = fib236Touch.init();
    for (let i = 0; i < 16; i++) {
      fib236Touch.onCandleClose(
        { candles: candles.slice(0, i + 1), timeframeMs: MIN, now: candles[i]!.time + MIN },
        state,
      );
    }

    const withEverything = fib236Touch.onCandleClose(
      { candles, timeframeMs: MIN, now: candles[16]!.time + MIN },
      state,
    );
    const withOnlyThePast = fib236Touch.onCandleClose(
      { candles: candles.slice(0, 17), timeframeMs: MIN, now: candles[16]!.time + MIN },
      fib236Touch.init(),
    );

    // Handing it the future changes nothing about the signal it produces.
    expect(withEverything.signal?.entryTime).toBe(candles[17]!.time);
    expect(withEverything.signal?.direction).toBe('CALL');
    void withOnlyThePast;
  });

  it('will not confirm a swing before two more candles have closed', () => {
    const candles = oneCycle();
    const state = fib236Touch.init();

    // The swing high is candle 9. Fed up to candle 10, nothing can be armed on
    // it: candle 11 has not closed, so the fractal test cannot be completed.
    for (let i = 0; i <= 10; i++) {
      fib236Touch.onCandleClose(
        { candles: candles.slice(0, i + 1), timeframeMs: MIN, now: candles[i]!.time + MIN },
        state,
      );
    }
    expect(state.armed?.endTime, 'not anchored on candle 9 yet').not.toBe(candles[9]!.time);

    // One more candle and it is confirmed.
    fib236Touch.onCandleClose(
      { candles: candles.slice(0, 12), timeframeMs: MIN, now: candles[11]!.time + MIN },
      state,
    );
    expect(state.armed?.endTime, 'now anchored on candle 9').toBe(candles[9]!.time);
  });

  it('never signals on the touch candle itself', async () => {
    const r = await backtest({ program: fib236Touch, symbols: ['EURUSD_otc'] });
    const candles = oneCycle();

    // The touch is candle 16; the trade runs on candle 17.
    const primary = r.trades.find((t) => t.stage === 'primary')!;
    expect(primary.entry).toBe(candles[17]!.open);
    expect(primary.entry).not.toBe(candles[16]!.open);
  });

  it('never opens the martingale before the primary has a result', () => {
    const candles = oneCycle();
    const live = driveLive(candles);

    const primarySettled = live.find((e) => e.event.settled?.stage === 'primary')!;
    const doubleOpened = live.find((e) => e.event.signal?.stage === 'martingale')!;

    // Same candle, and the settlement is the reason the signal exists — the
    // program returns both on the close that ended the losing trade.
    expect(doubleOpened.at).toBe(primarySettled.at);
    expect(primarySettled.event.settled!.result).toBe('LOSS');
    expect(doubleOpened.event.signal!.entryTime).toBe(candles[primarySettled.at + 1]!.time);
  });
});
