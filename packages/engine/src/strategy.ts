/**
 * Strategy evaluation — condition checks, category consensus and the pyramid.
 *
 * Ported from signal_engine.dart:
 *   _checkCondition                 → checkCondition
 *   getCategoryForIndicator         → categoryForIndicator
 *   evaluateStrategyProWithCache    → evaluateStrategyPro
 *   _evaluateRules                  → evaluateRules
 *
 * This is the layer that turns 359 indicator values into a CALL/PUT decision,
 * so every threshold and ordering below is reproduced exactly.
 */

import { computeIndicator, systemClock, type EngineClock } from './registry.js';
import type { Candle, IndicatorValue, StrategyRule } from './types.js';

// ── Strategy shapes ─────────────────────────────────────────────────────────

/** Mirrors Dart's `PyramidConfig`, including its defaults. */
export interface PyramidConfig {
  minPrimaryScore: number;
  confirmationRatio: number;
  requireAllFilters: boolean;
  waitMessage: string;
}

export const DEFAULT_PYRAMID: PyramidConfig = {
  minPrimaryScore: 3.0,
  confirmationRatio: 0.5,
  requireAllFilters: true,
  waitMessage: 'الهرم لم يكتمل — انتظار الشمعة القادمة',
};

/** Mirrors Dart's `DynamicStrategy`. `pyramid: null` selects standard scoring. */
export interface DynamicStrategy {
  name: string;
  minScore: number;
  maxScore: number;
  confidenceBase: number;
  confidenceMax: number;
  rules: StrategyRule[];
  pyramid: PyramidConfig | null;
}

/**
 * Dart's `effectiveMaxScore`: an explicit max_score, else the sum of the
 * ABSOLUTE scores of enabled rules, else 1.0 so the strength bar never
 * divides by zero.
 */
export function effectiveMaxScore(strategy: DynamicStrategy): number {
  if (strategy.maxScore > 0) return strategy.maxScore;
  const sum = strategy.rules
    .filter((r) => r.enabled)
    .reduce((s, r) => s + Math.abs(r.score), 0);
  return sum > 0 ? sum : 1.0;
}

// ── Condition checks ────────────────────────────────────────────────────────

/**
 * signal_engine.dart:1573 — `_checkCondition`.
 *
 * String results and numeric results follow completely different paths. Note
 * the string `default:` compares the VALUE against `r.condition` itself, which
 * is how rules match labels like 'higher_high_higher_low' or 'sell_side'.
 */
export function checkCondition(rule: StrategyRule, raw: IndicatorValue): boolean {
  if (typeof raw === 'string') {
    const target = rule.pattern ?? (rule.value != null ? String(rule.value) : '');
    switch (rule.condition) {
      case 'eq':
        return raw === target;
      case 'neq':
        return raw !== target;
      case 'bullish':
        return (
          raw.includes('bullish') || raw.includes('hammer') || raw.includes('morning') ||
          raw.includes('soldiers') || raw.includes('pin_bar_b')
        );
      case 'bearish':
        return (
          raw.includes('bearish') || raw.includes('shooting') || raw.includes('evening') ||
          raw.includes('crows') || raw.includes('pin_bar_bear')
        );
      default:
        return raw === rule.condition;
    }
  }

  const v = raw;
  const value = rule.value ?? 0;
  switch (rule.condition) {
    case 'gt': return v > value;
    case 'lt': return v < value;
    case 'gte': return v >= value;
    case 'lte': return v <= value;
    case 'eq': return v === value;
    case 'neq': return v !== value;
    case 'between': return v >= (rule.valueMin ?? 0) && v <= (rule.valueMax ?? 0);
    case 'bullish': return v > 0;
    case 'bearish': return v < 0;
    case 'is_true': return v !== 0;
    case 'is_false': return v === 0;
    case 'gt_average': return v > 1.0;
    case 'lt_average': return v < 1.0;
    default: return false;
  }
}

// ── Category consensus ──────────────────────────────────────────────────────

const TREND = new Set([
  'ichimoku', 'supertrend', 'alligator', 'parabolic_sar', 'sar', 'sma', 'ema', 'wma',
  'hma', 'hull_ma', 'dema', 'tema', 'alma', 'lsma', 'kama', 't3', 'linear_regression',
  'dow_theory', 'trend_following', 'kalman', 'mtf', 'multi_timeframe_alignment',
]);

const PRICE_LEVELS = new Set([
  'pivot_point', 'pivot', 'cpr', 'pdh', 'pdl', 'pdh_pdl', 'sr_support', 'sr_resistance',
  'orb', 'opening_range_breakout', 'opening_range', 'vwap', 'anchored_vwap', 'vwap_bands',
  'price_vs_vwap', 'keltner_channels', 'donchian_channels', 'support_resistance',
  'sr_position', 'sr_bounce',
]);

