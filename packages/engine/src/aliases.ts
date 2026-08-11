/**
 * Which indicator names are the same computation wearing a different label.
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 *
 * `register(['advanced_candle', 'doji', 'harami', 'marubozu', …], fn)` binds
 * thirteen names to one function. Ask for `doji` and you do not get "is this a
 * doji" — you get whatever pattern that one detector found, which on the Dart
 * fixture is `bullish_engulfing` for all thirteen names at once.
 *
 * That matters because a strategy is scored by counting rules. Three rules on
 * `doji`, `harami` and `marubozu` look like three independent confirmations and
 * add three scores; they are one reading, counted three times. Nothing in the
 * engine notices, and the author reads a strategy that looks well-corroborated.
 *
 * ── WHAT THIS DOES AND DOES NOT DO ─────────────────────────────────────────
 *
 * It does NOT change evaluation. The Dart engine has the same aliases and the
 * same scoring, and byte-identical output is the migration contract — a runtime
 * dedupe would be a silent divergence in the one place divergence is forbidden.
 *
 * It answers the question instead, so the check can run where it actually
 * protects someone: when a strategy is written, tested or published. See
 * `aliasConflicts`.
 *
 * ── HOW THE GROUPS ARE FOUND ───────────────────────────────────────────────
 *
 * By function identity, from the live registry. Not a hand-written list: a list
 * drifts the first time somebody adds a name to a `register([...])` call, and it
 * would drift silently. The one thing identity alone gets wrong is a shared
 * implementation that branches on the name it was called with — `cpr` and
 * `pivot_point` do exactly that — so those are detected and excluded.
 */

import { indicatorFor, registeredNamesInOrder } from './registry.js';
import type { StrategyRule } from './types.js';

/**
 * Groups where the names are NOT synonyms — they name different concepts and
 * share one implementation anyway.
 *
 * A trader asking for a Crab and getting whatever harmonic pattern the detector
 * found is being told something false, which is worse than redundancy. Keyed by
 * canonical name; everything not listed here is treated as a plain synonym
 * (`ao` / `awesome_oscillator` is the same thing said twice, and harmless).
 */
const MISLEADING: Record<string, string> = {
  advanced_candle:
    'candle_pattern_any — returns ANY candlestick pattern the detector found. The specific name you asked for is not what it tests',
  bat: 'harmonic_pattern_any — one detector behind two different harmonic patterns. Asking for a specific one does not select it',
  crab: 'harmonic_pattern_any — one detector behind two different harmonic patterns. Asking for a specific one does not select it',
  '5_0': 'harmonic_pattern_any — one detector behind two different harmonic patterns. Asking for a specific one does not select it',
};

export interface AliasGroup {
  /** The name the implementation was written for: the first one registered. */
  canonical: string;
  /** Every other name bound to the same function. */
  aliases: string[];
  /** Set when the names describe different things, with the honest name. */
  misleading: string | null;
}

let cached: AliasGroup[] | null = null;

/**
 * True when one implementation serves several names by branching on which name
 * it was asked for. Those names are NOT interchangeable and must not be grouped.
 *
 * Reading the function source is unusual but sound here: this package ships as
 * source and is consumed unminified, and `scripts/build-strategy-reference.mts`
 * already reads implementations the same way. `test/aliases.test.ts` pins the
 * expected count, so a new branching registration fails the suite rather than
 * quietly joining a group.
 */
function readsItsOwnName(fn: unknown): boolean {
  return typeof fn === 'function' && /\.indicator\b/.test(fn.toString());
}

/** Every group of names that resolve to one identical computation. */
export function aliasGroups(): readonly AliasGroup[] {
  if (cached !== null) return cached;

  const byFn = new Map<unknown, string[]>();
  for (const name of registeredNamesInOrder()) {
    const fn = indicatorFor(name);
    if (fn === undefined) continue;
    byFn.set(fn, [...(byFn.get(fn) ?? []), name]);
  }

  const groups: AliasGroup[] = [];
  for (const [fn, list] of byFn) {
    if (list.length < 2 || readsItsOwnName(fn)) continue;
    const canonical = list[0]!;
    groups.push({
      canonical,
      aliases: list.slice(1),
      misleading: MISLEADING[canonical] ?? null,
    });
  }
  cached = groups;
  return groups;
}

let index: Map<string, AliasGroup> | null = null;
function groupIndex(): Map<string, AliasGroup> {
  if (index !== null) return index;
  const m = new Map<string, AliasGroup>();
  for (const g of aliasGroups()) for (const n of [g.canonical, ...g.aliases]) m.set(n, g);
  index = m;
  return m;
}

/** The group a name belongs to, or null when the name stands alone. */
export function aliasGroupOf(name: string): AliasGroup | null {
  return groupIndex().get(name) ?? null;
}

/** The name to use instead — itself when the name is not an alias. */
export function canonicalName(name: string): string {
  return groupIndex().get(name)?.canonical ?? name;
}

export interface AliasConflict {
  canonical: string;
  /** The distinct names the strategy used from this one group. */
  names: string[];
  /** Which roles they were given, so the report can say where it bites. */
  roles: string[];
  /** Combined score of the duplicated rules — what the strategy over-counts by. */
  score: number;
  misleading: string | null;
}

/**
 * Distinct names from one alias group used in the same strategy.
 *
 * Enabled rules only, because a disabled rule scores nothing. The same name
 * twice is NOT a conflict: `rsi <= 30` and `rsi >= 70` are two different
 * questions about one indicator and are legitimate. Two DIFFERENT names from
 * one group always are, whatever their conditions, because the value being
 * compared is the identical number.
 */
export function aliasConflicts(rules: readonly StrategyRule[]): AliasConflict[] {
  const seen = new Map<string, { names: Set<string>; roles: Set<string>; score: number }>();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const group = aliasGroupOf(rule.indicator);
    if (group === null) continue;
    const entry = seen.get(group.canonical) ?? { names: new Set(), roles: new Set(), score: 0 };
    entry.names.add(rule.indicator);
    entry.roles.add(rule.role.length > 0 ? rule.role : 'base');
    entry.score += Math.abs(rule.score);
    seen.set(group.canonical, entry);
  }

  const conflicts: AliasConflict[] = [];
  for (const [canonical, entry] of seen) {
    if (entry.names.size < 2) continue;
    conflicts.push({
      canonical,
      names: [...entry.names],
      roles: [...entry.roles],
      score: entry.score,
      misleading: aliasGroupOf(canonical)?.misleading ?? null,
    });
  }
  return conflicts;
}

/** One line per conflict, ready to show an author. Empty when there are none. */
export function aliasConflictMessages(rules: readonly StrategyRule[]): string[] {
  return aliasConflicts(rules).map((c) => {
    const list = c.names.join('، ');
    const head =
      `القواعد ${list} كلها نفس الحسبة بالظبط (${c.canonical}) — ` +
      `${c.names.length} قواعد بنتيجة ${c.score} بتتحسب على قراءة واحدة`;
    return c.misleading === null ? `${head}.` : `${head}. ${c.misleading}`;
  });
}
