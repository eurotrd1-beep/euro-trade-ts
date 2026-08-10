/**
 * V2 scorer, confidence curve and trade-outcome parity.
 *
 * The V2 scorer only runs when no rule-based strategy is loaded — which is the
 * default state for a fresh install, so it decides real trades. It has two
 * order dependencies (the volume-spike bonus and the damping filters), and the
 * only way to know they survived the port is to diff against the Dart run.
 */

import { describe, expect, it } from 'vitest';
import golden from '../golden/engine-golden.json' with { type: 'json' };
import { strategyConfigFromJson } from '../src/config.js';
import { scoreV2 } from '../src/scoring.js';
import { confidenceFor, outcomeFor, tieEpsilon, alignExpiry } from '../src/signal.js';
import type { Candle } from '../src/types.js';
import '../src/indicators/index.js';

const REL_TOLERANCE = 1e-12;

interface Fixture {
  currentPrice: number;
  candles: Array<{ open: number; high: number; low: number; close: number; volume: number; time: string }>;
  v2: Array<{ name: string; config: Record<string, unknown>; score: number; confidence: number }>;
  outcomes: Array<{ direction: string; entry: number; exit: number; tie_eps: number; result: string }>;
}

const fixture = golden as unknown as Fixture;

const candles: Candle[] = fixture.candles.map((c) => ({
  open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  time: Date.parse(c.time),
}));
const currentPrice = fixture.currentPrice;

function near(actual: number, expected: number): boolean {
  if (Object.is(actual, expected)) return true;
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1);
  return Math.abs(actual - expected) / scale <= REL_TOLERANCE;
}

describe('V2 parametric scorer parity', () => {
  for (const s of fixture.v2) {
    it(s.name, () => {
      const cfg = strategyConfigFromJson(s.config);
      const score = scoreV2(candles, currentPrice, cfg);
      expect(near(score, s.score), `score ${score} vs ${s.score}`).toBe(true);

      const conf = confidenceFor(Math.abs(score), cfg.confidenceBase, cfg.confidenceMax);
      expect(near(conf, s.confidence), `confidence ${conf} vs ${s.confidence}`).toBe(true);
    });
  }
});

describe('trade outcome parity', () => {
  for (const o of fixture.outcomes) {
    it(`${o.direction} ${o.entry} → ${o.exit} = ${o.result}`, () => {
      expect(near(tieEpsilon(o.entry), o.tie_eps)).toBe(true);
      expect(outcomeFor(o.direction as 'CALL' | 'PUT', o.entry, o.exit)).toBe(o.result);
    });
  }
});

describe('expiry alignment', () => {
  // Dart snaps back to the start of the current 1-minute candle, so a trade
  // started mid-candle is SHORTER than the nominal duration.
  it('snaps to the candle open', () => {
    const now = Date.UTC(2026, 0, 1, 12, 34, 20); // 20s into the candle
    const a = alignExpiry(now, 5);
    expect(new Date(a.entryTime).toISOString()).toBe('2026-01-01T12:34:00.000Z');
    expect(new Date(a.expiryTime).toISOString()).toBe('2026-01-01T12:39:00.000Z');
    expect(a.durationSeconds).toBe(5 * 60 - 20);
  });

  it('gives the full duration exactly on a candle boundary', () => {
    const now = Date.UTC(2026, 0, 1, 12, 34, 0);
    expect(alignExpiry(now, 3).durationSeconds).toBe(180);
  });

  it('never returns a non-positive duration', () => {
    // 59s into the candle with a 0-minute selection would otherwise go negative.
    const now = Date.UTC(2026, 0, 1, 12, 34, 59);
    expect(alignExpiry(now, 0).durationSeconds).toBe(1);
  });
});
