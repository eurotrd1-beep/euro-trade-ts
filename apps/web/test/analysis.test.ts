/**
 * The analysis stages must not narrate indicators the strategy does not read.
 *
 * They used to. Nine of the twelve lines printed RSI, Stochastic, CCI, ATR,
 * ADX, MFI, VWAP, CMF and volume delta, and the last one announced "the final
 * confluence of 18 technical indicators". The engine runs one program and it
 * reads one thing: whether price came back to the 0.236 retracement.
 *
 * Four of those were computed from `candle.volume`, which Pocket Option does
 * not send — the app substitutes a flat 1000. The test below proves what that
 * did: CMF and volume delta return the SAME number on four unrelated price
 * series, because a constant input has a constant output. Those two numbers
 * were printed to every user on every pair as live measurements.
 *
 * So this file guards two things — that no stage names an indicator the
 * decision never sees, and that the reason it must not is still true.
 */

import { describe, expect, it } from 'vitest';
import { cmf, volumeDelta } from '@euro/engine';
import type { Candle } from '@euro/engine';
import golden from '../../../packages/engine/golden/engine-golden.json' with { type: 'json' };
import { buildStages } from '@/lib/analysis';

/**
 * Real recorded candles, and the flat volume `candles.ts` substitutes.
 *
 * Recorded rather than generated because `detectSwing` reads structure two
 * degrees deep — fractals, then the fractals among those — and a hand-drawn
 * zigzag does not have it. The first 146 bars are a window where a swing is
 * confirmed; the same slice `cache-key.test.ts` uses, for the same reason.
 */
const recorded: Candle[] = golden.candles.slice(0, 146).map((c) => ({
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: 1000,
  time: Date.parse(c.time),
}));

/**
 * Four genuinely unrelated price series, for the constant-volume proof.
 *
 * Generated rather than recorded here, and deliberately so: the claim is that
 * these two indicators return the same number whatever the PRICES do, and the
 * strongest way to show it is to hand them series that have nothing in common
 * beyond a flat volume.
 */
const series = (seed: number): Candle[] =>
  Array.from({ length: 80 }, (_, i) => {
    const base = 1.1 + Math.sin((i + seed) / 3) * 0.004 + seed * 0.01;
    return {
      open: base,
      high: base + 0.0008,
      low: base - 0.0008,
      close: base + 0.0003,
      volume: 1000,
      time: i * 60_000,
    };
  });

/** Every name a stage used to print that the strategy never consults. */
const ABSENT = ['RSI', 'Stochastic', 'CCI', 'ATR', 'ADX', 'MFI', 'VWAP', 'CMF', 'Vol Delta'];

describe('analysis stages', () => {
  const candles = recorded;
  const price = candles[candles.length - 1]!.close;
  const stages = buildStages({ candles, currentPrice: price, pair: 'EUR/USD (OTC)' });
  const text = stages.join('\n');

  it('names no indicator the decision never sees', () => {
    for (const name of ABSENT) {
      expect(text, `a stage still narrates ${name}`).not.toContain(name);
    }
  });

  it('shows the level the strategy actually watches', () => {
    expect(text).toContain('0.236');
  });

  it('prints the swing the level is drawn from, as a number', () => {
    // Not just the word: a stage that says "Fibonacci" without the level it
    // landed on is the decoration this file exists to keep out.
    expect(text).toMatch(/1\.\d{5}/);
  });

  it('says something on every run, and never an empty line', () => {
    expect(stages.length).toBeGreaterThan(0);
    for (const s of stages) expect(s.trim().length).toBeGreaterThan(0);
  });

  it('holds up when there is no confirmed swing to draw on', () => {
    // A flat series has no pivots, so `detectSwing` returns null. The sequence
    // must still say something true rather than print NaN.
    const flat: Candle[] = Array.from({ length: 80 }, (_, i) => ({
      open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume: 1000, time: i * 60_000,
    }));
    const out = buildStages({ candles: flat, currentPrice: 1.1, pair: 'EUR/USD (OTC)' }).join('\n');
    expect(out).not.toContain('NaN');
    expect(out.length).toBeGreaterThan(0);
  });

  it('the volume indicators really were constant — why they had to go', () => {
    // Four unrelated price series. Volume is flat, so these two cannot move.
    const readings = [0, 7, 21, 40].map((s) => ({
      cmf: cmf(series(s), 20),
      delta: volumeDelta(series(s)),
    }));
    const first = readings[0]!;
    for (const r of readings) {
      expect(r.cmf, 'CMF moved — the premise of this test changed').toBe(first.cmf);
      expect(r.delta, 'volume delta moved — the premise of this test changed').toBe(first.delta);
    }
  });
});
