/**
 * Running the same strategy on a different candle length.
 *
 * `fib236Touch` never reads its own `timeframe` or `durationMinutes` — every
 * decision in it comes from `ctx.timeframeMs`, supplied by the caller. So the
 * strategy on 5m is the same strategy: a swing between two confirmed pivots
 * and a touch of the 0.236 retracement, measured on whatever candles it is
 * handed. Only the length of a candle changes, and with it the length of the
 * trade, because one candle is one trade.
 *
 * That is what makes `programOnTimeframe` a copy of two fields rather than a
 * second implementation, and these pin both halves: that the declared values
 * follow the timeframe, and that the behaviour does not change with them.
 */

import { describe, expect, it } from 'vitest';
import {
  fib236Touch,
  programForPlan,
  programOnTimeframe,
  SUPPORTED_TIMEFRAMES,
  TIMEFRAME_MINUTES,
  type Candle,
  type ProgramEvent,
} from '../src/index.js';

/** Candles with a shape the strategy can find a swing in, at any spacing. */
function series(stepMs: number): Candle[] {
  const path: number[] = [];
  let p = 1.1;
  const leg = (to: number, n: number) => {
    const s = (to - p) / n;
    for (let i = 0; i < n; i++) { p += s; path.push(p); }
  };
  // Zig-zag with wiggles, so fractals form at both degrees.
  for (const target of [1.095, 1.103, 1.0985, 1.106, 1.101, 1.108, 1.1035]) {
    leg(target, 7);
    leg(p + (path[path.length - 1]! > p ? -0.0006 : 0.0006), 3);
  }
  return path.map((c, i) => ({
    open: c - 0.0002, high: c + 0.0005, low: c - 0.0005, close: c,
    volume: 1000, time: i * stepMs,
  }));
}

/** Replays a whole series and collects what the program said. */
function replay(program: typeof fib236Touch, stepMs: number): ProgramEvent[] {
  const candles = series(stepMs);
  const state = program.init();
  const out: ProgramEvent[] = [];
  for (let i = 14; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const now = window[i]!.time + stepMs + 1;
    out.push(program.onCandleClose({ candles: window, timeframeMs: stepMs, now }, state));
  }
  return out;
}

describe('programOnTimeframe', () => {
  it('carries the trade length that belongs to the timeframe', () => {
    const five = programOnTimeframe(fib236Touch, '5m');
    expect(five.timeframe).toBe('5m');
    expect(five.durationMinutes).toBe(5);
  });

  it('leaves the original alone', () => {
    programOnTimeframe(fib236Touch, '5m');
    expect(fib236Touch.timeframe).toBe('1m');
    expect(fib236Touch.durationMinutes).toBe(1);
  });

  it('refuses to invent a trade length for a timeframe it does not know', () => {
    // Guessing "probably a minute" here would place real trades on a duration
    // nobody chose. Returning the program unchanged is the safe answer.
    const odd = programOnTimeframe(fib236Touch, '3m');
    expect(odd).toBe(fib236Touch);
    expect(odd.durationMinutes).toBe(1);
  });

  it('offers only timeframes it has a trade length for', () => {
    for (const tf of SUPPORTED_TIMEFRAMES) {
      expect(TIMEFRAME_MINUTES[tf], `${tf} is offered with no trade length`).toBeGreaterThan(0);
    }
  });

  it('is what programForPlan hands back when asked for one', () => {
    expect(programForPlan('free', '5m').durationMinutes).toBe(5);
    expect(programForPlan('paid', '5m').timeframe).toBe('5m');
    // No timeframe means the program's own — the proxy generator relies on it.
    expect(programForPlan('free').timeframe).toBe('1m');
  });
});

describe('the strategy itself on 5m', () => {
  const MIN = 60_000;

  it('reads five-minute candles the same way it reads one-minute ones', () => {
    // Identical bars, different spacing. Every decision comes from the shape
    // of the candles, so the sequence of events must match exactly.
    const oneMin = replay(programForPlan('free', '1m'), MIN);
    const fiveMin = replay(programForPlan('free', '5m'), 5 * MIN);

    const shape = (evs: ProgramEvent[]) =>
      evs.map((e) => `${e.signal?.stage ?? '-'}|${e.settled?.result ?? '-'}|${e.cycleEnd ?? '-'}`);

    expect(shape(fiveMin)).toEqual(shape(oneMin));
  });

  it('actually trades on 5m rather than staying silent', () => {
    const events = replay(programForPlan('free', '5m'), 5 * MIN);
    const signals = events.filter((e) => e.signal !== null);
    expect(signals.length, 'the fixture produced no signals to judge').toBeGreaterThan(0);
  });

  it('still owes a martingale for a loss and nothing else, on 5m', () => {
    const events = replay(programForPlan('free', '5m'), 5 * MIN);
    for (const e of events) {
      if (e.settled === null) continue;
      const followed = e.signal?.stage === 'martingale';
      if (e.settled.result === 'LOSS' && e.settled.stage === 'primary') {
        expect(followed, 'a primary loss did not get its recovery trade').toBe(true);
      } else {
        expect(followed, `a ${e.settled.result} was handed a martingale`).toBe(false);
      }
    }
  });
});
