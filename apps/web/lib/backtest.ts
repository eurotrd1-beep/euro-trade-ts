'use client';

/**
 * Walk-forward backtest — runs a strategy over candles that have already
 * happened, so a strategy can be judged in seconds instead of by watching the
 * chart for an afternoon.
 *
 * How it works, and why:
 *
 *   • It replays history one candle at a time. At index i the strategy only
 *     ever sees candles[0..i] — never the future — which is the whole point:
 *     an indicator handed the full series would be reading the answer.
 *
 *   • The clock comes from the CANDLE's own timestamp, not from now. Ten
 *     indicators branch on the hour (kill_zone, session, silver_bullet,
 *     judas_swing…), so replaying with today's clock would judge a London-only
 *     strategy against Tokyo candles and call it broken.
 *
 *   • A fired trade blocks the next `horizon` candles, exactly as the live
 *     engine refuses a second signal while one is open. Without that, one good
 *     setup counts as five wins.
 *
 *   • The proxy keeps 100 candles per pair, so a single pair yields a handful
 *     of trades — not enough to mean anything. Running the same strategy across
 *     many pairs is what turns it into a sample worth reading.
 *
 * ── ADDING PAIRS DOES NOT WIDEN TIME. ADDING TIMEFRAMES DOES. ──────────────
 *
 * Every pair is sampled at the same wall-clock moments, so ten pairs on the 1m
 * chart is ten views of the SAME 100 minutes — three hours of the day, always
 * the most recent three. Measured on the live proxy:
 *
 *     1m  × 100 →  0.1 day,   3/24 hours
 *     5m  × 100 →  0.3 day,   9/24 hours
 *     15m × 100 →  1.0 day,  24/24 hours
 *     1h  ×  71 → 34.3 days, 24/24 hours
 *
 * This is not academic. A first pass over 1m candles reported kill_zone as
 * "none" on all 500 evaluations and it was read as a dead filter; on a 15m+1h
 * sample the same filter passes 39% of the time and works exactly as intended.
 * Judging a session-based rule on a three-hour window is judging it on one
 * session.
 *
 * So the report carries the coverage it actually achieved, and says plainly
 * when a clock-dependent rule is being scored on too narrow a window.
 */

import {
  evaluateStrategyPro,
  type Candle,
  type DynamicStrategy,
  type EngineClock,
} from '@euro/engine';
import { fetchCandles } from './candles';

/** Indicators look back up to ~50 bars; start after that or they see noise. */
const WARMUP = 55;

/**
 * Indicators whose answer depends on the hour or the weekday.
 *
 * Found two ways, and this is the union: a static scan of each registered
 * indicator's source for `clock` / `utcHour` / `weekday`, and an empirical
 * sweep running every indicator against seven different clocks to catch any
 * that reach the reading through a helper. The scan found six; the sweep
 * confirmed five of them move on the sample data — judas_swing reads the clock
 * but happened to answer the same either way there, which is precisely why the
 * static scan is the authority and the sweep only corroborates.
 */
const CLOCK_DEPENDENT = new Set([
  'day_of_week', 'judas_swing', 'kill_zone', 'session', 'session_overlap', 'time_analysis',
]);

/** Below this the day is not represented and a session rule cannot be judged. */
const MIN_HOURS_COVERED = 24;

/**
 * Seconds between bars, per timeframe — used to spot a hole in the history.
 *
 * The scraper only stores while it is running, so a pair's bars are scattered
 * with gaps in them. Read as one array, a hole is a phantom candle: two days of
 * movement compressed into one bar, which every indicator reads as a violent
 * move that never happened. Splitting at the gaps changed the verdict for 69
 * indicators in the liveness audit, so this is not a refinement.
 */
const STEP_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14_400, '1d': 86_400,
};

/** A gap wider than this many steps starts a new segment. */
const GAP_TOLERANCE = 1.5;

/**
 * Splits a series wherever the spacing jumps, so no window straddles a hole.
 *
 * Segments too short to fill the warm-up are dropped rather than fed a window
 * they cannot fill — an indicator answering off 12 bars when it needs 50 is
 * worse than no answer, because it looks like an answer.
 */
function contiguousRuns(candles: Candle[], stepSeconds: number, minLength: number): Candle[][] {
  const runs: Candle[][] = [];
  let run: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i > 0 && (candles[i]!.time - candles[i - 1]!.time) / 1000 > stepSeconds * GAP_TOLERANCE) {
      if (run.length >= minLength) runs.push(run);
      run = [];
    }
    run.push(candles[i]!);
  }
  if (run.length >= minLength) runs.push(run);
  return runs;
}

