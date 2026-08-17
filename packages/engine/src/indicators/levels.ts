/**
 * Relative level indicators — Fibonacci and support/resistance.
 *
 * ── WHY THESE EXIST ────────────────────────────────────────────────────────
 *
 * The engine compares one indicator's value against a fixed number. It cannot
 * compare two indicators, and there is no `cross_above` or `near`. So an
 * indicator that answers with a raw price is unusable in a rule: `sr_support`
 * returns 1.0696, and "the price is at support" cannot be written as a
 * comparison against a constant, because the constant changes every candle.
 *
 * These do the comparison INSIDE the indicator and answer with something a rule
 * can test — a percentage, or a label. No new condition was added; the
 * thirteen stay as they are.
 *
 * NEW in TypeScript. The Dart engine has none of them — see PENDING_DART_PORT
 * in test/parity.test.ts. A strategy using them scores 0.0 on the old Flutter
 * app, silently, as it does for any name Dart does not know.
 */

import type { Candle } from '../types.js';
import { register } from '../registry.js';

/**
 * Every ratio the family knows, retracements and extensions in one list.
 *
 * One array on purpose: `fib_level`, `fib_zone`, `fib_distance` and `fib_bounce`
 * all read it, so adding 0.707 tomorrow is one line here rather than an edit in
 * four places that will eventually disagree with each other.
 *
 * The label is what `fib_level` returns, so it is part of the contract — the
 * strategy reference lists these strings and a rule matches them exactly.
 */
export const FIB_LEVELS: ReadonlyArray<{ ratio: number; label: string }> = [
  { ratio: 0.0, label: 'at_0' },
  { ratio: 0.236, label: 'at_236' },
  { ratio: 0.382, label: 'at_382' },
  { ratio: 0.5, label: 'at_500' },
  { ratio: 0.618, label: 'at_618' },
  { ratio: 0.786, label: 'at_786' },
  { ratio: 0.886, label: 'at_886' },
  { ratio: 1.0, label: 'at_100' },
  { ratio: 1.272, label: 'at_1272' },
  { ratio: 1.414, label: 'at_1414' },
  { ratio: 1.618, label: 'at_1618' },
  { ratio: 2.0, label: 'at_200' },
  { ratio: 2.618, label: 'at_2618' },
  { ratio: 3.618, label: 'at_3618' },
  { ratio: 4.236, label: 'at_4236' },
];

/**
 * Default proximity bands, per family, applied when the rule does not say.
 *
 * FIB_TOLERANCE is measured against the swing RANGE. 5 is the widest band that
 * cannot claim two levels at once: the tightest spacing in FIB_LEVELS is
 * 23.6 → 38.2, i.e. 14.6% of the range, and a ±5 band occupies 10 of that.
 * Measured across 72 live windows it leaves fib_level naming a level about half
 * the time; ±2.5 named one a quarter of the time, and ±12 named one almost
 * always by overlapping its neighbours, which is worse than saying nothing.
 *
 * SR_TOLERANCE is measured against the PRICE, because support and resistance
 * are absolute levels rather than points along a span. 0.15% is roughly what a
 * trader means by "at the level" on a major pair.
 */
const FIB_TOLERANCE = 5;
const SR_TOLERANCE = 0.15;

/**
 * The floor on how far back the swing is looked for, in bars.
 *
 * `period` cannot be trusted to size this search. It defaults to 14 — that is
 * what `makeRule` fills in and what the strategy reference prints in every
 * Fibonacci template — and fourteen bars cannot hold three peaks, so honouring
 * it literally would answer "no swing" to every rule the reference itself
 * hands out. Measured over 956 windows (five pairs at 1m, 15m and 1h, plus the
 * golden fixture): a 14-bar search found an intermediate pair 0% of the time,
 * 30 bars 8.9%, 50 bars 52%, 70 bars 77%, and 100 bars 86.7%.
 *
 * 100 is where it stops mattering: that is exactly how many candles the proxy
 * returns, so in production this reads "all the history there is". A rule
 * asking for more still gets more — `period` raises the floor, it just cannot
 * lower it below what the structure needs to be visible at all.
 */
