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
 *     1m  × 100 → 0.07 day,  2/24 hours
 *     15m × 100 → 1.03 days, 24/24 hours
 *     1h  × 100 → 4.13 days, 24/24 hours
 *
 * Those numbers were re-measured against the live proxy. An earlier version of
 * this note claimed `1h × 71 → 34.3 days`, which described a history riddled
 * with holes: 71 stored bars spread thin across a month. The proxy now returns
 * 100 essentially contiguous bars per timeframe, so an hour of chart is an hour
 * of history — better data, and a quarter of the span the old line promised.
 * Anyone sizing a backtest off 34 days was sizing it off a gap.
 *
 * Gap splitting then costs more than it looks: of 183 symbols, 98 survive with
 * a segment long enough to clear the warm-up. The rest are simply too short.
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
  type Candle,
  type CycleResult,
  type ProgramStage,
  type SetupDiagnostics,
  type StrategyProgram,
} from '@euro/engine';
import { fetchCandles } from './candles';

/**
 * Bars fed to the program before its answers are counted.
 *
 * It used to be 55, sized for indicators looking back fifty bars. A program
 * has its own minimum and enforces it — fib236 refuses to look at all until it
 * has twelve candles behind the one it is judging — so this only has to be
 * enough for that, and every bar above it is history thrown away.
 */
const WARMUP = 15;

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

/**
 * Below this the sample is a slice of one part of the day.
 *
 * It used to gate the clock-reading indicators, which no longer exist. It still
 * matters for a different reason: an hour of the London session and an hour of
 * the Asian one are different markets, and a result measured on one of them is
 * a result about that hour.
 */
const MIN_HOURS_COVERED = 24;

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
  /**
   * The program to replay — the plan's own, whichever that is.
   *
   * Not a strategy id and not a JSON file: the thing handed in here is the
   * same object the live app drives, so what this measures cannot drift from
   * what ships. The timeframe and the trade length come from it too, which is
   * why neither is a parameter any more.
   */
  program: StrategyProgram;
  /** OTC symbols to replay, e.g. ['EURUSD_otc', 'GBPUSD_otc']. */
  symbols: string[];
  onProgress?: (done: number, total: number) => void;
}

export interface Trade {
  symbol: string;
  direction: 'CALL' | 'PUT';
  /** Which trade of its cycle this was. */
  stage: ProgramStage;
  entry: number;
  exit: number;
  outcome: 'WIN' | 'LOSS' | 'TIE';
  /** Candle index the trade ran on. */
  at: number;
}

/**
 * Cycles, which is the unit that actually decides whether this makes money.
 *
 * A martingale strategy cannot be judged on trades. Two trades at 1× and 2×
 * that go loss-then-win are a PROFIT; counted as trades they are 50%, which
 * reads as break-even and is wrong in both directions. So the trades are
 * reported for detail and the cycles are reported for the verdict.
 */
/**
 * What the search did across the whole replay.
 *
 * Every one of these is a decision the program reported having made — none of
 * it is recomputed here. That distinction is the point: a backtest that worked
 * out for itself why a setup was refused would be a second copy of the rules,
 * and the two copies would drift.
 */
export interface SearchTally {
  /** Candidate pairs the search looked at, across every candle. */
  pairsExamined: number;
  /** Refused: same kind, or no range. */
  rejectedShape: number;
  /** Refused: a swing candle already contained its own 23.6% level. */
  rejectedSwingTouched: number;
  /** Refused at selection: price had already left the end of the leg. */
  rejectedBroken: number;
  /** Refused: that swing had already produced its one signal. */
  rejectedAlreadyFired: number;
  /** Setups adopted and watched. */
  armed: number;
  /** Adopted setups retired later because price broke the end of the leg. */
  retiredBroken: number;
  /** Adopted setups retired because the leg aged out of the window. */
  retiredAged: number;
}

