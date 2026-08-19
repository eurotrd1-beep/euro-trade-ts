/**
 * One trade, one verdict, in every layer that has an opinion about it.
 *
 * A report of the last five trades was built by a script that decided the
 * outcome itself instead of asking `outcomeFor`, and two draws came back as a
 * win and a loss. Nothing shipped read that script — but the shape of the
 * mistake is available to anything that looks at an open and a close, so the
 * defence is to check that the layers agree on the same candle rather than to
 * trust that they do.
 *
 * The layers, and where each is checked:
 *
 *   engine    `outcomeFor`                      — packages/engine
 *   program   `fib236Touch` settled.result      — here, driven candle by candle
 *   live      the card's settlement expression  — here, same two numbers
 *   backtest  `backtest()` tallies              — here, over the same candles
 *   generator `settlementFor`                   — euro-trade-proxy/test
 *   database  `resolve_signals` stores, never recomputes — the migration's
 *             verify script, plus 3,708 live rows audited with zero
 *             disagreements
 *   martingale a draw refunds the stake, so it owes no recovery trade ‹A5›
 */

import { describe, expect, it, vi } from 'vitest';
import { fib236Touch, outcomeFor, tieEpsilon, type Candle } from '@euro/engine';

const MIN = 60_000;
const T0 = Date.parse('2026-01-05T09:00:00.000Z');
const c = (i: number, open: number, high: number, low: number, close: number): Candle => ({
  open,
  high,
  low,
  close,
  volume: 1000,
  time: T0 + i * MIN,
});

const ENTRY = 1.097;
/** Inside the band and NOT equal to the entry — the case the two definitions split on. */
const INSIDE = ENTRY + tieEpsilon(ENTRY) * 0.5;

/**
 * The fixture from `backtestReplay`, with one number changed: the primary
 * trade now closes inside the draw band instead of below it. Everything before
 * candle 17 is identical, so the swing, the level and the touch are the same
 * and only the settlement differs.
 */
function drawCycle(): Candle[] {
  return [
    c(0, 1.093, 1.0934, 1.0926, 1.093),
    c(1, 1.092, 1.0924, 1.0916, 1.092),
    c(2, 1.0906, 1.091, 1.09, 1.0904), //  ← swing low
    c(3, 1.0915, 1.0919, 1.0911, 1.0915),
    c(4, 1.093, 1.0934, 1.0926, 1.093),
    c(5, 1.0945, 1.0949, 1.0941, 1.0945),
    c(6, 1.096, 1.0964, 1.0956, 1.096),
    c(7, 1.097, 1.0974, 1.0966, 1.097),
    c(8, 1.098, 1.0984, 1.0978, 1.0982),
    c(9, 1.099, 1.1, 1.0986, 1.0992), // ← swing high
    c(10, 1.0988, 1.099, 1.0984, 1.0986),
    c(11, 1.0985, 1.0987, 1.0982, 1.0984),
    c(12, 1.0983, 1.0985, 1.098, 1.0982),
    c(13, 1.0981, 1.0983, 1.0979, 1.098),
    c(14, 1.098, 1.0982, 1.0978, 1.0979),
    c(15, 1.0979, 1.0981, 1.0977, 1.0978),
    // ← TOUCH, closing deep enough past the level for ‹A10› and ‹A11›
    c(16, 1.0978, 1.098, 1.0972, 1.0971),
    c(17, ENTRY, ENTRY + 0.0004, ENTRY - 0.0004, INSIDE), // ← the draw
    c(18, 1.097, 1.0974, 1.0966, 1.097),
    c(19, 1.097, 1.0972, 1.0968, 1.097),
    c(20, 1.097, 1.0972, 1.0968, 1.097),
    c(21, 1.097, 1.0972, 1.0968, 1.097),
  ];
}

vi.mock('../lib/candles', () => ({
  fetchCandles: vi.fn(async () => drawCycle()),
}));

const { backtest } = await import('../lib/backtest');

/** What the program does, driven one closed candle at a time. */
function drive(candles: Candle[]) {
  const state = fib236Touch.init();
  const events = [];
  for (let i = 0; i < candles.length; i++) {
    const e = fib236Touch.onCandleClose(
      { candles: candles.slice(0, i + 1), timeframeMs: MIN, now: candles[i]!.time + MIN },
      state,
    );
    if (e.settled || e.signal || e.cycleEnd) events.push(e);
  }
  return events;
}

