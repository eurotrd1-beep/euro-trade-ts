'use client';

/**
 * Builds the Gemini prompt that writes a strategy, and parses what comes back.
 *
 * The prompt carries the generated reference, so the model is working from the
 * engine's real vocabulary rather than from what an indicator is usually called
 * elsewhere. That distinction is the whole reason this exists: `bollinger_upper`
 * and `sma` read perfectly and score 0.0 here, silently.
 *
 * The reference is compacted before sending — the prose notes are for a human
 * reading the file, and the model only needs name, type, parameters and the
 * values each indicator can actually return.
 */

import { aliasGroupOf } from '@euro/engine';

export type Speed = 'very_fast' | 'fast' | 'medium' | 'long';

export interface SpeedSpec {
  id: Speed;
  label: string;
  /** Trade length in candles on the 1m chart. */
  horizon: number;
  brief: string;
}

export const SPEEDS: SpeedSpec[] = [
  {
    id: 'very_fast',
    label: 'سريعة جداً — دقيقة واحدة',
    horizon: 1,
    brief:
      'Trade lasts ONE 1-minute candle. Use fast oscillators and short lookbacks (period 5-9). Momentum and candle patterns matter; slow trend indicators are useless at this horizon. Aim for frequent entries.',
  },
  {
    id: 'fast',
    label: 'سريعة — 2 دقيقة',
    horizon: 2,
    brief:
      'Trade lasts TWO 1-minute candles. Short-to-medium lookbacks (period 9-14). Balance momentum with a light trend confirmation.',
  },
  {
    id: 'medium',
    label: 'متوسطة — 5 دقائق',
    horizon: 5,
    brief:
      'Trade lasts FIVE 1-minute candles. Medium lookbacks (period 14-21). Trend direction and market structure carry real weight here.',
  },
  {
    id: 'long',
    label: 'كبيرة — 15 دقيقة',
    horizon: 15,
    brief:
      'Trade lasts FIFTEEN 1-minute candles. Longer lookbacks (period 21-50). Lead with structure, trend and higher-timeframe context; fast oscillators only confirm.',
  },
];

export interface TierSpec {
  /** The `configs` row this will be saved to. */
  target: string;
  paid: boolean;
  monitoring: boolean;
  brief: string;
}

export function tierFor(target: string): TierSpec {
  const paid = target.includes('vip');
  const monitoring = target.startsWith('monitoring');

  const audience = paid
    ? [
        'This is the PAID (VIP) tier. Subscribers pay for it, so it must be visibly stricter than the free one:',
        '- 4 to 6 primary rules, deliberately spread across DIFFERENT categories (Trend, Price Levels, Oscillators, Advanced Statistics, Rare Patterns). The engine multiplies the primary score by the number of distinct agreeing categories: 1 = x1.0, 2 = x1.15, 3 = x1.3, 4+ = x1.5. Spreading them is worth more than piling on score.',
        '- 3 to 4 confirm rules and 1 to 2 filter rules.',
        '- min_primary_score high enough that a weak setup cannot pass: roughly 60% of the total primary score.',
        '- confidence_base 94-95, confidence_max 99.',
        'Fewer, better signals. A VIP subscriber tolerates waiting; they do not tolerate losing.',
      ]
    : [
        'This is the FREE (standard) tier. It must work and be honest, but it is not the paid product:',
        '- 2 to 3 primary rules, 2 confirm rules, at most 1 filter.',
        '- min_primary_score around half the total primary score, so signals appear reasonably often.',
        '- confidence_base 92.5, confidence_max 98.9.',
        'More frequent signals, simpler logic. It should leave a clear reason to upgrade.',
      ];

  const trigger = monitoring
    ? [
        'This strategy drives MONITORING: the app waits for a new candle to OPEN and evaluates once, on the fresh candle.',
        'So conditions must be readable at the very start of a candle. Do not lean on the current candle\'s body or volume — it has barely formed. Prefer state that carries over: trend, structure, levels, and the previous candles.',
      ]
    : [
        'This strategy drives the INSTANT button: the user presses it and the app evaluates on demand, then enters at the next candle.',
        'The full current candle is available, so body, close position and volume are all fair game.',
      ];

  return { target, paid, monitoring, brief: [...audience, '', ...trigger].join('\n') };
}