export interface CycleTally {
  total: number;
  /** Won on the first trade, no double needed. */
  won: number;
  /** Lost the first, won the double — net positive at 2× stake. */
  recovered: number;
  /** Lost both. This is the one that costs 3× a single stake. */
  finalLoss: number;
  /** Ended level. Excluded from the rate, as ties are everywhere else. */
  tie: number;
  /** The entry candle never arrived — nothing was traded. */
  aborted: number;
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
  /** What the search did — examined, refused, adopted, retired. */
  search: SearchTally;
  /** Signals by direction, primary trades only. */
  primary: {
    signals: number;
    call: number;
    put: number;
    wins: number;
    losses: number;
    ties: number;
    /** Wins over decided primaries, ties excluded. */
    winRate: number;
  };
  /** The doubles. */
  martingale: { count: number; wins: number; losses: number; ties: number };
  /** Cycles, tallied by how they ended. */
  cycles: CycleTally;
  /** Final losses over cycles decided. The number that costs 3× a stake. */
  finalLossRate: number;
  /**
   * Cycles won as a percentage of cycles decided — recovered counts as won.
   *
   * This is the headline. `winRate` above it is per TRADE and is the more
   * flattering of the two whenever the martingale is doing badly, because a
   * losing double adds one loss to a denominator that already counted its
   * cause.
   */
  cycleWinRate: number;
  perPair: Array<{ symbol: string; trades: number; wins: number; losses: number }>;
  /** What window the sample actually spanned. */
  coverage: {
    /** Distinct UTC hours seen, out of 24. */
    hours: number;
    /** Distinct calendar days seen. */
    days: number;
    /** Holes in the scraped history that the replay was split at. */
    gaps: number;
    /** Bars thrown away because their segment was shorter than the warm-up. */
    barsDropped: number;
  };
  warnings: string[];
}

/** One candle's counters, into the running total. */
function addDiagnostics(t: SearchTally, d: SetupDiagnostics): void {
  t.pairsExamined += d.pairsExamined;
  t.rejectedShape += d.rejectedShape;
  t.rejectedSwingTouched += d.rejectedSwingTouched;
  t.rejectedBroken += d.rejectedBroken;
  t.rejectedAlreadyFired += d.rejectedAlreadyFired;
  if (d.armed) t.armed++;
  if (d.retiredBroken) t.retiredBroken++;
  if (d.retiredAged) t.retiredAged++;
}

/** One finished cycle, into the bucket that describes it. */
function tallyCycle(t: CycleTally, result: CycleResult): void {
  t.total++;
  if (result === 'WIN') t.won++;
  else if (result === 'RECOVERED') t.recovered++;
  else if (result === 'FINAL_LOSS') t.finalLoss++;
  else if (result === 'TIE' || result === 'RECOVERED_TIE') t.tie++;
  else t.aborted++;
}