/**
 * The Fibonacci family gets its own category rather than joining Price Levels.
 *
 * The consensus multiplier counts DISTINCT categories among the agreeing
 * primary rules, so a strategy confirming a level two ways — a Fibonacci
 * retracement and a swing high — earns 1.15x for genuinely independent
 * evidence. Folded into one category it would earn nothing for the second.
 */
const FIBONACCI = new Set([
  'fib_retracement', 'fib_extension', 'fib_level', 'fib_zone', 'fib_bounce', 'fib_distance',
]);

const ADVANCED_STATS = new Set([
  'z_score', 'zscore', 'hurst_exponent', 'entropy_analysis', 'regime_detection',
  'market_regime_classification', 'volatility_regime_analysis', 'anomaly_detection',
  'spectral_analysis', 'monte_carlo_risk_simulation', 'wavelet_decomposition',
  'kelly_criterion', 'choppiness', 'choppiness_index',
]);

const RARE_PATTERNS = new Set([
  'three_bar_reversal', 'island_reversal', 'exhaustion_gap', 'breakout', 'candle_pattern',
  'candles', 'wyckoff', 'wyckoff_phase', 'wyckoff_spring', 'wyckoff_upthrust',
  'elliott_wave', 'order_block', 'fair_value_gap', 'breaker_block', 'rejection_block',
  'mitigation_block', 'inverse_fvg', 'imbalance', 'bpr', 'liquidity_sweep',
  'equal_highs', 'equal_lows', 'eqh', 'eql', 'gartley', 'bat', 'alternate_bat',
  'butterfly', 'crab', 'deep_crab', 'shark', 'cypher', 'ab_cd', 'three_drives', '5_0',
]);

const OSCILLATORS = new Set([
  'rsi', 'macd_histogram', 'macd_line', 'macd_signal', 'cci', 'mfi', 'cmf',
  'williams_r', 'roc',
]);

/**
 * signal_engine.dart:1689 — `getCategoryForIndicator`.
 * An explicit `type` on the rule always wins; otherwise the indicator name is
 * classified. The category set drives the consensus multiplier below, so a
 * miscategorised indicator silently changes scoring.
 */
export function categoryForIndicator(rule: StrategyRule): string {
  if (rule.type.length > 0) return rule.type;
  const ind = rule.indicator.toLowerCase();

  if (TREND.has(ind) || ind.includes('vortex') || ind.includes('aroon')) return 'Trend';
  if (PRICE_LEVELS.has(ind) || ind.includes('bollinger') || ind.startsWith('bb_')) {
    return 'Price Levels';
  }
  if (FIBONACCI.has(ind)) return 'Fibonacci';
  if (ADVANCED_STATS.has(ind)) return 'Advanced Statistics';
  if (RARE_PATTERNS.has(ind) || ind.startsWith('harmonic')) return 'Rare Patterns';
  if (OSCILLATORS.has(ind) || ind.startsWith('stoch')) return 'Oscillators';
  return 'Other';
}

/** Consensus multiplier by the number of distinct agreeing categories. */
function consensusMultiplier(count: number): number {
  if (count <= 1) return 1.0;
  if (count === 2) return 1.15;
  if (count === 3) return 1.3;
  return 1.5;
}

/** Minimum score gap between the two directions before a signal is allowed. */
const MIN_GAP = 4.0;

/**
 * Formats a number the way Dart prints a `double`, i.e. whole values keep a
 * `.0` suffix (Dart: `3.0.toString() == '3.0'`, JS: `String(3) === '3'`).
 *
 * This matters because the rejection reasons below are shown to the user in the
 * WAIT banner, so the two runtimes have to produce identical text.
 */
function dartDouble(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}

// ── Pyramid evaluation ──────────────────────────────────────────────────────

export interface ProResult {
  result: 'SIGNAL' | 'NO_SIGNAL';
  direction: 'CALL' | 'PUT' | null;
  confidenceTier: 'STRONG' | 'MEDIUM' | 'WEAK' | null;
  rawScore: { CALL: number; PUT: number };
  finalScore: { CALL: number; PUT: number };
  categoryCount: { CALL: number; PUT: number };
  gap: number;
  filterPassed: boolean;
  confirmAlignment: 'aligned' | 'conflict' | 'neutral';
  reasonBlocked: string | null;
}

export interface EvalContext {
  candles: readonly Candle[];
  currentPrice: number;
  clock?: EngineClock;
  cache?: Map<string, unknown>;
}