/** Strips the reference to what a model needs, keeping every hard fact. */
export function compactReference(doc: Record<string, unknown>): string {
  const rules = (doc['rules'] as Array<Record<string, unknown>>).filter(
    (r) => typeof r['indicator'] === 'string',
  );

  const lines = rules.map((r) => {
    const note = String(r['_note'] ?? '');
    const isText = note.startsWith('returns TEXT');
    const values = /observed values: ([^.]*)/.exec(note)?.[1]?.trim();
    const reads = /reads: ([^.]*)/.exec(note)?.[1]?.trim();
    const category = /category: (.*)$/.exec(note)?.[1]?.trim();

    const parts = [String(r['indicator']), isText ? 'TEXT' : 'NUM'];
    if (isText && values) parts.push(`values=[${values.split(' | ').join(',')}]`);
    if (reads) parts.push(`params=${reads.split(', ').join('+')}`);
    if (category) parts.push(`cat=${category}`);

    // Read from the engine, not from the note text: 46 of these names are one
    // computation under another label, and a model that cannot see that will
    // happily "confirm" a setup three times with three names for one number.
    const group = aliasGroupOf(String(r['indicator']));
    if (group !== null) {
      parts.push(
        String(r['indicator']) === group.canonical
          ? `SAME_AS=[${group.aliases.join(',')}]`
          : `ALIAS_OF=${group.canonical}`,
      );
      if (group.misleading !== null) parts.push('MISLEADING_NAME');
    }
    return parts.join(' | ');
  });

  return lines.join('\n');
}

export interface PromptArgs {
  reference: Record<string, unknown>;
  speed: SpeedSpec;
  tier: TierSpec;
  /** Anything the operator wants to add, free text. */
  extra?: string;
}

