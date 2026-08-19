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
import { outcomeFor, type SetupProgress, type TradingSignal } from '@euro/engine';
import { byNearest, remainingText } from '@/lib/stageWords';
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
  /**
   * Every running trade, by symbol.
   *
   * All of them, not the one on the chart. The card used to take a single
   * `activeSignal`, which is derived from whichever pair is being displayed —
   * so with four trades running, three of them sat in "conditions forming"
   * wearing a badge that said the trade was already coming, and only moved to
   * the right section when the user opened them. Opening a pair is not what
   * starts its trade.
   */
  openTrades: Readonly<Record<string, TradingSignal>>;
  /** The chart on screen, so the row for it can be marked rather than moved. */
  chartSymbol: string;
  /** Live prices by symbol, for saying how much distance is left on each. */
  prices: Readonly<Record<string, number>>;
  /** Seconds in one candle, for the countdown in each row. */
  candleSeconds: number;
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
  openTrades,
  chartSymbol,
  closedPairs,
  prices,
  candleSeconds,
  onSelect,
}: WatchCardProps) {
  const nameOf = useMemo(() => {
    const byChart = new Map(pairs.map((p) => [p.chart_symbol, p.symbol]));
    // The catalogue's own name, never one derived from the symbol: it calls
    // `XAUUSD_otc` "Gold OTC", and nine pairs read nothing like their symbols.
    return (sym: string): string => byChart.get(sym) ?? sym;
  }, [pairs]);

  /** Every pair with a trade on it, nearest to finishing first. */
  const trading = useMemo(
    () =>
      Object.entries(openTrades)
        .filter(([, t]) => t.status === 'ACTIVE')
        .sort((a, b) => a[1].expiryTime - b[1].expiryTime),
    [openTrades],
  );
  const tradingSet = useMemo(() => new Set(trading.map(([sym]) => sym)), [trading]);

  /**
   * Where each running trade stands right now, by the engine's own rule.
   *
   * `outcomeFor` and not a comparison written here: the draw band is part of
   * what makes a trade a win, and a row that turned green on a move smaller
   * than the band would be promising a result the settlement will not give.
   * A trade inside the band shows neither colour, which is the truth — it is
   * currently going nowhere.
   *
   * Live, not settled: this is what the trade is doing, and it changes with
   * every tick until the candle closes.
   */
  const standing = useMemo(() => {
    const out: Record<string, 'WIN' | 'LOSS' | 'TIE'> = {};
    for (const [sym, t] of trading) {
      const price = prices[sym];
      if (typeof price !== 'number' || price <= 0 || t.entryPrice <= 0) continue;
      out[sym] = outcomeFor(t.direction, t.entryPrice, price);
    }
    return out;
  }, [trading, prices]);

  const forming = useMemo(() => {
    return (
      watched
        .filter((sym) => !tradingSet.has(sym))
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
        // Closed markets last, whatever their reading says — a pair that cannot
        // move is not competing with one that can — then by what is actually
        // left, which is not the same as by percentage. See `byNearest`.
        .sort(
          (a, b) =>
            Number(a.shut) - Number(b.shut) ||
            byNearest(a, b) ||
            a.symbol.localeCompare(b.symbol),
        )
    );
  }, [watched, completions, tradingSet, closedPairs]);

  if (watched.length === 0) return null;

  const quiet = trading.length === 0 && forming.length === 0;

  return (
    <section className={styles.card}>
      <header className={styles.head}>
        <span aria-hidden="true">👁️</span>
        <h2 className={styles.title}>{tr('الأزواج اللي بتتابعها', 'Pairs you follow')}</h2>
        <span className={styles.total}>{watched.length}</span>
      </header>

      {trading.length > 0 && (
        <>
          <p className={styles.section}>
            {tr(`بدأت فيها إشارة (${trading.length})`, `Signal started (${trading.length})`)}
          </p>
          <ul className={styles.list}>
            {trading.map(([sym, t]) => (
              <li key={sym}>
                <button
                  type="button"
                  onClick={() => onSelect(sym)}
                  className={`${styles.row} ${styles.trading} ${
                    standing[sym] === 'WIN'
                      ? styles.winning
                      : standing[sym] === 'LOSS'
                        ? styles.losing
                        : ''
                  } ${sym === chartSymbol ? styles.onChart : ''}`}
                >
                  <span className={styles.dot} aria-hidden="true">
                    {t.direction === 'CALL' ? '▲' : '▼'}
                  </span>
                  <span className={styles.name}>{nameOf(sym)}</span>
                  <span className={styles.badge}>
                    {t.stage === 'martingale' ? tr('مضاعفة', 'Recovery') : tr('صفقة شغالة', 'Trading')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
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
            // FLOOR, never round. The approach caps at 99.99 by design, and
            // `Math.round` turned that into a displayed 100 — a bar claiming a
            // trade that had not been given, beside text correctly saying the
            // level was still 35 pips away. 100 is a promise; only a closed
            // candle that met ‹A10› may print it.
            const pct = f.percent >= 100 ? 100 : Math.floor(f.percent);
            // The pair has everything it needs and the trade opens on the next
            // candle. Said in words rather than as another percentage: at that
            // point the number has stopped being the useful thing about it.
            const next = f.stage === 'fired';
            // Two rungs below a signal, and they are shown differently because
            // they mean different things:
            //
            //   near    ≥ 96  price is past the level and closing on the ‹A11›
            //                 depth. Early warning, so a jump to 100 at the
            //                 close does not arrive out of nowhere.
            //   holding ≥ 98  the depth is already met; only the close is
            //                 outstanding.
            //
            // NEITHER is a signal, and neither is styled like one — `.next` is
            // amber and means a trade exists.
            const holding = !next && f.stage === 'armed' && f.percent >= 98;
            const near = !next && !holding && f.stage === 'armed' && f.percent >= 96;
            // The single best opportunity on screen right now. The list is
            // already sorted by percentage, so it is the first row that has one.
            const best = !next && f.percent >= 96 && f.symbol === forming[0]?.symbol;
            // The ember edge: on at 96, off the moment it falls back under.
            // Both close states carry it, so what the eye tracks is the
            // threshold rather than which of the two rungs a row is on.
            const hot = !f.shut && !next && f.percent >= 96;
            return (
              <li key={f.symbol}>
                <button
                  type="button"
                  onClick={() => onSelect(f.symbol)}
                  className={`${styles.row} ${f.symbol === chartSymbol ? styles.onChart : ''} ${
                    f.shut
                      ? styles.shutRow
                      : next
                        ? styles.next
                        : holding
                          ? styles.holding
                          : near
                            ? styles.near
                            : ''
                  } ${hot ? styles.hot : ''} ${best ? styles.best : ''}`}
                >
                  <span className={styles.nameCol}>
                    <span className={styles.name}>{nameOf(f.symbol)}</span>
                    {!f.shut && (near || holding) && (
                      <span className={styles.heads}>
                        {holding
                          ? tr('قريب جدًا من إصدار إشارة', 'Very close to a signal')
                          : tr('إشارة محتملة قريبًا', 'A signal may be coming')}
                      </span>
                    )}
                    {!f.shut && (
                      <span className={styles.left}>
                        {remainingText(f, prices[f.symbol] ?? 0, candleSeconds)}
                      </span>
                    )}
                  </span>
                  {f.shut ? (
                    <span className={styles.shut}>{tr('السوق مقفول', 'Market closed')}</span>
                  ) : next ? (
                    <span className={styles.nextBadge}>
                      {tr('الإشارة الشمعة الجاية', 'Signal next candle')}
                    </span>
                  ) : (
                    <>
                      <span
                        className={`${styles.pct} ${holding ? styles.pctHolding : near ? styles.pctNear : ''}`}
                      >
                        {pct}%
                      </span>
                      <span className={styles.bar} aria-hidden="true">
                        <span
                          className={`${styles.fill} ${holding ? styles.fillHolding : near ? styles.fillNear : ''}`}
                          style={{ width: `${pct}%` }}
                        />
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
