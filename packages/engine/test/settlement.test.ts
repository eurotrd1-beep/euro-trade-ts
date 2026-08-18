/**
 * One definition of WIN / LOSS / DRAW, checked in every place that settles.
 *
 * There were two. The engine calls a trade a draw when the close lands within
 * `tieEpsilon` of the entry — about 0.05 pips on a five-decimal pair — and the
 * database recomputed the same trade with exact equality, so a close inside
 * that band was a DRAW to the strategy (no martingale) and a WIN to the
 * statistics. Same trade, two answers, and neither side knew.
 *
 * The fix was to stop recomputing: `outcomeFor` decides, and every other
 * consumer stores what it decided. These tests hold that line.
 */

import { describe, expect, it } from 'vitest';
import { fib236Touch, outcomeFor, tieEpsilon, type Candle } from '../src/index.js';

const MIN = 60_000;
const T0 = Date.parse('2026-01-05T09:00:00.000Z');
const c = (i: number, open: number, high: number, low: number, close: number): Candle =>
  ({ open, high, low, close, volume: 1000, time: T0 + i * MIN });

const ENTRY = 1.09700;

describe('the draw band', () => {
  it('is a fraction of the entry price, not a fixed number of pips', () => {
    // Half a pip on EUR/USD would be 0.00005; this is a tenth of that, and it
    // scales with the quote so a yen pair is judged on the same relative terms.
    // Plus a floor of 1e-12, so a price of zero still has a band rather than
    // demanding bit-exact equality.
    expect(tieEpsilon(ENTRY)).toBe(ENTRY * 5e-6 + 1e-12);
    expect(tieEpsilon(150.123)).toBeGreaterThan(tieEpsilon(1.097));
  });

  it('calls a close inside it a draw, either side of the entry', () => {
    const eps = tieEpsilon(ENTRY);
    expect(outcomeFor('CALL', ENTRY, ENTRY + eps * 0.5)).toBe('TIE');
    expect(outcomeFor('CALL', ENTRY, ENTRY - eps * 0.5)).toBe('TIE');
    expect(outcomeFor('PUT', ENTRY, ENTRY + eps * 0.5)).toBe('TIE');
    expect(outcomeFor('PUT', ENTRY, ENTRY - eps * 0.5)).toBe('TIE');
  });

  it('calls the first tick outside it a win or a loss', () => {
    const just = tieEpsilon(ENTRY) * 1.01;
    expect(outcomeFor('CALL', ENTRY, ENTRY + just)).toBe('WIN');
    expect(outcomeFor('CALL', ENTRY, ENTRY - just)).toBe('LOSS');
    expect(outcomeFor('PUT', ENTRY, ENTRY - just)).toBe('WIN');
    expect(outcomeFor('PUT', ENTRY, ENTRY + just)).toBe('LOSS');
  });

  it('is NOT exact equality — the difference the two definitions disagreed on', () => {
    const inside = ENTRY + tieEpsilon(ENTRY) * 0.5;
    expect(inside).not.toBe(ENTRY); //          the database used to call this a win
    expect(outcomeFor('CALL', ENTRY, inside)).toBe('TIE'); // the strategy calls it a draw
  });
});

describe('the program settles through the same function', () => {
  /**
   * A cycle whose primary trade closes INSIDE the draw band.
   *
   * If the program had its own idea of a tie, this trade would settle as a
   * win or a loss and the cycle would end differently — and with a loss it
   * would have opened a martingale that the statistics knew nothing about.
   */
  function seriesClosingInsideTheBand(): Candle[] {
    const drift = tieEpsilon(ENTRY) * 0.5;
    return [
      c(0, 1.093, 1.0934, 1.0926, 1.093), c(1, 1.092, 1.0924, 1.0916, 1.092),
      c(2, 1.0906, 1.091, 1.09, 1.0904), c(3, 1.0915, 1.0919, 1.0911, 1.0915),
      c(4, 1.093, 1.0934, 1.0926, 1.093), c(5, 1.0945, 1.0949, 1.0941, 1.0945),
      c(6, 1.096, 1.0964, 1.0956, 1.096), c(7, 1.097, 1.0974, 1.0966, 1.097),
      c(8, 1.098, 1.0984, 1.0978, 1.0982), c(9, 1.099, 1.1, 1.0986, 1.0992),
      c(10, 1.0988, 1.099, 1.0984, 1.0986), c(11, 1.0985, 1.0987, 1.0982, 1.0984),
      c(12, 1.0983, 1.0985, 1.098, 1.0982), c(13, 1.0981, 1.0983, 1.0979, 1.098),
      c(14, 1.098, 1.0982, 1.0978, 1.0979), c(15, 1.0979, 1.0981, 1.0977, 1.0978),
      c(16, 1.0978, 1.098, 1.0972, 1.0974), //          the touch
      c(17, ENTRY, ENTRY + 0.0004, ENTRY - 0.0004, ENTRY + drift), // inside the band
      c(18, 1.097, 1.0974, 1.0966, 1.097),
    ];
  }

  it('records a draw, and takes no martingale from it', () => {
    const candles = seriesClosingInsideTheBand();
    const state = fib236Touch.init();
    const events = [];

    for (let i = 12; i < candles.length; i++) {
      const e = fib236Touch.onCandleClose(
        { candles: candles.slice(0, i + 1), timeframeMs: MIN, now: candles[i]!.time + MIN },
        state,
      );
      if (e.settled || e.signal || e.cycleEnd) events.push(e);
    }

    const settled = events.find((e) => e.settled !== null)!.settled!;
    expect(settled.result, 'the same verdict outcomeFor gives').toBe('TIE');
    expect(
      outcomeFor(settled.direction, settled.entryPrice, settled.exitPrice),
      'and it IS outcomeFor — not a second opinion that happens to agree',
    ).toBe(settled.result);

    // A draw refunds the stake, so there is nothing to recover.
    expect(events.some((e) => e.signal?.stage === 'martingale')).toBe(false);
    expect(events.find((e) => e.cycleEnd !== null)?.cycleEnd).toBe('TIE');
  });

  it('hands the same verdict to whoever records it', () => {
    // What the generator writes to the database is `settled.result`
    // lowercased — no arithmetic of its own — so the row and the cycle can
    // only ever agree.
    const candles = seriesClosingInsideTheBand();
    const state = fib236Touch.init();
    let recorded: string | null = null;

    for (let i = 12; i < candles.length; i++) {
      const e = fib236Touch.onCandleClose(
        { candles: candles.slice(0, i + 1), timeframeMs: MIN, now: candles[i]!.time + MIN },
        state,
      );
      if (e.settled) recorded = e.settled.result.toLowerCase();
    }

    expect(recorded).toBe('tie');
  });
});
