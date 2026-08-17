/**
 * Strategy evaluation — the entry point the rest of the system calls.
 *
 * ── THE PYRAMID IS GONE ────────────────────────────────────────────────────
 *
 * There used to be a decision layer here: primary rules scored by category,
 * a consensus multiplier weighted by a measured correlation matrix, a
 * confirmation axis, filter gates, and a `min_primary_score` threshold. It was
 * removed on request, with everything that only existed to serve it — the
 * correlation calibration and the file it was built into, the category tables,
 * the 38 tests, and the admin panel that published a matrix on every upload.
 *
 * What is left is the flat scorer below, which is the path the Dart engine
 * always had: every enabled rule whose condition holds adds its score to its
 * own side, and the answer is CALL minus PUT. `min_score` on the strategy is
 * the only gate, and it is applied by the caller, not here.
 *
 * The practical consequence for anyone writing a strategy: nothing weights,
 * dampens or blocks any more. Ten rules that all read the same thing count ten
 * times, because the layer that used to notice that was the pyramid.
 */

import { computeIndicator, systemClock, type EngineClock } from './registry.js';
import { checkCondition } from './conditions.js';
import type { Candle, StrategyRule } from './types.js';

export { checkCondition } from './conditions.js';

/**
 * A strategy as the app loads it from a `configs` row.
 *
 * The `pyramid` field is not optional here — it is absent. A strategy file
 * that still carries a `pyramid` block loads fine and the block is ignored;
 * `parseStrategy` in the app drops it on the way in.
 */
export interface DynamicStrategy {
  name: string;
  /** The gate: |CALL − PUT| must reach this or no signal is produced. */
  minScore: number;
  /** Denominator behind the strength bar. 0 means "sum the enabled rules". */
  maxScore: number;
  confidenceBase: number;
  confidenceMax: number;
  rules: StrategyRule[];
}

/** Everything an evaluation needs: the market, and where to cache. */
export interface EvalContext {
  candles: readonly Candle[];
  currentPrice: number;
  clock?: EngineClock;
  /** Shared across the rules of one evaluation so an indicator runs once. */
  cache?: Map<string, unknown>;
}

/**
 * An explicit `max_score`, else the sum of the ABSOLUTE scores of enabled
 * rules, else 1.0 so the strength bar never divides by zero.
 */
export function effectiveMaxScore(strategy: DynamicStrategy): number {
  if (strategy.maxScore > 0) return strategy.maxScore;
  const sum = strategy.rules
    .filter((r) => r.enabled)
    .reduce((s, r) => s + Math.abs(r.score), 0);
  return sum > 0 ? sum : 1.0;
}

/**
 * A single signed score: positive favours CALL, negative favours PUT.
 *
 * A rule that throws is skipped rather than failing the evaluation, which is
 * what Dart does — one indicator hitting a short window must not cost the
 * strategy every other rule it has.
 */
export function evaluateRules(strategy: DynamicStrategy, ctx: EvalContext): number {
  const cache = ctx.cache ?? new Map<string, unknown>();
  const { candles, currentPrice } = ctx;
  const clock = ctx.clock ?? systemClock();

  let callScore = 0.0, putScore = 0.0;
  for (const rule of strategy.rules) {
    if (!rule.enabled) continue;
    try {
      const raw = computeIndicator(candles, rule, currentPrice, clock, cache) ?? 0.0;
      if (!checkCondition(rule, raw)) continue;
      if (rule.signal === 'CALL') callScore += rule.score;
      else if (rule.signal === 'PUT') putScore += rule.score;
      else if (rule.signal === 'dominant' || rule.signal === 'confirm') {
        // A first-mover ratchet: at 0–0 the tie goes to CALL, and once a side
        // leads these rules keep feeding it. It is not neutral and never was —
        // a strategy built out of `dominant` rules alone can only ever produce
        // CALL. Kept because it is how Dart scored these rules and existing
        // files depend on it; `check-live-strategies` refuses new ones.
        if (callScore >= putScore) callScore += rule.score;
        else putScore += rule.score;
      }
    } catch {
      continue;
    }
  }
  return callScore - putScore;
}