/**
 * signal_engine.dart:1827 — `evaluateStrategyProWithCache`.
 *
 * Three stages, in this order:
 *   1. primary  — sets the direction; scores are multiplied by category consensus
 *   2. filter   — hard gates, any failure blocks
 *   3. confirm  — a ratio of confirming rules must agree
 * plus untagged "base" rules that add weight without blocking.
 *
 * An indicator that throws is skipped (`continue`) in the primary/confirm/base
 * loops but counts as a FAILED filter — that asymmetry is intentional in the
 * original and is preserved.
 */
export function evaluateStrategyPro(strategy: DynamicStrategy, ctx: EvalContext): ProResult {
  const { candles, currentPrice } = ctx;
  const clock = ctx.clock ?? systemClock();
  const cache = ctx.cache ?? new Map<string, unknown>();

  const compute = (r: StrategyRule): IndicatorValue => {
    const v = computeIndicator(candles, r, currentPrice, clock, cache);
    // Dart's switch has `default: result = 0.0` for unknown indicator names.
    return v === undefined ? 0.0 : v;
  };

  const rules = strategy.rules.filter((r) => r.enabled);
  const primary = rules.filter((r) => r.role === 'primary');
  const confirm = rules.filter((r) => r.role === 'confirm');
  const filters = rules.filter((r) => r.role === 'filter');

  // ── [1][2] Primary rules: raw scores + agreeing categories ────────────────
  let rawCall = 0.0, rawPut = 0.0;
  const categoriesCall = new Set<string>();
  const categoriesPut = new Set<string>();

  for (const r of primary) {
    try {
      if (!checkCondition(r, compute(r))) continue;
      const cat = r.type.length > 0 ? r.type : categoryForIndicator(r);

      if (r.signal === 'CALL') {
        rawCall += r.score;
        if (cat) categoriesCall.add(cat);
      } else if (r.signal === 'PUT') {
        rawPut += r.score;
        if (cat) categoriesPut.add(cat);
      } else if (r.signal === 'dominant' || r.signal === 'confirm') {
        // Ties go to CALL, and the comparison uses the running totals, so rule
        // ORDER affects the outcome here.
        if (rawCall >= rawPut) {
          rawCall += r.score;
          if (cat) categoriesCall.add(cat);
        } else {
          rawPut += r.score;
          if (cat) categoriesPut.add(cat);
        }
      }
    } catch {
      continue;
    }
  }

  // ── [3] Category consensus multiplier ─────────────────────────────────────
  const multipliedCall = rawCall * consensusMultiplier(categoriesCall.size);
  const multipliedPut = rawPut * consensusMultiplier(categoriesPut.size);

  const isPrimaryCall = multipliedCall >= multipliedPut;
  const primaryDir: 'CALL' | 'PUT' = isPrimaryCall ? 'CALL' : 'PUT';
  const winningPrimaryScore = isPrimaryCall ? multipliedCall : multipliedPut;

  // ── [4] Filter gate ───────────────────────────────────────────────────────
  let filterPassed = true;
  let filterFailReason: string | null = null;
  for (const r of filters) {
    try {
      if (!checkCondition(r, compute(r))) {
        filterPassed = false;
        filterFailReason = `فشل فلتر "${r.indicator}"`;
        break;
      }
    } catch {
      filterPassed = false;
      filterFailReason = `خطأ أثناء حساب فلتر "${r.indicator}"`;
      break;
    }
  }

  // ── [5] Confirmation layer ────────────────────────────────────────────────
  let agreed = 0, totalConfirm = 0, opposingTrue = 0, confirmScoreAdded = 0.0;
  for (const r of confirm) {
    totalConfirm++;
    try {
      const isTrue = checkCondition(r, compute(r));
      const ruleDir = r.signal === 'dominant' || r.signal === 'confirm' ? primaryDir : r.signal;
      if (isTrue) {
        if (ruleDir === primaryDir) {
          agreed++;
          confirmScoreAdded += r.score;
        } else {
          opposingTrue++;
        }
      }
    } catch {
      continue;
    }
  }

  let finalCall = multipliedCall;
  let finalPut = multipliedPut;
  if (primaryDir === 'CALL') finalCall += confirmScoreAdded;
  else finalPut += confirmScoreAdded;

  // ── Base (untagged) rules: weight only, never blocking ────────────────────
  const base = rules.filter(
    (r) => r.role !== 'primary' && r.role !== 'confirm' && r.role !== 'filter',
  );
  for (const r of base) {
    try {
      if (!checkCondition(r, compute(r))) continue;
      if (r.signal === 'CALL') finalCall += r.score;
      else if (r.signal === 'PUT') finalPut += r.score;
      else if (r.signal === 'dominant' || r.signal === 'confirm') {
        if (finalCall >= finalPut) finalCall += r.score;
        else finalPut += r.score;
      }
    } catch {
      continue;
    }
  }

  const finalWinningScore = primaryDir === 'CALL' ? finalCall : finalPut;
  const finalOppositeScore = primaryDir === 'CALL' ? finalPut : finalCall;
  const gap = Math.abs(finalWinningScore - finalOppositeScore);

  let confirmAlignment: ProResult['confirmAlignment'] = 'neutral';
  if (totalConfirm > 0) {
    if (opposingTrue > 0) confirmAlignment = 'conflict';
    else if (agreed > 0) confirmAlignment = 'aligned';
  }

  // ── [6] Decision ──────────────────────────────────────────────────────────
  const minPrimary = strategy.pyramid?.minPrimaryScore ?? DEFAULT_PYRAMID.minPrimaryScore;
  const ratioNeeded = strategy.pyramid?.confirmationRatio ?? DEFAULT_PYRAMID.confirmationRatio;

  let reasonBlocked: string | null = null;
  if (winningPrimaryScore < minPrimary) {
    reasonBlocked =
      `المرحلة الأولى (الأساس): النتيجة ${winningPrimaryScore.toFixed(1)} < الحد الأدنى ${dartDouble(minPrimary)}`;
  } else if (strategy.pyramid?.requireAllFilters === true && !filterPassed) {
    reasonBlocked = `المرحلة الثالثة (الفلاتر): ${filterFailReason}`;
  } else if (totalConfirm > 0 && agreed / totalConfirm < ratioNeeded) {
    const pct = Math.round((agreed / totalConfirm) * 100);
    reasonBlocked =
      `المرحلة الثانية (التأكيد): ${agreed}/${totalConfirm} = ${pct}% < الحد الأدنى ${Math.round(ratioNeeded * 100)}%`;
  } else if (gap < MIN_GAP) {
    reasonBlocked =
      `الفارق بين الاتجاهين ${gap.toFixed(1)} < حد الفارق الأدنى (${MIN_GAP.toFixed(1)})`;
  }

  // ── [7] Confidence tier ───────────────────────────────────────────────────
  let confidenceTier: ProResult['confidenceTier'] = null;
  if (reasonBlocked === null) {
    const catCount = primaryDir === 'CALL' ? categoriesCall.size : categoriesPut.size;
    if (catCount >= 3 && confirmAlignment !== 'conflict') confidenceTier = 'STRONG';
    else if (
      (catCount === 2 && confirmAlignment !== 'conflict') ||
      (catCount >= 3 && confirmAlignment === 'conflict')
    ) confidenceTier = 'MEDIUM';
    else confidenceTier = 'WEAK';
  }

  return {
    result: reasonBlocked === null ? 'SIGNAL' : 'NO_SIGNAL',
    direction: reasonBlocked === null ? primaryDir : null,
    confidenceTier,
    rawScore: { CALL: rawCall, PUT: rawPut },
    finalScore: { CALL: finalCall, PUT: finalPut },
    categoryCount: { CALL: categoriesCall.size, PUT: categoriesPut.size },
    gap,
    filterPassed,
    confirmAlignment,
    reasonBlocked,
  };
}