/**
 * Wilson score interval for a proportion.
 *
 * Not the textbook Wald interval (p ± 1.96·√(p(1−p)/n)), which this used to
 * use: Wald's coverage collapses at small n and near 0 or 1 — it happily
 * reports a range wider than [0,100] and had to be clamped, and clamping an
 * interval is a sign the interval is wrong, not that the number is fine.
 */
function wilson(wins: number, decided: number): { low: number; high: number } {
  const z = 1.96;
  const p = wins / decided;
  const d = 1 + (z * z) / decided;
  const centre = (p + (z * z) / (2 * decided)) / d;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / decided + (z * z) / (4 * decided * decided))) / d;
  return { low: (centre - margin) * 100, high: (centre + margin) * 100 };
}

/**
 * What a strategy has to clear before it makes money.
 *
 * A binary option paying 80–90% returns 1.8–1.9x the stake on a win and zero on
 * a loss, so break-even is 1/1.9 … 1/1.8 — 52.6% to 55.6%. A 55% win rate is
 * not "acceptable"; it is the middle of the break-even band, which is to say it
 * is nothing. Anything below BREAKEVEN_HIGH is presented as losing.
 */
export const BREAKEVEN_LOW = 52.6;
export const BREAKEVEN_HIGH = 55.6;

/** Below this, the win rate is a number about the sample, not the strategy. */
export const MIN_TRADES_TO_JUDGE = 30;

export interface BacktestArgs {
  strategy: DynamicStrategy;
  /** OTC symbols to replay, e.g. ['EURUSD_otc', 'GBPUSD_otc']. */
  symbols: string[];
  interval: string;
  /** Trade length in candles — 1 on a 1m chart is a one-minute trade. */
  horizon: number;
  onProgress?: (done: number, total: number) => void;
}

export interface Trade {
  symbol: string;
  direction: 'CALL' | 'PUT';
  entry: number;
  exit: number;
  outcome: 'WIN' | 'LOSS' | 'TIE';
  /** Candle index the signal fired on. */
  at: number;
  scoreCall: number;
  scorePut: number;
}

export interface BacktestReport {
  trades: Trade[];
  wins: number;
  losses: number;
  ties: number;
  /** Ties excluded, as everywhere else in this system. */
  winRate: number;
  /** Candles evaluated across every pair. */
  evaluated: number;
  /** Pairs that returned usable history. */
  pairsUsed: number;
  pairsRequested: number;
  /** Mean candles from one signal to the next — "how long until a trade". */
  avgCandlesBetweenSignals: number | null;
  /** Signals per 100 candles, the frequency measure that survives sample size. */
  signalsPer100: number;
  /** Why the pyramid said no, tallied — shows what is actually gating. */
  blockedReasons: Array<{ reason: string; count: number }>;
  perPair: Array<{ symbol: string; trades: number; wins: number; losses: number }>;
  /** What window the sample actually spanned. */
  coverage: {
    /** Distinct UTC hours seen, out of 24. */
    hours: number;
    /** Distinct calendar days seen. */
    days: number;
    /** Clock-dependent rules in this strategy that the window cannot judge. */
    unjudgeable: string[];
    /** Holes in the scraped history that the replay was split at. */
    gaps: number;
    /** Bars thrown away because their segment was shorter than the warm-up. */
    barsDropped: number;
  };
  warnings: string[];
}

/**
 * Dart's clock convention, derived from a candle instead of the wall clock.
 *
 * `Candle.time` is MILLISECONDS (see the type). Multiplying it again put every
 * replay somewhere around the year 58,000, so kill_zone, session, day_of_week
 * and the rest were judged against a meaningless hour.
 */
function clockFor(candle: Candle): EngineClock {
  const d = new Date(candle.time);
  const jsDay = d.getDay();
  return { utcHour: d.getUTCHours(), weekday: jsDay === 0 ? 7 : jsDay };
}

