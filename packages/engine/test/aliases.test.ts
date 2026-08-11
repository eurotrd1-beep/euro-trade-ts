/**
 * The alias groups and the guard built on them.
 *
 * These tests pin behaviour that is derived from the registry at runtime, so
 * they are what stops the derivation going wrong silently: add a name to a
 * `register([...])` call and the counts here move; write a new implementation
 * that branches on `rule.indicator` and the exclusion test catches it.
 */

import { describe, expect, it } from 'vitest';
import {
  aliasConflictMessages,
  aliasConflicts,
  aliasGroupOf,
  aliasGroups,
  canonicalName,
  computeIndicator,
  makeRule,
  registeredNames,
  type Candle,
} from '../src/index.js';

function candles(n = 80): Candle[] {
  const out: Candle[] = [];
  let price = 1.08;
  for (let i = 0; i < n; i++) {
    price += Math.sin(i / 5) * 0.0004;
    out.push({
      open: price,
      high: price + 0.0006,
      low: price - 0.0006,
      close: price + 0.0002,
      volume: 1000,
      time: Date.UTC(2026, 0, 1, 0, i) ,
    });
  }
  return out;
}

describe('alias groups', () => {
  it('finds the thirteen-name candle group and elects the honest canonical', () => {
    const group = aliasGroupOf('doji');
    expect(group).not.toBeNull();
    // Registration order, not alphabetical — `abandoned_baby` sorts first but
    // `advanced_candle` is the name the implementation was written for.
    expect(group!.canonical).toBe('advanced_candle');
    expect(group!.aliases).toContain('harami');
    expect(group!.aliases).toContain('marubozu');
    expect([group!.canonical, ...group!.aliases]).toHaveLength(13);
  });

  it('marks the groups whose names describe different things', () => {
    expect(aliasGroupOf('doji')!.misleading).toContain('candle_pattern_any');
    expect(aliasGroupOf('deep_crab')!.misleading).toContain('harmonic_pattern_any');
    // A plain synonym is redundant, not dishonest.
    expect(aliasGroupOf('awesome_oscillator')!.misleading).toBeNull();
  });

  it('excludes a shared implementation that branches on the name it was given', () => {
    // cpr and pivot_point share one register() call but return different maths.
    expect(aliasGroupOf('cpr')).toBeNull();
    expect(aliasGroupOf('pivot_point')).toBeNull();
  });

  it('every grouped name really does compute the same value', () => {
    const data = candles();
    for (const group of aliasGroups()) {
      const rule = makeRule({ indicator: group.canonical, condition: 'eq', signal: 'CALL', score: 1 });
      const expected = computeIndicator(data, rule, data[data.length - 1]!.close);
      for (const alias of group.aliases) {
        const got = computeIndicator(
          data,
          { ...rule, indicator: alias },
          data[data.length - 1]!.close,
        );
        expect(got, `${alias} should equal ${group.canonical}`).toStrictEqual(expected);
      }
    }
  });

  it('accounts for every registered name exactly once', () => {
    const seen = new Set<string>();
    for (const g of aliasGroups()) {
      for (const n of [g.canonical, ...g.aliases]) {
        expect(seen.has(n), `${n} is in two groups`).toBe(false);
        seen.add(n);
      }
    }
    const extra = aliasGroups().reduce((n, g) => n + g.aliases.length, 0);
    // 237 registered names are 191 distinct computations.
    expect(registeredNames().length - extra).toBe(191);
  });

  it('canonicalName resolves an alias and leaves a stand-alone name alone', () => {
    expect(canonicalName('harami')).toBe('advanced_candle');
    expect(canonicalName('rsi')).toBe('rsi');
  });
});

describe('aliasConflicts', () => {
  const rule = (indicator: string, role = 'primary', score = 4, enabled = true) =>
    makeRule({ indicator, condition: 'eq', signal: 'CALL', score, role, enabled });

  it('flags three names from one group as one reading counted three times', () => {
    const conflicts = aliasConflicts([rule('doji'), rule('harami'), rule('marubozu', 'confirm', 3)]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.canonical).toBe('advanced_candle');
    expect(conflicts[0]!.names.sort()).toStrictEqual(['doji', 'harami', 'marubozu']);
    expect(conflicts[0]!.roles.sort()).toStrictEqual(['confirm', 'primary']);
    expect(conflicts[0]!.score).toBe(11);
  });

  it('does not flag the same name used twice — two questions about one indicator', () => {
    expect(aliasConflicts([
      makeRule({ indicator: 'rsi', condition: 'lte', value: 30, signal: 'CALL', score: 3 }),
      makeRule({ indicator: 'rsi', condition: 'gte', value: 70, signal: 'PUT', score: 3 }),
    ])).toHaveLength(0);
  });

  it('ignores disabled rules, which score nothing', () => {
    expect(aliasConflicts([rule('doji'), rule('harami', 'primary', 4, false)])).toHaveLength(0);
  });

  it('is silent on a strategy built from unrelated indicators', () => {
    expect(aliasConflicts([rule('rsi'), rule('macd_line'), rule('fib_zone')])).toHaveLength(0);
  });

  it('names the misleading group in the message an author sees', () => {
    const messages = aliasConflictMessages([rule('bat'), rule('alternate_bat')]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('harmonic_pattern_any');
  });
});
