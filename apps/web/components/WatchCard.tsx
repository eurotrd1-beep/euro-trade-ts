'use client';

/**
 * The watched pairs, and where each one stands.
 *
 * ── WHAT IT ANSWERS ────────────────────────────────────────────────────────
 *
 * With one pair on the chart and four more being watched behind it, the screen
 * could say nothing at all about those four. The user picked them, the app
 * evaluates them every few seconds, and none of that was visible: the only way
 * to find out whether anything was brewing on GBP/JPY was to open it and look.
 *
 * Two sections, because a pair is in one of two states that mean entirely
 * different things:
 *
 *   • trading — a real signal fired and a trade is running on it
 *   • forming — its conditions are partly met and it is on its way
 *
 * Anything with no setup at all is simply not listed. It is not at 0%: there is
 * nothing to measure on it, and a row claiming otherwise would fill the card
 * with pairs that have nothing to say.
 *
 * ── THE ORDER, AND THE BARS ────────────────────────────────────────────────
 *
 * Sorted by completion, nearest first, and re-sorted whenever the numbers move,
 * so the top of the list is always the pair closest to firing. The bars come
 * from the same `completions` map the bar above the chart reads, in the same
 * render — one source, so the two can never disagree about a pair at the same
 * moment. The motion is a CSS transition across the gap between updates rather
 * than a faster update: the number moves with the price, and the price arrives
 * when it arrives.
 *
 * Every row opens that pair's chart. Including a trading one — a trade running
 * somewhere else is precisely what somebody wants to look at.
 */

import { useMemo } from 'react';
import { tr, type PairRow } from '@euro/shared';
import type { SetupProgress, TradingSignal } from '@euro/engine';
import styles from './WatchCard.module.css';

export interface WatchCardProps {
  /** The user's chosen pairs, as chart symbols. */
  watched: readonly string[];
  pairs: PairRow[];
  /**
   * Stage and percentage per symbol.
   *
   * Every watched pair is in here, not only the ones with a setup: the scale is
   * spread across the strategy's own gates, so a pair still looking for a swing
   * has a real position on it rather than being missing.
   */
  completions: Readonly<Record<string, SetupProgress>>;
  /** The open trade, whichever pair it is on. */
  activeSignal: TradingSignal | null;
  /** The chart on screen, so the row for it can be marked rather than moved. */
  chartSymbol: string;
  /**
   * Pairs whose market is shut. Listed, but set apart.
   *
   * Not silently dropped: a pair the user chose and cannot see reads as the app
   * having lost it, and "closed for the weekend" is a state that ends on its
   * own. They are pushed to the bottom, since a market that cannot move is not
   * competing for attention with one that is.
   */
  closedPairs: Readonly<Record<string, boolean>>;
  onSelect: (chartSymbol: string) => void;
}

export function WatchCard({
  watched,
  pairs,
  completions,
  activeSignal,
  chartSymbol,
  closedPairs,
  onSelect,
}: WatchCardProps) {
  const nameOf = useMemo(() => {
    const byChart = new Map(pairs.map((p) => [p.chart_symbol, p.symbol]));
    // The catalogue's own name, never one derived from the symbol: it calls
    // `XAUUSD_otc` "Gold OTC", and nine pairs read nothing like their symbols.
    return (sym: string): string => byChart.get(sym) ?? sym;
  }, [pairs]);

  const tradingSymbol =
    activeSignal !== null && activeSignal.status === 'ACTIVE' ? (activeSignal.symbol ?? null) : null;

  const forming = useMemo(() => {
    return (
      watched
        .filter((sym) => sym !== tradingSymbol)
        // EVERY chosen pair, not only the ones a sweep has reached. A pair the
        // user picked and cannot find in their own list looks like the app
        // dropped it; the honest answer for one with no reading yet is a row at
        // the bottom saying so, not an absence.
        .map((sym) => ({
          symbol: sym,
          ...(completions[sym] ?? { stage: 'idle' as const, percent: 0 }),
        }))
        // Re-sorted on every update, so the pair nearest to firing is always in
        // the five rows the card shows without scrolling.
        .map((f) => ({ ...f, shut: closedPairs[f.symbol] === true }))
        // Closed markets last, whatever their reading says: a pair that cannot
        // move is not competing with one that can.
        .sort(
          (a, b) =>
            Number(a.shut) - Number(b.shut) ||
            b.percent - a.percent ||
            a.symbol.localeCompare(b.symbol),
        )
    );
  }, [watched, completions, tradingSymbol, closedPairs]);

  if (watched.length === 0) return null;

  const quiet = tradingSymbol === null && forming.length === 0;

  return (
    <section className={styles.card}>
      <header className={styles.head}>
        <span aria-hidden="true">👁️</span>
        <h2 className={styles.title}>{tr('الأزواج اللي بتتابعها', 'Pairs you follow')}</h2>
        <span className={styles.total}>{watched.length}</span>
      </header>

      {tradingSymbol !== null && activeSignal !== null && (
        <>
          <p className={styles.section}>{tr('بدأت فيها إشارة', 'Signal started')}</p>
          <button
            type="button"
            onClick={() => onSelect(tradingSymbol)}
            className={`${styles.row} ${styles.trading} ${
              tradingSymbol === chartSymbol ? styles.onChart : ''
            }`}
          >
            <span className={styles.dot} aria-hidden="true">
              {activeSignal.direction === 'CALL' ? '▲' : '▼'}
            </span>
            <span className={styles.name}>{nameOf(tradingSymbol)}</span>
            <span className={styles.badge}>
              {activeSignal.stage === 'martingale'
                ? tr('مضاعفة', 'Recovery')
                : tr('صفقة شغالة', 'Trading')}
            </span>
          </button>
        </>
      )}

      <p className={styles.section}>{tr('قربت الشروط تكتمل', 'Conditions forming')}</p>

      {forming.length === 0 ? (
        <p className={styles.empty}>
          {quiet
            ? tr('مفيش زوج قرّب لسه — بنراقب.', 'Nothing is close yet — still watching.')
            : tr('مفيش زوج تاني قرّب دلوقتي.', 'No other pair is close right now.')}
        </p>
      ) : (
        <ul className={styles.list}>
          {forming.map((f) => {
            const pct = Math.round(f.percent);
            // The pair has everything it needs and the trade opens on the next
            // candle. Said in words rather than as another percentage: at that
            // point the number has stopped being the useful thing about it.
            const next = f.stage === 'fired';
            return (
              <li key={f.symbol}>
                <button
                  type="button"
                  onClick={() => onSelect(f.symbol)}
                  className={`${styles.row} ${f.symbol === chartSymbol ? styles.onChart : ''} ${
                    f.shut ? styles.shutRow : next ? styles.next : ''
                  }`}
                >
                  <span className={styles.name}>{nameOf(f.symbol)}</span>
                  {f.shut ? (
                    <span className={styles.shut}>{tr('السوق مقفول', 'Market closed')}</span>
                  ) : next ? (
                    <span className={styles.nextBadge}>
                      {tr('الإشارة الشمعة الجاية', 'Signal next candle')}
                    </span>
                  ) : (
                    <>
                      <span className={styles.pct}>{pct}%</span>
                      <span className={styles.bar} aria-hidden="true">
                        <span className={styles.fill} style={{ width: `${pct}%` }} />
                      </span>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