export async function backtest(args: BacktestArgs): Promise<BacktestReport> {
  const { strategy, symbols, interval, horizon, onProgress } = args;

  const trades: Trade[] = [];
  const perPair: BacktestReport['perPair'] = [];
  const blocked = new Map<string, number>();
  const warnings: string[] = [];
  const signalGaps: number[] = [];

  let evaluated = 0;
  let pairsUsed = 0;
  let gapsFound = 0;
  let barsDropped = 0;

  // Coverage is measured from the candles themselves, not assumed from the
  // timeframe — a pair with a gap in its history covers less than it looks.
  const hoursSeen = new Set<number>();
  const daysSeen = new Set<string>();

  for (const [n, symbol] of symbols.entries()) {
    onProgress?.(n, symbols.length);

    let candles: Candle[] | null = null;
    try {
      candles = await fetchCandles(symbol, interval);
    } catch {
      candles = null;
    }

    if (!candles || candles.length < WARMUP + horizon + 5) {
      warnings.push(`${symbol}: تاريخ غير كافٍ (${candles?.length ?? 0} شمعة) — تم تخطّيه`);
      continue;
    }

    for (const candle of candles) {
      const d = new Date(candle.time);
      hoursSeen.add(d.getUTCHours());
      daysSeen.add(d.toISOString().slice(0, 10));
    }

    // Split at the holes BEFORE replaying. Everything below runs per segment.
    const step = STEP_SECONDS[interval];
    const segments =
      step === undefined
        ? [candles]
        : contiguousRuns(candles, step, WARMUP + horizon + 5);
    const dropped = candles.length - segments.reduce((n, s) => n + s.length, 0);
    if (dropped > 0) {
      gapsFound += Math.max(0, segments.length - 1);
      barsDropped += dropped;
    }
    if (segments.length === 0) {
      warnings.push(`${symbol}: كل القطع أقصر من فترة الإحماء بعد تقسيم الفجوات — تم تخطّيه`);
      continue;
    }
    pairsUsed++;

    let pairTrades = 0;
    let pairWins = 0;
    let pairLosses = 0;

    for (const segment of segments) {
      let lastSignalAt: number | null = null;
      let blockedUntil = -1;

      for (let i = WARMUP; i < segment.length - horizon; i++) {
      // Only the past, and only within this segment — a window that reached
      // across a gap would carry a jump of days as if it were one candle.
      const window = segment.slice(0, i + 1);
      const current = window[window.length - 1]!;
      evaluated++;

      if (i < blockedUntil) continue;

      let pro;
      try {
        pro = evaluateStrategyPro(strategy, {
          candles: window,
          currentPrice: current.close,
          clock: clockFor(current),
        });
      } catch {
        continue;
      }

      if (pro.result !== 'SIGNAL' || pro.direction === null) {
        if (pro.reasonBlocked) {
          blocked.set(pro.reasonBlocked, (blocked.get(pro.reasonBlocked) ?? 0) + 1);
        }
        continue;
      }

      const entry = current.close;
      const exit = segment[i + horizon]!.close;
      const direction = pro.direction;
      const outcome: Trade['outcome'] =
        exit === entry ? 'TIE' : direction === 'CALL' ? (exit > entry ? 'WIN' : 'LOSS') : exit < entry ? 'WIN' : 'LOSS';

      trades.push({
        symbol,
        direction,
        entry,
        exit,
        outcome,
        at: i,
        scoreCall: pro.finalScore.CALL,
        scorePut: pro.finalScore.PUT,
      });

      pairTrades++;
      if (outcome === 'WIN') pairWins++;
      else if (outcome === 'LOSS') pairLosses++;

      if (lastSignalAt !== null) signalGaps.push(i - lastSignalAt);
      lastSignalAt = i;

      // One trade at a time, as the live engine enforces.
      blockedUntil = i + horizon;
      }
    }

    perPair.push({ symbol, trades: pairTrades, wins: pairWins, losses: pairLosses });
  }

  onProgress?.(symbols.length, symbols.length);

  // Which clock-dependent rules is this window unable to judge?
  const unjudgeable = [
    ...new Set(
      strategy.rules
        .filter((r) => r.enabled && CLOCK_DEPENDENT.has(r.indicator))
        .map((r) => r.indicator),
    ),
  ];

  if (gapsFound > 0) {
    warnings.push(
      `⚠️ التاريخ فيه ${gapsFound} فجوة — السكرابر بيسجّل وهو شغّال بس. الاختبار اتقسّم عندها، ` +
        `و${barsDropped} شمعة اتشالت لأن قطعتها أقصر من فترة الإحماء. من غير التقسيم ده كانت قفزة ` +
        `الفجوة هتتقري كشمعة عنيفة واحدة.`,
    );
  }

  if (hoursSeen.size < MIN_HOURS_COVERED) {
    warnings.push(
      `⚠️ العينة تغطي ${hoursSeen.size} ساعة فقط من 24 (${daysSeen.size} يوم) — ` +
        (unjudgeable.length > 0
          ? `والاستراتيجية فيها ${unjudgeable.join(' و ')}. نتيجتهم غير موثوقة على النافذة دي.`
          : 'المؤشرات الزمنية (kill_zone / session / session_overlap / judas_swing / day_of_week / time_analysis) نتائجها غير موثوقة على نافذة بالضيق ده.'),
    );
    warnings.push(
      'وسّع النافذة بتغيير الفريم (15m يغطّي يوم كامل، 1h يغطّي شهر) — زيادة الأزواج مش بتوسّع الزمن، كلهم بيتسجّلوا في نفس اللحظات.',
    );
  }

  const wins = trades.filter((t) => t.outcome === 'WIN').length;
  const losses = trades.filter((t) => t.outcome === 'LOSS').length;
  const ties = trades.filter((t) => t.outcome === 'TIE').length;
  const decided = wins + losses;

  return {
    trades,
    wins,
    losses,
    ties,
    winRate: decided > 0 ? (wins / decided) * 100 : 0,
    evaluated,
    pairsUsed,
    pairsRequested: symbols.length,
    avgCandlesBetweenSignals:
      signalGaps.length > 0 ? signalGaps.reduce((a, b) => a + b, 0) / signalGaps.length : null,
    signalsPer100: evaluated > 0 ? (trades.length / evaluated) * 100 : 0,
    blockedReasons: [...blocked]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    perPair: perPair.sort((a, b) => b.trades - a.trades),
    coverage: { hours: hoursSeen.size, days: daysSeen.size, unjudgeable, gaps: gapsFound, barsDropped },
    warnings,
  };
}