describe('a trade that closes inside the draw band', () => {
  it('is not an exact-equality case — the old database rule would have called it a win', () => {
    expect(INSIDE).not.toBe(ENTRY);
    expect(INSIDE).toBeGreaterThan(ENTRY);
  });

  it('is a draw to the engine', () => {
    expect(outcomeFor('CALL', ENTRY, INSIDE)).toBe('TIE');
  });

  it('is a draw to the program, and earns no martingale', () => {
    const events = drive(drawCycle());
    const settled = events.find((e) => e.settled !== null)!.settled!;

    expect(settled.stage).toBe('primary');
    expect(settled.entryPrice).toBe(ENTRY); // ‹A6› entry is the candle's open
    expect(settled.exitPrice).toBe(INSIDE); // ‹A6› exit is the same candle's close
    expect(settled.result).toBe('TIE');
    expect(events.some((e) => e.signal?.stage === 'martingale')).toBe(false);
    expect(events.find((e) => e.cycleEnd !== null)?.cycleEnd).toBe('TIE');
  });

  it('is a draw to the card, judged from the same two numbers', () => {
    // The live path settles with `outcomeFor(open.direction, bar.open, bar.close)`.
    const settled = drive(drawCycle()).find((e) => e.settled !== null)!.settled!;
    const bar = drawCycle()[17]!;
    expect(outcomeFor(settled.direction, bar.open, bar.close)).toBe(settled.result);
  });

  it('is a draw to the backtest, counted as neither a win nor a loss', async () => {
    const r = await backtest({ program: fib236Touch, symbols: ['EURUSD'] });

    expect(r.ties).toBe(1);
    expect(r.wins).toBe(0);
    expect(r.losses).toBe(0);
    expect(r.primary.ties).toBe(1);
    // A draw is excluded from the rate rather than counted as a half-win.
    expect(r.winRate).toBe(0);
    // And it opened no recovery trade, so the tally has nothing to double.
    expect(r.martingale.count).toBe(0);
    expect(r.cycles.tie).toBe(1);
    expect(r.cycles.finalLoss).toBe(0);
  });

  it('is the same verdict in every layer, on the same candle', async () => {
    const settled = drive(drawCycle()).find((e) => e.settled !== null)!.settled!;
    const bar = drawCycle()[17]!;
    const r = await backtest({ program: fib236Touch, symbols: ['EURUSD'] });

    const verdicts = [
      outcomeFor('CALL', bar.open, bar.close), // engine
      settled.result, // program
      outcomeFor(settled.direction, bar.open, bar.close), // live card
      r.trades[0]!.outcome, // backtest
      // The generator writes `settled.result` lowercased, and the database
      // stores what it is given — so this is the row's value too.
      settled.result.toLowerCase().toUpperCase(),
    ];
    expect(new Set(verdicts).size, `layers disagreed: ${verdicts.join(', ')}`).toBe(1);
    expect(verdicts[0]).toBe('TIE');
  });
});

describe('the same fixture with the close moved one tick outside the band', () => {
  const OUTSIDE_DOWN = ENTRY - tieEpsilon(ENTRY) * 1.01;
  const OUTSIDE_UP = ENTRY + tieEpsilon(ENTRY) * 1.01;

  it('is a loss against the trade and a win with it', () => {
    expect(outcomeFor('CALL', ENTRY, OUTSIDE_DOWN)).toBe('LOSS');
    expect(outcomeFor('CALL', ENTRY, OUTSIDE_UP)).toBe('WIN');
    expect(outcomeFor('PUT', ENTRY, OUTSIDE_DOWN)).toBe('WIN');
    expect(outcomeFor('PUT', ENTRY, OUTSIDE_UP)).toBe('LOSS');
  });

  it('and a close equal to the entry stays a draw', () => {
    expect(outcomeFor('CALL', ENTRY, ENTRY)).toBe('TIE');
    expect(outcomeFor('PUT', ENTRY, ENTRY)).toBe('TIE');
  });
});