export function buildPrompt({ reference, speed, tier, extra }: PromptArgs): string {
  return `You write trading strategies for a binary-options signal engine. Output ONE JSON object and nothing else — no prose, no markdown fence.

# THE ENGINE IS LITERAL — THIS IS THE PART THAT MATTERS
An indicator name it does not recognise returns 0.0 SILENTLY. A condition it does not recognise evaluates to false, so the rule never fires. There is no error, no warning, nothing in a log. A strategy full of plausible-looking names scores nothing and looks fine.
So: use ONLY the indicator names in the catalogue below, spelled exactly. Never invent one. Common names like "sma", "wma", "macd", "bollinger_upper", "parabolic_sar", "adx_plus", "stochastic_k" DO NOT EXIST here.

# CONDITIONS — the only ones implemented
For NUMBER indicators: gt, lt, gte, lte, between (needs value_min + value_max), gt_average, lt_average, is_true, is_false
For TEXT indicators:   eq (needs pattern), neq (needs pattern), bullish, bearish
NOT IMPLEMENTED, never use: rising, falling, cross_above, cross_below

A numeric condition on a TEXT indicator never fires. A text condition on a NUMBER indicator never fires. The catalogue marks each one NUM or TEXT — respect it.

# ALIASES — 46 of these names are not separate indicators
Some names are labels on ONE function. \`doji\`, \`harami\` and \`marubozu\` are the same computation returning the same value at the same instant — using all three is one reading scored three times, and it does NOT add variety for the consensus multiplier because they share a category.
The catalogue marks them: ALIAS_OF=<name> means use that name instead; SAME_AS=[...] lists the labels pointing at this one.
NEVER put two names from the same group in one strategy. Pick one.
MISLEADING_NAME means the name does not test what it says — \`doji\` returns ANY candlestick pattern the detector found, not a doji. If you want a specific pattern, match the returned value with \`eq\` + \`pattern\`, do not rely on the indicator name.

# RULE SHAPE
{ "indicator": "<exact name>", "condition": "<from above>", "signal": "CALL" | "PUT", "score": <number>, "enabled": true, "role": "primary" | "confirm" | "filter", ...params }
Params: period, fast, slow, smooth, stddev, value, value_min, value_max, pattern. The catalogue lists which ones each indicator reads; sending others is harmless but pointless.

# HOW THE ENGINE DECIDES
1. PRIMARY rules set the direction. Their score is multiplied by how many DISTINCT categories agree: 1 category = x1.0, 2 = x1.15, 3 = x1.3, 4 or more = x1.5.
2. The winning side must reach pyramid.min_primary_score.
3. Every FILTER must pass or there is no signal.
4. At least pyramid.confirmation_ratio of the CONFIRM rules must agree with the direction.
5. The two directions must differ by at least 4.0 after multipliers, or it is rejected as unclear.

Set min_primary_score to something REACHABLE: if your primary rules total 12, do not ask for 20. Aim for roughly half to two-thirds of the total.

# THIS STRATEGY
Target row: ${tier.target}
${tier.brief}

Speed: ${speed.label}
${speed.brief}
${extra ? `\nOperator's extra instructions:\n${extra}\n` : ''}
# OUTPUT
{
  "name": "<short descriptive name>",
  "version": "1.0",
  "confidence_base": <number>,
  "confidence_max": <number>,
  "min_score": 0,
  "pyramid": {
    "min_primary_score": <number>,
    "confirmation_ratio": <0..1>,
    "require_all_filters": true,
    "wait_message": "<short Arabic sentence shown while waiting>"
  },
  "rules": [ ... ]
}

Every rule must have "enabled": true — this file is going straight into production. Add a short "_note" per rule in Arabic explaining WHY it is there.

# CATALOGUE — name | NUM/TEXT | values | params | category
${compactReference(reference)}`;
}

/** Gemini likes to wrap JSON in a fence however firmly it is told not to. */
export function extractJson(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('لم يرجع JSON من النموذج');

  return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * The follow-up prompt: here is what you produced, here is how it actually
 * performed on history, now fix it.
 *
 * Generating once and hoping is how you get a strategy that is either mute or
 * a coin flip. The engine can replay history in seconds, so the model gets to
 * see its own numbers and correct — the same loop a human would run, minus the
 * afternoon.
 */
export function buildRefinePrompt(args: {
  previous: Record<string, unknown>;
  stats: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    signalsPer100: number;
    avgCandlesBetweenSignals: number | null;
    blockedReasons: Array<{ reason: string; count: number }>;
    pairsUsed: number;
  };
  speed: SpeedSpec;
  tier: TierSpec;
  reference: Record<string, unknown>;
}): string {
  const { previous, stats, speed, tier, reference } = args;

  const diagnosis: string[] = [];
  if (stats.trades === 0) {
    diagnosis.push(
      'IT NEVER FIRED. Not once, across every pair. It is over-constrained. Lower min_primary_score, drop or loosen the filters, widen any `between` ranges, and cut the number of primary rules that must all agree.',
    );
  } else if (stats.trades < 10) {
    diagnosis.push(
      `Only ${stats.trades} trades — far too rare to judge, and too rare to be useful. Loosen the gates: lower min_primary_score, relax the filters, or widen the ranges.`,
    );
  } else if (stats.winRate < 55) {
    diagnosis.push(
      `Win rate ${stats.winRate.toFixed(1)}% over ${stats.wins + stats.losses} decided trades — barely a coin flip. The direction logic is the problem, not the frequency. Replace weak primary rules with stronger confluence, spread them across MORE categories to earn the multiplier, and add a filter that removes the losing conditions.`,
    );
  } else if (stats.winRate < 65) {
    diagnosis.push(
      `Win rate ${stats.winRate.toFixed(1)}% over ${stats.wins + stats.losses} decided trades — workable but not good enough. Tighten selectively: keep the frequency roughly where it is and add ONE strong confirmation or filter.`,
    );
  } else {
    diagnosis.push(
      `Win rate ${stats.winRate.toFixed(1)}% over ${stats.wins + stats.losses} decided trades — strong. Do not rebuild it. Improve only if you can raise the rate without dropping below ${Math.max(10, Math.floor(stats.trades * 0.6))} trades.`,
    );
  }

  if (stats.signalsPer100 > 25) {
    diagnosis.push(
      `It fires on ${stats.signalsPer100.toFixed(1)}% of candles, which is far too often for a ${tier.paid ? 'paid' : 'free'} tier — it will read as noise. Raise min_primary_score.`,
    );
  }

  const blocked =
    stats.blockedReasons.length > 0
      ? `\nWhat rejected the setups, most frequent first:\n${stats.blockedReasons
          .map((b) => `  ${b.count}x  ${b.reason}`)
          .join('\n')}`
      : '';

  return `Your previous strategy was replayed over real historical candles from ${stats.pairsUsed} currency pairs, entering on the signal and exiting exactly ${speed.horizon} candle(s) later — the horizon it was written for.

# RESULTS
trades: ${stats.trades}   wins: ${stats.wins}   losses: ${stats.losses}   win rate: ${stats.winRate.toFixed(1)}%
fires on ${stats.signalsPer100.toFixed(1)}% of candles${
    stats.avgCandlesBetweenSignals !== null
      ? `, about one signal every ${stats.avgCandlesBetweenSignals.toFixed(0)} candles`
      : ''
  }${blocked}

# WHAT TO FIX
${diagnosis.map((d) => `- ${d}`).join('\n')}

# YOUR PREVIOUS STRATEGY
${JSON.stringify(previous, null, 1)}

# RULES — unchanged, and still absolute
Use ONLY indicator names from the catalogue, spelled exactly; an unknown name returns 0.0 silently.
Conditions for NUMBER indicators: gt, lt, gte, lte, between, gt_average, lt_average, is_true, is_false.
Conditions for TEXT indicators: eq, neq, bullish, bearish.
rising / falling / cross_above / cross_below DO NOT EXIST.
A numeric condition on a TEXT indicator never fires, and the reverse never fires either.
Primary score is multiplied by the number of distinct agreeing categories: 1 = x1.0, 2 = x1.15, 3 = x1.3, 4+ = x1.5. The two directions must differ by at least 4.0 after that.

Target: ${tier.target}
${tier.brief}

Speed: ${speed.label}
${speed.brief}

Output the improved strategy as ONE JSON object, same shape as before, every rule "enabled": true. No prose.

# CATALOGUE — name | NUM/TEXT | values | params | category
${compactReference(reference)}`;
}
