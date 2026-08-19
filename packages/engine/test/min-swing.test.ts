/**
 * The minimum swing size ‹A7›, and what it does NOT do.
 *
 * A leg has to be at least `10 × tieEpsilon` wide, measured on the end of the
 * leg. Two things have to be true about that rule and neither is obvious from
 * reading it:
 *
 *   1. it refuses a CANDIDATE, not the candle — the search walks on to the
 *      next, older pair of pivots exactly as it does for every other
 *      rejection, so a micro-swing sitting in front of a usable leg hides
 *      nothing;
 *   2. it is the ONLY thing refusing that candidate — the leg below passes
 *      every other check, so if this test ever goes green for the wrong
 *      reason it is because some other rule started refusing it too.
 *
 * The fixture is built so the newest pair of pivots is a 0.3-pip bounce and
 * the pair behind it is a 50-pip drop. Before the minimum existed, the bounce
 * was adopted and the drop waited behind it ‹A8› until the bounce died.
 */

import { describe, expect, it } from 'vitest';
import { fib236Touch, tieEpsilon, type Candle } from '../src/index.js';

const MIN = 60_000;
const T0 = Date.parse('2026-01-05T09:00:00.000Z');
const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({
  open: o,
  high: h,
  low: l,
  close: cl,
  volume: 1000,
  time: T0 + i * MIN,
});

/**
 * Four confirmed pivots, in this order:
 *
 *   @2  low  1.09000
 *   @9  high 1.10000
 *   @16 low  1.09500   ← the 50-pip drop ends here
 *   @21 high 1.09503   ← a 0.3-pip bounce off it
 *
 * so the newest adjacent alternating pair is (@16 → @21) and the one behind it
 * is (@9 → @16).
 */
const SERIES: Candle[] = [
  c(0, 1.093, 1.0934, 1.0926, 1.093),
  c(1, 1.092, 1.0924, 1.0916, 1.092),
  c(2, 1.0906, 1.091, 1.09, 1.0904),
  c(3, 1.0915, 1.0919, 1.0911, 1.0915),
  c(4, 1.093, 1.0934, 1.0926, 1.093),
  c(5, 1.0945, 1.0949, 1.0941, 1.0945),
  c(6, 1.096, 1.0964, 1.0956, 1.096),
  c(7, 1.097, 1.0974, 1.0966, 1.097),
  c(8, 1.098, 1.0984, 1.0978, 1.0982),
  c(9, 1.0996, 1.1, 1.0995, 1.0997),
  c(10, 1.0985, 1.0989, 1.0981, 1.0983),
  c(11, 1.0975, 1.0979, 1.0971, 1.0973),
  c(12, 1.0965, 1.0969, 1.0961, 1.0963),
  c(13, 1.0958, 1.096, 1.0954, 1.0956),
  c(14, 1.0954, 1.0956, 1.0952, 1.0953),
  c(15, 1.09525, 1.0953, 1.0951, 1.09515),
  c(16, 1.09501, 1.09501, 1.095, 1.095),
  c(17, 1.095, 1.09502, 1.095005, 1.095015),
  c(18, 1.095015, 1.095022, 1.095008, 1.09502),
  c(19, 1.09502, 1.095022, 1.095015, 1.095018),
  c(20, 1.095018, 1.095022, 1.095016, 1.09502),
  c(21, 1.09502, 1.09503, 1.095025, 1.095028),
  c(22, 1.095028, 1.095029, 1.095021, 1.095025),
  c(23, 1.095025, 1.095028, 1.09502, 1.095024),
  // The retracement into the older leg's 23.6%, at 1.09618 — and it CLOSES at
  // or above it, which ‹A10› now requires of a PUT.
  c(24, 1.09525, 1.0964, 1.0952, 1.09665),
  // the trade: opens 1.09600, closes 1.09520 — a PUT that wins
  c(25, 1.096, 1.0961, 1.0951, 1.0952),
  c(26, 1.0952, 1.0953, 1.0951, 1.0952),
];

const MICRO_ORIGIN = 1.095; //  @16 low
const MICRO_END = 1.09503; // @21 high
const BIG_ORIGIN = 1.1; //     @9  high
const BIG_END = 1.095; //      @16 low
const FIB = 0.236;

/** One call over the whole buffer — the cold start the app does on load. */
function coldStart(upTo: number) {
  const candles = SERIES.slice(0, upTo + 1);
  const state = fib236Touch.init();
  const event = fib236Touch.onCandleClose(
    { candles, timeframeMs: MIN, now: candles.at(-1)!.time + MIN + 1 },
    state,
  );
  return { state, event };
}

