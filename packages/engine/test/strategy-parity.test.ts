/**
 * Strategy-layer parity gate.
 *
 * The indicator gate proves every indicator computes the same number. This one
 * proves the layer that turns those numbers into a trade: role handling,
 * category consensus, the three pyramid stages, the gap threshold and the
 * confidence tier.
 *
 * Scenarios are replayed from the exact rule lists the Dart harness recorded,
 * so nothing is reconstructed by guesswork.
 *
 * Fixture: packages/engine/golden/engine-golden.json  (`strategies`)
 * Recorded by: tools/golden-dart/lib/services/signal_engine_scenarios.dart
 */

import { describe, expect, it } from 'vitest';
import golden from '../golden/engine-golden.json' with { type: 'json' };
import { evaluateRules, evaluateStrategyPro, effectiveMaxScore, type DynamicStrategy } from '../src/strategy.js';
import { makeRule, type Candle, type StrategyRule } from '../src/types.js';
import '../src/indicators/index.js';

const REL_TOLERANCE = 1e-12;

interface RuleJson {
  indicator: string; condition: string; signal: string; score: number;
  enabled: boolean; role: string; type: string;
  period: number; fast: number; slow: number; smooth: number; stddev: number;
  value: number | null; value_min: number | null; value_max: number | null;
  pattern: string | null;
}

interface ScenarioJson {
  name: string;
  strategy: {
    name: string; min_score: number; max_score: number;
    confidence_base: number; confidence_max: number;
    pyramid: {
      min_primary_score: number; confirmation_ratio: number;
      require_all_filters: boolean; wait_message: string;
    } | null;
    rules: RuleJson[];
  };
  effective_max_score: number;
  pro: {
    result: string; direction: string | null; confidence_tier: string | null;
    raw_score: { CALL: number; PUT: number };
    final_score: { CALL: number; PUT: number };
    category_count: { CALL: number; PUT: number };
    gap: number; filter_passed: boolean;
    confirm_alignment: string; reason_blocked: string | null;
  };
  evaluate_rules_score: number;
}

interface Fixture {
  currentPrice: number;
  clock: { utcHour: number; weekday: number };
  candles: Array<{ open: number; high: number; low: number; close: number; volume: number; time: string }>;
  strategies: ScenarioJson[];
}

const fixture = golden as unknown as Fixture;

const candles: Candle[] = fixture.candles.map((c) => ({
  open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  time: Date.parse(c.time),
}));
const currentPrice = fixture.currentPrice;
const clock = fixture.clock;

function toRule(r: RuleJson): StrategyRule {
  return makeRule({
    indicator: r.indicator, condition: r.condition, signal: r.signal, score: r.score,
    enabled: r.enabled, role: r.role, type: r.type,
    period: r.period, fast: r.fast, slow: r.slow, smooth: r.smooth, stddev: r.stddev,
    value: r.value, valueMin: r.value_min, valueMax: r.value_max, pattern: r.pattern,
  });
}

function toStrategy(s: ScenarioJson['strategy']): DynamicStrategy {
  return {
    name: s.name,
    minScore: s.min_score,
    maxScore: s.max_score,
    confidenceBase: s.confidence_base,
    confidenceMax: s.confidence_max,
    pyramid: s.pyramid
      ? {
          minPrimaryScore: s.pyramid.min_primary_score,
          confirmationRatio: s.pyramid.confirmation_ratio,
          requireAllFilters: s.pyramid.require_all_filters,
          waitMessage: s.pyramid.wait_message,
        }
      : null,
    rules: s.rules.map(toRule),
  };
}

function near(actual: number, expected: number): boolean {
  if (Object.is(actual, expected)) return true;
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1);
  return Math.abs(actual - expected) / scale <= REL_TOLERANCE;
}

describe('strategy parity with the Dart implementation', () => {
  it('fixture carries strategy scenarios', () => {
    expect(Array.isArray(fixture.strategies)).toBe(true);
    expect(fixture.strategies.length).toBeGreaterThan(0);
  });

  for (const scenario of fixture.strategies) {
    describe(scenario.name, () => {
      const strategy = toStrategy(scenario.strategy);
      const ctx = { candles, currentPrice, clock };

      it('effectiveMaxScore matches', () => {
        expect(near(effectiveMaxScore(strategy), scenario.effective_max_score)).toBe(true);
      });

      it('pyramid decision matches', () => {
        const pro = evaluateStrategyPro(strategy, ctx);
        const e = scenario.pro;

        expect(pro.result, 'result').toBe(e.result);
        expect(pro.direction, 'direction').toBe(e.direction);
        expect(pro.confidenceTier, 'confidence_tier').toBe(e.confidence_tier);
        expect(pro.filterPassed, 'filter_passed').toBe(e.filter_passed);
        expect(pro.confirmAlignment, 'confirm_alignment').toBe(e.confirm_alignment);
        expect(pro.categoryCount.CALL, 'category_count.CALL').toBe(e.category_count.CALL);
        expect(pro.categoryCount.PUT, 'category_count.PUT').toBe(e.category_count.PUT);

        expect(near(pro.rawScore.CALL, e.raw_score.CALL), `raw CALL ${pro.rawScore.CALL} vs ${e.raw_score.CALL}`).toBe(true);
        expect(near(pro.rawScore.PUT, e.raw_score.PUT), `raw PUT ${pro.rawScore.PUT} vs ${e.raw_score.PUT}`).toBe(true);
        expect(near(pro.finalScore.CALL, e.final_score.CALL), `final CALL ${pro.finalScore.CALL} vs ${e.final_score.CALL}`).toBe(true);
        expect(near(pro.finalScore.PUT, e.final_score.PUT), `final PUT ${pro.finalScore.PUT} vs ${e.final_score.PUT}`).toBe(true);
        expect(near(pro.gap, e.gap), `gap ${pro.gap} vs ${e.gap}`).toBe(true);

        // The rejection reason is user-facing Arabic text shown in the WAIT
        // banner, so it has to match character for character.
        expect(pro.reasonBlocked, 'reason_blocked').toBe(e.reason_blocked);
      });

      it('evaluateRules score matches', () => {
        const score = evaluateRules(strategy, ctx);
        expect(
          near(score, scenario.evaluate_rules_score),
          `${score} vs ${scenario.evaluate_rules_score}`,
        ).toBe(true);
      });
    });
  }
});