const SWING_LOOKBACK = 100;

/** A confirmed swing: its two ends, and which way it ran. */
export interface Swing {
  high: number;
  low: number;
  /** true when the low came first, i.e. the leg was upward. */
  up: boolean;
  range: number;
}

/** One confirmed fractal: its price, and where in the window it sits. */
interface Pivot {
  price: number;
  at: number;
}

/**
 * Every confirmed 5-candle fractal of one kind in the window, oldest first.
 *
 * A fractal high needs two lower highs on each side, so it is only confirmed
 * two bars after it forms — which is the point. Taking the plain max of the
 * window instead would pick up a wick that the market has not yet turned away
 * from, and every level derived from it would move again next bar.
 */
function fractals(window: readonly Candle[], kind: 'high' | 'low'): Pivot[] {
  const priceAtBar = (i: number) => (kind === 'high' ? window[i]!.high : window[i]!.low);
  const out: Pivot[] = [];

  for (let i = 2; i < window.length - 2; i++) {
    const price = priceAtBar(i);
    const isPivot =
      kind === 'high'
        ? price > priceAtBar(i - 1) && price > priceAtBar(i - 2) &&
          price > priceAtBar(i + 1) && price > priceAtBar(i + 2)
        : price < priceAtBar(i - 1) && price < priceAtBar(i - 2) &&
          price < priceAtBar(i + 1) && price < priceAtBar(i + 2);
    if (isPivot) out.push({ price, at: i });
  }
  return out;
}

/**
 * The most recent INTERMEDIATE pivot among those fractals.
 *
 * A fractal is intermediate when it beats the fractal of its own kind on each
 * side: an intermediate high is a peak that neither the peak before it nor the
 * peak after it managed to reach. So it is the same fractal test applied one
 * degree up, on the pivots instead of on the candles.
 *
 * The last one is skipped deliberately — it has no pivot after it yet, so
 * nothing has confirmed it as the higher peak. Accepting it would put back the
 * flicker the fractal confirmation exists to remove, one degree higher.
 */
function lastIntermediate(pivots: readonly Pivot[], kind: 'high' | 'low'): Pivot | null {
  for (let i = pivots.length - 2; i >= 1; i--) {
    const price = pivots[i]!.price;
    const beatsBoth =
      kind === 'high'
        ? price > pivots[i - 1]!.price && price > pivots[i + 1]!.price
        : price < pivots[i - 1]!.price && price < pivots[i + 1]!.price;
    if (beatsBoth) return pivots[i]!;
  }
  return null;
}

/**
 * The swing between the most recent intermediate high and intermediate low.
 *
 * The Fibonacci family is drawn from THIS, so the choice of ends is the whole
 * indicator. It used to take the highest and lowest fractal anywhere in
 * `period` bars, which is not a swing at all: on a window holding two legs it
 * pairs the top of one with the bottom of the other, and every level it hands
 * out belongs to a move nobody traded. It also went stale in the other
 * direction — once a big extreme was in the window it stayed the anchor until
 * it aged out of it, so the levels ignored the leg actually running.
 *
 * Intermediate degree is what a trader means by "the swing": the minor
 * fractals are the noise inside the leg, and the peak that the peaks either
 * side of it failed to reach is the turn that ended one. Anchoring there is
 * both what the retracement is supposed to measure and steadier — the ends
 * only move when a new turn of that degree is confirmed, not whenever a wick
 * prints a new window extreme.
 *
 * The cost is honest and bounded: it answers nothing on 13.3% of candles,
 * against never on the old rule, because the structure is not always there to
 * read. That is the same "none" / -1 the family already returns for a window
 * too short to measure, and it is the right answer — the old rule was not more
 * informative, it was answering from a pairing it had invented. What it buys,
 * on the same 956 windows: the median swing stops inflating with the lookback
 * (71 pips, near enough the same at 70 bars or 400, where the old rule ran
 * 31 → 108 pips as the window grew) because the ends now come from the market's
 * structure rather than from the size of the window it was handed.
 *
 * The price is free to run beyond either end; that is what `fib_extension` and
 * the `extension` zone are for.
 *
 * Deliberately NOT `supportResistance` in math.ts: that one uses 3-candle
 * pivots over the whole series with no period, and `sr_support` /
 * `sr_resistance` are matched against the Dart engine bar for bar. It is left
 * exactly as it is.
 */
