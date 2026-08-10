/**
 * Guards `docs/strategy-reference.json` against drifting away from the engine.
 *
 * The previous, hand-written reference had rotted in a way nobody could see by
 * reading it: 31 of its indicator names did not exist, four of its documented
 * conditions were never implemented, and 187 real indicators were missing. The
 * engine answers an unknown name with 0.0 and an unknown condition with false —
 * silently — so a strategy built from it would have looked fine and quietly
 * scored nothing.
 *
 * The reference is generated now (scripts/build-strategy-reference.mts), and
 * these tests fail the build if it stops matching the registry. Adding an
 * indicator without regenerating is caught here rather than in production.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateStrategyPro,
  isRegistered,
  pyramidFromJson,
  registeredNames,
  ruleFromJson,
  systemClock,
  type Candle,
  type DynamicStrategy,
} from '../src/index.js';

const doc = JSON.parse(readFileSync(new URL('../../../docs/strategy-reference.json', import.meta.url), 'utf8'));
const golden = JSON.parse(readFileSync(new URL('../golden/engine-golden.json', import.meta.url), 'utf8'));
const candles: Candle[] = golden.candles;

const rules = (doc.rules as Array<Record<string, unknown>>).filter(
  (r) => typeof r['indicator'] === 'string',
);

/** Exactly the conditions `checkCondition` implements. Nothing else fires. */
const CONDITIONS = new Set([
  'gt', 'lt', 'gte', 'lte', 'between', 'gt_average', 'lt_average',
  'is_true', 'is_false', 'eq', 'neq', 'bullish', 'bearish',
]);

describe('the generated strategy reference', () => {
  it('names only indicators the engine has', () => {
    const unknown = rules
      .map((r) => r['indicator'] as string)
      .filter((name) => !isRegistered(name));
    expect(unknown, `unknown indicators would silently score 0: ${unknown.join(', ')}`).toEqual([]);
  });

  it('covers every registered indicator, once', () => {
    const documented = rules.map((r) => r['indicator'] as string);
    const missing = registeredNames().filter((n) => !documented.includes(n));
    expect(missing, `undocumented indicators: ${missing.join(', ')}`).toEqual([]);
    expect(new Set(documented).size, 'duplicate entries').toBe(documented.length);
  });

  it('uses only conditions the engine implements', () => {
    const bad = [...new Set(rules.map((r) => r['condition'] as string))].filter(
      (c) => !CONDITIONS.has(c),
    );
    expect(bad, `these conditions never evaluate true: ${bad.join(', ')}`).toEqual([]);
  });

  it('ships with every rule disabled, so an unedited copy is inert', () => {
    expect(rules.filter((r) => r['enabled'] !== false)).toEqual([]);
  });

  it('documents the conditions it actually permits', () => {
    const listed = new Set([
      ...Object.keys(doc._conditions._for_numbers),
      ...Object.keys(doc._conditions._for_text),
    ]);
    expect([...CONDITIONS].filter((c) => !listed.has(c))).toEqual([]);
  });

  it('produces a working strategy once roles are assigned', () => {
    const byName = (name: string) => {
      const raw = rules.find((r) => r['indicator'] === name);
      expect(raw, `${name} missing from the reference`).toBeDefined();
      return ruleFromJson(raw!);
    };

    const strategy: DynamicStrategy = {
      name: 'reference smoke test',
      minScore: 0,
      maxScore: 0,
      confidenceBase: doc.confidence_base,
      confidenceMax: doc.confidence_max,
      pyramid: pyramidFromJson({
        min_primary_score: 3,
        confirmation_ratio: 0.5,
        require_all_filters: false,
      }),
      rules: [
        { ...byName('supertrend'), enabled: true, role: 'primary', score: 3 },
        {
          ...byName('market_structure'),
          enabled: true,
          role: 'primary',
          score: 3,
          pattern: 'higher_high_higher_low',
        },
        {
          ...byName('rsi'),
          enabled: true,
          role: 'confirm',
          score: 2,
          condition: 'between',
          valueMin: 40,
          valueMax: 70,
        },
      ],
    };

    const pro = evaluateStrategyPro(strategy, {
      candles,
      currentPrice: candles[candles.length - 1]!.close,
      clock: systemClock(),
    });

    // The direction depends on the fixture; what matters is that the rules
    // resolved to real scores instead of the zeros an unknown name produces.
    expect(pro.finalScore.CALL + pro.finalScore.PUT).toBeGreaterThan(0);
    expect(pro.categoryCount.CALL + pro.categoryCount.PUT).toBeGreaterThan(0);
  });
});