/**
 * How much to trust a win rate.
 *
 * A 100% win rate off three trades is noise, and presenting it as a headline
 * number is how a strategy gets shipped on the strength of nothing. The 95%
 * confidence interval on the proportion says plainly how wide the uncertainty
 * still is.
 */
export function confidence(wins: number, decided: number): { low: number; high: number } | null {
  if (decided < 5) return null;
  return wilson(wins, decided);
}

/** A plain reading of the result, so the number is not left to interpretation. */
export function verdict(r: BacktestReport): { tone: 'good' | 'ok' | 'bad'; text: string } {
  const decided = r.wins + r.losses;

  if (r.trades.length === 0) {
    return {
      tone: 'bad',
      text: 'لم تصدر أي إشارة على كل التاريخ المتاح — الشروط متشددة جداً أو متناقضة. شوف أسباب الرفض تحت.',
    };
  }
  // No judgement at all below the sample floor. The old text called 20 trades
  // "a small sample" and then printed the win rate anyway, which is the number
  // people read and remember.
  if (decided < MIN_TRADES_TO_JUDGE) {
    return {
      tone: 'ok',
      text:
        `${decided} صفقة محسومة فقط — عيّنة غير كافية. مفيش حكم تحت ${MIN_TRADES_TO_JUDGE} صفقة، ` +
        `والنسبة على العدد ده بتتحرك بالصدفة وحدها. وسّع العيّنة بأزواج أكتر أو فريم أطول.`,
    };
  }

  const ci = wilson(r.wins, decided);
  const range = `[${ci.low.toFixed(1)} — ${ci.high.toFixed(1)}]`;
  const head = `نسبة نجاح ${r.winRate.toFixed(1)}% على ${decided} صفقة · مجال ثقة 95% ${range}`;

  // The bar is not 50%. A binary option paying 80–90% needs 52.6–55.6% just to
  // return the stake, so anything under the top of that band loses money.
  if (ci.low > BREAKEVEN_HIGH) {
    return { tone: 'good', text: `${head} — كل المجال فوق نقطة التعادل (${BREAKEVEN_HIGH}%). دي أقوى حاجة العيّنة دي تقدر تقولها.` };
  }
  if (r.winRate >= BREAKEVEN_HIGH) {
    return {
      tone: 'ok',
      text: `${head} — فوق التعادل، لكن المجال لسه بينزل تحته (${ci.low.toFixed(1)}%). محتاجة عيّنة أكبر قبل ما تتبني عليها.`,
    };
  }
  if (r.winRate >= BREAKEVEN_LOW) {
    return {
      tone: 'bad',
      text: `${head} — جوّه نطاق التعادل (${BREAKEVEN_LOW}–${BREAKEVEN_HIGH}%). فوق الـ 50% مش ربح: بعائد 80–90% ده بيرجّع رأس المال تقريبًا ولا أكتر.`,
    };
  }
  return {
    tone: 'bad',
    text: `${head} — تحت نقطة التعادل (${BREAKEVEN_LOW}%). خاسرة على العيّنة دي. راجع قواعد primary.`,
  };
}