/**
 * signal_engine.dart:1637 — `_evaluateRules`.
 * Returns a single signed score: positive favours CALL, negative favours PUT.
 * Pyramid strategies return 0 when the pyramid blocks, which reads as "no edge".
 */
export function evaluateRules(strategy: DynamicStrategy, ctx: EvalContext): number {
  const cache = ctx.cache ?? new Map<string, unknown>();

  if (strategy.pyramid != null) {
    const pro = evaluateStrategyPro(strategy, { ...ctx, cache });
    if (pro.result !== 'SIGNAL') return 0.0;
    return pro.finalScore.CALL - pro.finalScore.PUT;
  }

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
        if (callScore >= putScore) callScore += rule.score;
        else putScore += rule.score;
      }
    } catch {
      continue;
    }
  }
  return callScore - putScore;
}

// ── JSON loading ────────────────────────────────────────────────────────────

/** Mirrors Dart's `PyramidConfig.fromJson`. */
export function pyramidFromJson(j: Record<string, unknown>): PyramidConfig {
  const num = (v: unknown, d: number): number => (v == null ? d : Number(v));
  return {
    minPrimaryScore: num(j['min_primary_score'], 3.0),
    confirmationRatio: num(j['confirmation_ratio'], 0.5),
    requireAllFilters: (j['require_all_filters'] as boolean | undefined) ?? true,
    waitMessage: (j['wait_message'] as string | undefined) ?? DEFAULT_PYRAMID.waitMessage,
  };
}