export function detectSwing(candles: readonly Candle[], period = 50): Swing | null {
  const window = candles.slice(-Math.max(period, SWING_LOOKBACK));
  if (window.length < 12) return null;

  const high = lastIntermediate(fractals(window, 'high'), 'high');
  const low = lastIntermediate(fractals(window, 'low'), 'low');
  if (high === null || low === null) return null;

  const range = high.price - low.price;
  // A swing narrower than this is noise, and dividing by it produces
  // percentages that swing wildly on a single tick. It also drops the one
  // incoherent pairing this can produce: each end is the most recent of its own
  // kind and nothing forces them to bracket each other, so a peak sitting below
  // a later trough arrives here as a negative range and is refused rather than
  // drawn upside down.
  if (range < 1e-7) return null;

  return { high: high.price, low: low.price, up: low.at < high.at, range };
}

/**
 * Where the price sits on the swing, as a retracement percentage.
 *
 * 0 is the end the leg ran TO, 100 the end it came FROM — so on an upward leg
 * 0 is the high, and a pullback deepens the number. That is the direction a
 * trader reads a retracement in.
 */
function retracementPct(swing: Swing, price: number): number {
  const fromEnd = swing.up ? swing.high - price : price - swing.low;
  return (fromEnd / swing.range) * 100;
}

/** Price at a ratio along the swing, measured from the end it ran to. */
function priceAt(swing: Swing, ratio: number): number {
  return swing.up ? swing.high - swing.range * ratio : swing.low + swing.range * ratio;
}

// ── Fibonacci ───────────────────────────────────────────────────────────────

/**
 * Retracement percentage, 0-100. `-1` when there is no confirmed swing.
 *
 * -1 rather than 0, because 0 is a real answer meaning "at the extreme". A
 * rule reading `lte 10` would otherwise fire on every window too short to
 * measure.
 */
register('fib_retracement', ({ candles, currentPrice, rule }) => {
  const swing = detectSwing(candles, rule.period);
  if (swing === null) return -1;
  const pct = retracementPct(swing, currentPrice);
  return pct < 0 || pct > 100 ? -1 : pct;
});

/**
 * Extension percentage once price leaves the swing, `-1` while inside it.
 *
 * Past the end it ran to, the number is negative-side overshoot expressed
 * positively above 100; past the origin it keeps counting up.
 */
register('fib_extension', ({ candles, currentPrice, rule }) => {
  const swing = detectSwing(candles, rule.period);
  if (swing === null) return -1;
  const pct = retracementPct(swing, currentPrice);
  if (pct >= 0 && pct <= 100) return -1;
  return pct < 0 ? Math.abs(pct) + 100 : pct;
});

/**
 * The nearest level, if the price is within `tolerance` of it.
 *
 * `tolerance` is a percentage OF THE SWING RANGE, not of the price: the levels
 * are spaced along the range, so a band measured any other way would be wide
 * enough to overlap two levels on a small swing and never reach one on a large.
 */
register('fib_level', ({ candles, currentPrice, rule }) => {
  const swing = detectSwing(candles, rule.period);
  if (swing === null) return 'none';

  const band = swing.range * ((rule.tolerance ?? FIB_TOLERANCE) / 100);
  let best: { label: string; distance: number } | null = null;

  for (const level of FIB_LEVELS) {
    const distance = Math.abs(currentPrice - priceAt(swing, level.ratio));
    if (distance <= band && (best === null || distance < best.distance)) {
      best = { label: level.label, distance };
    }
  }
  return best?.label ?? 'none';
});

/**
 * The band the price occupies, whether or not it is at a level.
 *
 * `fib_level` answers "is it touching one"; this answers "roughly where is it",
 * which is what most rules actually want. The golden pocket is its own zone
 * because it is the one every retracement strategy is built around.
 */
