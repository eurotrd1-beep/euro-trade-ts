/**
 * Indicator registry + dispatch.
 *
 * The Dart engine dispatches through one giant `switch (r.indicator)` inside
 * `SignalEngine._computeIndicator`. Here that switch becomes a lookup table:
 * same names, same inputs, same outputs — but each indicator is an isolated,
 * individually testable unit instead of a branch in an 680-line switch.
 *
 * An indicator that is not registered yet is *not* an error during the
 * migration: the parity test reports it as "not ported" rather than "wrong".
 * That distinction is what makes the port safe to do incrementally.
 */

import type { Candle, IndicatorValue, StrategyRule } from './types.js';

/** Everything an indicator is allowed to read. Mirrors the Dart engine's state. */
export interface IndicatorContext {
  readonly candles: readonly Candle[];
  readonly rule: StrategyRule;
  /**
   * Dart's `_currentPrice`. Several indicators read it instead of the last
   * close, so it is passed explicitly rather than derived — in the live engine
   * it tracks the ticker and is only synced to `candles.last.close` when
   * `setRealCandles` runs.
   */
  readonly currentPrice: number;
  /**
   * Wall-clock readings, supplied by the caller rather than read inside the
   * indicators. Ten indicators branch on the clock (kill_zone, session,
   * day_of_week, judas_swing, silver_bullet, …); injecting the reading keeps
   * them deterministic and therefore testable.
   *
   * Mirrors exactly what the Dart code reads — note the two differ:
   *   utcHour — `DateTime.now().toUtc().hour`
   *   weekday — `DateTime.now().weekday`, i.e. LOCAL time, Mon=1 … Sun=7
   */
  readonly clock: EngineClock;
  /** Memoised sub-results, mirroring the Dart `cache` map. */
  readonly cache: Map<string, unknown>;
}

export interface EngineClock {
  /** Hour 0-23 in UTC. */
  utcHour: number;
  /** Day of week in LOCAL time. Monday = 1 … Sunday = 7 (Dart convention). */
  weekday: number;
}

/** Production clock: reads the real time the same way the Dart engine does. */
export function systemClock(now: Date = new Date()): EngineClock {
  // Dart's DateTime.weekday is Mon=1..Sun=7; JS getDay() is Sun=0..Sat=6.
  const jsDay = now.getDay();
  return { utcHour: now.getUTCHours(), weekday: jsDay === 0 ? 7 : jsDay };
}

export type IndicatorFn = (ctx: IndicatorContext) => IndicatorValue;

const registry = new Map<string, IndicatorFn>();

/** Registers one or more indicator names against a single implementation. */
export function register(names: string | string[], fn: IndicatorFn): void {
  for (const name of Array.isArray(names) ? names : [names]) {
    if (registry.has(name)) {
      throw new Error(`Indicator "${name}" is already registered`);
    }
    registry.set(name, fn);
  }
}

export function isRegistered(name: string): boolean {
  return registry.has(name);
}

export function registeredNames(): string[] {
  return [...registry.keys()].sort();
}

/**
 * Names in REGISTRATION order rather than alphabetical.
 *
 * `register(['advanced_candle', 'doji', …], fn)` names one implementation
 * thirteen times. The first name in that list is the one the implementation was
 * written for, and the rest are labels pointing at it — a distinction the
 * alphabetical list destroys (it would elect `abandoned_baby`). See aliases.ts.
 */
export function registeredNamesInOrder(): string[] {
  return [...registry.keys()];
}

/**
 * The implementation behind a name, or undefined. Exposed so tooling can
 * inspect an indicator — `scripts/build-strategy-reference.mts` reads the
 * function source to work out which rule parameters it consults.
 */
export function indicatorFor(name: string): IndicatorFn | undefined {
  return registry.get(name);
}

/**
 * Dart parity: the cache key folds in the rule params, so two rules that differ
 * only in, say, `period` do not share a cached value.
 * Source: `'${r.indicator}_${r.period}_${r.fast}_${r.slow}_${r.smooth}_${r.stddev}'`
 *
 * `value` and `tolerance` are appended here, and the Dart key is missing both.
 * That is a FIX, not a divergence — see test/cache-key.test.ts. Most indicators
 * treat `value` as the threshold `checkCondition` applies afterwards, so it has
 * no business in the key; but supertrend reads it as the ATR multiplier,
 * fibonacci as the retracement level, and monte_carlo_risk_simulation as the
 * risk threshold. For those three, two rules differing only in `value` shared
 * one entry and the first to run answered for both.
 *
 * It stayed invisible because it only bites when the two parameters actually
 * disagree on the data at hand. Dart needs the same fix — PENDING_DART_PORT.
 */
export function cacheKey(r: StrategyRule): string {
  return `${r.indicator}_${r.period}_${r.fast}_${r.slow}_${r.smooth}_${r.stddev}_${r.tolerance}_${r.value}`;
}

/**
 * Computes an indicator. Returns `undefined` when the indicator has no
 * implementation yet — callers during migration treat that as "not ported".
 *
 * Note the Dart `default:` branch returns 0.0 for unknown names. That fallback
 * is applied by the production entry point, not here, so the parity test can
 * still tell a genuine 0.0 apart from a missing port.
 */
export function computeIndicator(
  candles: readonly Candle[],
  rule: StrategyRule,
  currentPrice: number,
  clock: EngineClock = systemClock(),
  cache: Map<string, unknown> = new Map(),
): IndicatorValue | undefined {
  const fn = registry.get(rule.indicator);
  if (!fn) return undefined;

  const key = cacheKey(rule);
  if (cache.has(key)) return cache.get(key) as IndicatorValue;

  const result = fn({ candles, rule, currentPrice, clock, cache });
  cache.set(key, result);
  return result;
}
