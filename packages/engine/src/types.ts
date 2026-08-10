/**
 * Core engine types — ported 1:1 from euro_trade/lib/services/signal_engine.dart.
 *
 * Field names, defaults and semantics are deliberately identical to the Dart
 * originals. Nothing here is "improved": the migration contract is that the
 * TypeScript engine produces byte-identical results to the Dart one.
 */

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** UTC timestamp. Dart side is a DateTime; here it is milliseconds since epoch. */
  time: number;
}

/** Result of an indicator computation: a number, or a pattern/label string. */
export type IndicatorValue = number | string;

/**
 * Mirrors Dart's `StrategyRule`. Defaults match the Dart constructor exactly —
 * period 14, fast 9, slow 21, smooth 3, stddev 2.0 — because those defaults
 * feed straight into indicator maths.
 */
export interface StrategyRule {
  indicator: string;
  /** gt, lt, gte, lte, eq, neq, between, bullish, bearish */
  condition: string;
  /** CALL, PUT, dominant/confirm */
  signal: string;
  score: number;
  enabled: boolean;
  /** primary | confirm | filter | '' */
  role: string;
  /** Category / school of analysis (Trend, Oscillator, …) */
  type: string;
  period: number;
  fast: number;
  slow: number;
  smooth: number;
  stddev: number;
  /**
   * Proximity band, as a percentage. Used by the level indicators to decide
   * how close counts as "at" a level. Not read by any ported Dart indicator —
   * it exists for the TypeScript-only level family. See PENDING_DART_PORT.
   */
  tolerance: number;
  value: number | null;
  valueMin: number | null;
  valueMax: number | null;
  pattern: string | null;
}

/** Applies the same defaults as the Dart `StrategyRule` constructor. */
export function makeRule(
  partial: Partial<StrategyRule> & Pick<StrategyRule, 'indicator' | 'condition' | 'signal' | 'score'>,
): StrategyRule {
  return {
    enabled: true,
    role: '',
    type: '',
    period: 14,
    fast: 9,
    slow: 21,
    smooth: 3,
    stddev: 2.0,
    tolerance: 0.15,
    value: null,
    valueMin: null,
    valueMax: null,
    pattern: null,
    ...partial,
  };
}

/**
 * Mirrors Dart's `StrategyRule.fromJson`, including its fallback chains
 * (`type` ← `category`, `value` ← `level`, `pattern` ← `session` ← `wave`).
 */
export function ruleFromJson(j: Record<string, unknown>): StrategyRule {
  const num = (v: unknown): number | null =>
    typeof v === 'number' ? v : v == null ? null : Number(v);

  return {
    indicator: j['indicator'] as string,
    condition: j['condition'] as string,
    signal: j['signal'] as string,
    score: Number(j['score']),
    enabled: (j['enabled'] as boolean | undefined) ?? true,
    role: (j['role'] as string | undefined) ?? '',
    type: (j['type'] as string | undefined) ?? (j['category'] as string | undefined) ?? '',
    period: num(j['period']) ?? 14,
    fast: num(j['fast']) ?? 9,
    slow: num(j['slow']) ?? 21,
    smooth: num(j['smooth']) ?? 3,
    stddev: num(j['stddev']) ?? 2.0,
    tolerance: num(j['tolerance']) ?? 0.15,
    value: num(j['value']) ?? num(j['level']),
    valueMin: num(j['value_min']),
    valueMax: num(j['value_max']),
    pattern:
      (j['pattern'] as string | undefined) ??
      (j['session'] as string | undefined) ??
      (j['wave'] != null ? String(j['wave']) : null),
  };
}