export async function backtest(args: BacktestArgs): Promise<BacktestReport> {
  const { program, symbols, onProgress } = args;

  const interval = program.timeframe;
  const timeframeMs = (STEP_SECONDS[interval] ?? 60) * 1000;

  const trades: Trade[] = [];
  const perPair: BacktestReport['perPair'] = [];
  const cycles: CycleTally = { total: 0, won: 0, recovered: 0, finalLoss: 0, tie: 0, aborted: 0 };
  const search: SearchTally = {
    pairsExamined: 0, rejectedShape: 0, rejectedSwingTouched: 0, rejectedBroken: 0,
    rejectedAlreadyFired: 0, armed: 0, retiredBroken: 0, retiredAged: 0,
  };
  let callSignals = 0;
  let putSignals = 0;
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

    if (!candles || candles.length < WARMUP + 5) {
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
      step === undefined ? [candles] : contiguousRuns(candles, step, WARMUP + 5);
    const dropped = candles.length - segments.reduce((n2, seg) => n2 + seg.length, 0);
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
      // A fresh mind per segment: state carried across a hole would settle a
      // trade opened days earlier against the wrong candle.
      const state = program.init();
      let lastSignalAt: number | null = null;

      for (let i = WARMUP; i < segment.length; i++) {
        // Only the past, and only within this segment. The window handed over
        // is exactly what the live app would have had at that moment, and
        // `now` is the instant that candle closed — so a program that reaches
        // for a candle it should not see gets nothing, here as in production.
        const window = segment.slice(0, i + 1);
        const closed = window[i]!;
        evaluated++;

        let event;
        try {
          event = program.onCandleClose(
            { candles: window, timeframeMs, now: closed.time + timeframeMs },
            state,
          );
        } catch {
          continue;
        }

        if (event.settled !== null) {
          const t = event.settled;
          trades.push({
            symbol,
            direction: t.direction,
            stage: t.stage,
            entry: t.entryPrice,
            exit: t.exitPrice,
            outcome: t.result,
            at: i,
          });
          pairTrades++;
          if (t.result === 'WIN') pairWins++;
          else if (t.result === 'LOSS') pairLosses++;
        }

        if (event.diagnostics !== undefined) addDiagnostics(search, event.diagnostics);

        if (event.signal !== null) {
          if (event.signal.stage === 'primary') {
            if (event.signal.direction === 'CALL') callSignals++;
            else putSignals++;
          }
          if (lastSignalAt !== null) signalGaps.push(i - lastSignalAt);
          lastSignalAt = i;
        }

        if (event.cycleEnd !== null) tallyCycle(cycles, event.cycleEnd);
      }
    }

    perPair.push({ symbol, trades: pairTrades, wins: pairWins, losses: pairLosses });
  }

  onProgress?.(symbols.length, symbols.length);

  if (gapsFound > 0) {
    warnings.push(
      `⚠️ التاريخ فيه ${gapsFound} فجوة — السكرابر بيسجّل وهو شغّال بس. الاختبار اتقسّم عندها، ` +
        `و${barsDropped} شمعة اتشالت لأن قطعتها أقصر من فترة الإحماء. من غير التقسيم ده كانت قفزة ` +
        `الفجوة هتتقري كشمعة عنيفة واحدة.`,
    );
  }

  if (hoursSeen.size < MIN_HOURS_COVERED) {
    warnings.push(
      `⚠️ العينة تغطي ${hoursSeen.size} ساعة فقط من 24 (${daysSeen.size} يوم). الاستراتيجية دي ` +
        'مبتقراش الساعة، فالتغطية مش بتأثر على صحة الحساب — لكنها بتأثر على حجم العيّنة، وسوق ' +
        'الساعة دي مش شرط يشبه باقي اليوم.',
    );
  }

  const wins = trades.filter((t) => t.outcome === 'WIN').length;
  const losses = trades.filter((t) => t.outcome === 'LOSS').length;
  const ties = trades.filter((t) => t.outcome === 'TIE').length;
  const decided = wins + losses;

  const of = (stage: ProgramStage, outcome: Trade['outcome']) =>
    trades.filter((t) => t.stage === stage && t.outcome === outcome).length;

  const pWins = of('primary', 'WIN');
  const pLosses = of('primary', 'LOSS');
  const pDecided = pWins + pLosses;
  const mCount = trades.filter((t) => t.stage === 'martingale').length;

  // A cycle is decided when it ended in profit or in loss. Ties and aborts are
  // neither, exactly as ties are excluded from the per-trade rate.
  const cyclesWon = cycles.won + cycles.recovered;
  const cyclesDecided = cyclesWon + cycles.finalLoss;

  if (cycles.recovered + cycles.finalLoss > 0 && cycles.recovered === 0) {
    warnings.push(
      `⚠️ المضاعفة اشتغلت ${cycles.finalLoss} مرة وما عوّضتش ولا مرة على العيّنة دي. ` +
        'المضاعفة بتضاعف حجم الخسارة لما تفشل، فالرقم ده أهم من نسبة الصفقات فوقه.',
    );
  }

  return {
    trades,
    wins,
    losses,
    ties,
    winRate: decided > 0 ? (wins / decided) * 100 : 0,
    search,
    primary: {
      signals: callSignals + putSignals,
      call: callSignals,
      put: putSignals,
      wins: pWins,
      losses: pLosses,
      ties: of('primary', 'TIE'),
      winRate: pDecided > 0 ? (pWins / pDecided) * 100 : 0,
    },
    martingale: {
      count: mCount,
      wins: of('martingale', 'WIN'),
      losses: of('martingale', 'LOSS'),
      ties: of('martingale', 'TIE'),
    },
    cycles,
    finalLossRate: cyclesDecided > 0 ? (cycles.finalLoss / cyclesDecided) * 100 : 0,
    cycleWinRate: cyclesDecided > 0 ? (cyclesWon / cyclesDecided) * 100 : 0,
    evaluated,
    pairsUsed,
    pairsRequested: symbols.length,
    avgCandlesBetweenSignals:
      signalGaps.length > 0 ? signalGaps.reduce((a, b) => a + b, 0) / signalGaps.length : null,
    signalsPer100: evaluated > 0 ? (trades.length / evaluated) * 100 : 0,
    perPair: perPair.sort((a, b) => b.trades - a.trades),
    coverage: { hours: hoursSeen.size, days: daysSeen.size, gaps: gapsFound, barsDropped },
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
      text: 'لم تصدر أي إشارة على كل التاريخ المتاح — يا إما مفيش سوينج صالح في العيّنة، يا إما السعر ما لمسش 0.236 ولا مرة.',
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