register('fib_zone', ({ candles, currentPrice, rule }) => {
  const swing = detectSwing(candles, rule.period);
  if (swing === null) return 'none';

  if (currentPrice > swing.high) return swing.up ? 'extension' : 'above_high';
  if (currentPrice < swing.low) return swing.up ? 'below_low' : 'extension';

  const pct = retracementPct(swing, currentPrice);
  if (pct < 38.2) return 'shallow';
  if (pct <= 61.8) return 'golden';
  return 'deep';
});

/**
 * A rejection at the level named by `value` (default 0.618).
 *
 * The last candle must have REACHED the level and closed back away from it —
 * a wick through with a close beyond is a break, not a bounce, and reading it
 * as one is how a reversal rule ends up buying a breakdown.
 */
register('fib_bounce', ({ candles, currentPrice, rule }) => {
  const swing = detectSwing(candles, rule.period);
  if (swing === null || candles.length < 2) return 'none';

  const level = priceAt(swing, rule.value ?? 0.618);
  const band = swing.range * ((rule.tolerance ?? FIB_TOLERANCE) / 100);
  const last = candles[candles.length - 1]!;

  const touchedFromAbove = last.low <= level + band && last.close > level;
  const touchedFromBelow = last.high >= level - band && last.close < level;

  if (touchedFromAbove && last.close > last.open && currentPrice > level) return 'bullish';
  if (touchedFromBelow && last.close < last.open && currentPrice < level) return 'bearish';
  return 'none';
});

/**
 * Signed distance to the nearest level, as a percentage of the swing range.
 *
 * Negative below, positive above, near zero touching — so `between -0.2 0.2`
 * reads as "at any level", which is the comparison the engine cannot otherwise
 * express.
 */
register('fib_distance', ({ candles, currentPrice, rule }) => {
  const swing = detectSwing(candles, rule.period);
  if (swing === null) return 0;

  let nearest = Infinity;
  for (const level of FIB_LEVELS) {
    const delta = currentPrice - priceAt(swing, level.ratio);
    if (Math.abs(delta) < Math.abs(nearest)) nearest = delta;
  }
  return Number.isFinite(nearest) ? (nearest / swing.range) * 100 : 0;
});

// ── Support / resistance ────────────────────────────────────────────────────

/**
 * The swing's own ends as levels.
 *
 * Not `supportResistance` from math.ts: that is bound to the Dart engine and
 * scans the whole series. This one honours `period` and uses the same confirmed
 * swing as the Fibonacci family, so a strategy mixing the two is talking about
 * one structure rather than two.
 */
function bounds(candles: readonly Candle[], period: number): { support: number; resistance: number } | null {
  const swing = detectSwing(candles, period);
  return swing === null ? null : { support: swing.low, resistance: swing.high };
}

/**
 * Where the price stands relative to those ends.
 *
 * `tolerance` here is a percentage OF THE PRICE, not of the range — support and
 * resistance are absolute levels rather than points along a span, and "within
 * 0.15% of the level" is how a trader means it.
 */
register('sr_position', ({ candles, currentPrice, rule }) => {
  const level = bounds(candles, rule.period);
  if (level === null) return 'none';

  const band = currentPrice * ((rule.tolerance ?? SR_TOLERANCE) / 100);
  if (Math.abs(currentPrice - level.support) <= band) return 'at_support';
  if (Math.abs(currentPrice - level.resistance) <= band) return 'at_resistance';
  if (currentPrice < level.support) return 'below_support';
  if (currentPrice > level.resistance) return 'above_resistance';
  return 'between';
});

/** A rejection at support or resistance, on the same reach-and-close-away test. */
register('sr_bounce', ({ candles, currentPrice, rule }) => {
  const level = bounds(candles, rule.period);
  if (level === null || candles.length < 2) return 'none';

  const band = currentPrice * ((rule.tolerance ?? SR_TOLERANCE) / 100);
  const last = candles[candles.length - 1]!;

  const heldSupport =
    last.low <= level.support + band && last.close > level.support && last.close > last.open;
  const rejectedResistance =
    last.high >= level.resistance - band && last.close < level.resistance && last.close < last.open;

  if (heldSupport) return 'bullish';
  if (rejectedResistance) return 'bearish';
  return 'none';
});