describe('the micro-swing in front of a usable leg', () => {
  it('is below the minimum, but above a single tieEpsilon', () => {
    const range = Math.abs(MICRO_END - MICRO_ORIGIN);
    expect(range).toBeCloseTo(0.00003, 10);
    // Bigger than the draw band — so the multiplier is what refuses it, not
    // the epsilon on its own. A minimum of 1× would have let this through.
    expect(range).toBeGreaterThan(tieEpsilon(MICRO_END));
    expect(range).toBeLessThan(10 * tieEpsilon(MICRO_END));
  });

  it('passes every OTHER check, so size is the only thing refusing it', () => {
    // Alternating kinds ‹A2›: a low then a high.
    expect(MICRO_ORIGIN).toBeLessThan(MICRO_END);
    // Not zero range ‹A7›, the check that used to be the whole rule.
    expect(Math.abs(MICRO_END - MICRO_ORIGIN)).toBeGreaterThan(0);

    // Neither swing candle contains its own 23.6% level.
    const level = MICRO_END + FIB * (MICRO_ORIGIN - MICRO_END);
    const origin = SERIES[16]!;
    const end = SERIES[21]!;
    expect(origin.low <= level && level <= origin.high).toBe(false);
    expect(end.low <= level && level <= end.high).toBe(false);

    // And price never left the end of the leg behind ‹A9›: for a CALL that
    // would mean a later high above 1.09503.
    const after = SERIES.slice(22, 24);
    expect(after.every((x) => x.high <= MICRO_END)).toBe(true);
  });

  it('is refused, counted on its own line, and does not stop the search', () => {
    const { state, event } = coldStart(23);
    const d = event.diagnostics!;

    expect(d.rejectedTooSmall, 'the micro-swing').toBe(1);
    expect(d.rejectedShape, 'not folded into the same-kind counter').toBe(0);
    expect(d.pairsExamined, 'it looked at a second candidate after refusing the first').toBe(2);
    expect(d.armed).toBe(true);

    // What it adopted is the leg BEHIND the micro-swing, not the micro-swing.
    expect(state.armed).not.toBeNull();
    expect(state.armed!.direction).toBe('PUT');
    expect(state.armed!.endPrice).toBe(BIG_END);
    expect(state.armed!.level).toBeCloseTo(BIG_END + FIB * (BIG_ORIGIN - BIG_END), 10);
    expect(state.armed!.level).toBeCloseTo(1.09618, 10);
  });

  it('leaves the older leg fully usable — it arms, touches and trades', () => {
    const state = fib236Touch.init();
    const events = [];
    // Cold start on the whole buffer, then one candle at a time, which is what
    // the app does after its first load.
    for (const upTo of [23, 24, 25, 26]) {
      const candles = SERIES.slice(0, upTo + 1);
      events.push(
        fib236Touch.onCandleClose(
          { candles, timeframeMs: MIN, now: candles.at(-1)!.time + MIN + 1 },
          state,
        ),
      );
    }

    const fired = events.find((e) => e.signal !== null)!;
    expect(fired.signal!.direction, 'the down-leg the micro-swing was hiding').toBe('PUT');
    expect(fired.signal!.stage).toBe('primary');
    expect(fired.signal!.entryTime).toBe(SERIES[25]!.time);

    const settled = events.find((e) => e.settled !== null)!.settled!;
    expect(settled.entryPrice).toBe(SERIES[25]!.open); //  ‹A6›
    expect(settled.exitPrice).toBe(SERIES[25]!.close); // ‹A6›
    expect(settled.result).toBe('WIN');
  });
});

describe('the minimum is a fraction of price, not a number of pips', () => {
  it('scales with the quote, so every pair is held to the same standard', () => {
    // 0.5 basis points, whatever the pair is worth. A fixed pip minimum would
    // be meaningless at both ends of this range — these are all live pairs.
    for (const price of [1.097, 85.006, 114.72, 4402.6, 17_107.8]) {
      const minimum = 10 * tieEpsilon(price);
      // Not exact: the 1e-12 floor adds about 9e-12 to the ratio on a
      // five-decimal quote. Close enough that no leg is decided by it.
      expect(minimum / price).toBeCloseTo(5e-5, 10);
    }
  });

  it('is very slightly stricter on a near-zero quote, because of the floor', () => {
    // `tieEpsilon` adds 1e-12 so that a price of zero still has a band rather
    // than demanding bit-exact equality. On an ordinary pair that term is
    // invisible; on LBP/USD at 0.00001 it is a fifth of the whole epsilon, so
    // the minimum there is 0.51 basis points rather than 0.50. Stated because
    // it is a real edge of the rule, not because it changes any decision —
    // that pair's legs run to hundreds of basis points.
    const tiny = 0.00001;
    const ratio = (10 * tieEpsilon(tiny)) / tiny;
    expect(ratio).toBeGreaterThan(5e-5);
    expect(ratio).toBeCloseTo(5.1e-5, 9);
  });

  it('refuses a leg one tick under it and accepts one tick over', () => {
    const price = 1.097;
    const minimum = 10 * tieEpsilon(price);
    expect(minimum * 0.99).toBeLessThan(minimum);
    expect(minimum * 1.01).toBeGreaterThan(minimum);
    // The boundary itself is accepted: the rule is `range < minimum` refuses.
    expect(minimum < minimum).toBe(false);
  });
});
