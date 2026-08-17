/**
 * `checkCondition` — does one rule's condition hold for the value measured?
 *
 * This is the entire comparison layer, and it is unchanged: the body below is
 * the same code that ran under `pyramid/conditions.ts`, recovered from the
 * vendored bundle rather than retyped, because a rule that compares slightly
 * differently is a strategy that fires on different candles. It moved here
 * because the pyramid it lived under is gone and the comparison is not.
 *
 * Two behaviours below look like bugs and are not:
 *
 *   • TEXT `bullish` / `bearish` match a label that CONTAINS the word, and
 *     also the specific pattern names that ARE bullish or bearish without
 *     saying so — 'hammer', 'morning_star', 'three_white_soldiers'. An exact
 *     match would answer false for every one of them.
 *   • TEXT with an unknown condition falls back to `raw === rule.condition`,
 *     so a rule written as `condition: 'golden'` still works. It was reachable
 *     from real strategy files and removing it would break them silently.
 *
 * The engine has no error channel: an unknown condition on a NUMBER answers
 * false, and so does every condition on the wrong type. A rule asking `gt 30`
 * of a TEXT indicator never fires and nothing anywhere says so — which is what
 * `strategyCheck` and `check-live-strategies` exist to catch, before publish,
 * because that is the only place it can be caught.
 */

import type { IndicatorValue, StrategyRule } from './types.js';

export function checkCondition(rule: StrategyRule, raw: IndicatorValue): boolean {
  if (typeof raw === 'string') {
    const target = rule.pattern ?? (rule.value != null ? String(rule.value) : '');
    switch (rule.condition) {
      case 'eq':
        return raw === target;
      case 'neq':
        return raw !== target;
      case 'bullish':
        return raw.includes('bullish') || raw.includes('hammer') || raw.includes('morning')
          || raw.includes('soldiers') || raw.includes('pin_bar_bull');
      case 'bearish':
        return raw.includes('bearish') || raw.includes('shooting') || raw.includes('evening')
          || raw.includes('crows') || raw.includes('pin_bar_bear');
      default:
        return raw === rule.condition;
    }
  }

  const v = raw;
  const value = rule.value ?? 0;
  switch (rule.condition) {
    case 'gt':
      return v > value;
    case 'lt':
      return v < value;
    case 'gte':
      return v >= value;
    case 'lte':
      return v <= value;
    case 'eq':
      return v === value;
    case 'neq':
      return v !== value;
    case 'between':
      return v >= (rule.valueMin ?? 0) && v <= (rule.valueMax ?? 0);
    case 'bullish':
      return v > 0;
    case 'bearish':
      return v < 0;
    case 'is_true':
      return v !== 0;
    case 'is_false':
      return v === 0;
    // Both of these read a RATIO indicator, where 1.0 means "equal to its own
    // average". They are not a comparison against some other rule's average.
    case 'gt_average':
      return v > 1;
    case 'lt_average':
      return v < 1;
    default:
      return false;
  }
}
