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
    pairsUsed++;

    let pairTrades = 0;
    let pairWins = 0;
    let pairLosses = 0;
    let lastSignalAt: number | null = null;
    let blockedUntil = -1;

    for (let i = WARMUP; i < candles.length - horizon; i++) {
      // Only the past. Slicing per step is what keeps this honest.
      const window = candles.slice(0, i + 1);
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
      const exit = candles[i + horizon]!.close;
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

    perPair.push({ symbol, trades: pairTrades, wins: pairWins, losses: pairLosses });
  }

  onProgress?.(symbols.length, symbols.length);

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
  const p = wins / decided;
  const se = Math.sqrt((p * (1 - p)) / decided);
  return {
    low: Math.max(0, (p - 1.96 * se) * 100),
    high: Math.min(100, (p + 1.96 * se) * 100),
  };
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
  if (decided < 10) {
    return {
      tone: 'ok',
      text: `${r.trades.length} صفقة فقط — عيّنة صغيرة، النسبة دي مش مؤشر يُبنى عليه. جرّب أزواج أكتر أو خفّف الشروط.`,
    };
  }
  if (r.winRate >= 65) {
    return { tone: 'good', text: `نسبة نجاح ${r.winRate.toFixed(1)}% على ${decided} صفقة — نتيجة قوية.` };
  }
  if (r.winRate >= 55) {
    return { tone: 'ok', text: `نسبة نجاح ${r.winRate.toFixed(1)}% على ${decided} صفقة — مقبولة، لكن فيها مجال للتحسين.` };
  }
  return {
    tone: 'bad',
    text: `نسبة نجاح ${r.winRate.toFixed(1)}% على ${decided} صفقة — أقل من المستوى المطلوب. راجع قواعد primary.`,
  };
}
