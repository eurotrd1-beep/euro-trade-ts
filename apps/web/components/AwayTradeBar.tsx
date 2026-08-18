'use client';

/**
 * A trade is running, on a pair that is not the one on screen.
 *
 * ── THE PROBLEM IT SOLVES ──────────────────────────────────────────────────
 *
 * There is one open trade for the whole app, and one chart. When they are the
 * same pair, everything on screen describes one market and the user can read it
 * straight. When they are not, the old screen showed the trade card for gold
 * above the candles of EUR/USD — two markets' numbers stacked with nothing
 * saying which was which, and the entry line of one drawn across the other.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * Everything on screen belongs to the pair on screen. So when the user navigates
 * away from the trade, the card does not dim or shrink — it goes, along with the
 * entry line and the countdown overlay — and this takes its place.
 *
 * It carries the pair name INSIDE it, which is the whole point: it is the only
 * trade information visible, and it names its own market, so there is no number
 * anywhere that could be read as belonging to the chart. One tap goes back.
 *
 * The trade itself is untouched. It keeps counting down, settles on its own
 * candle, and owes its martingale exactly as if nobody had navigated at all —
 * this is a change to what is DISPLAYED, and to nothing else.
 */

import { tr } from '@euro/shared';
import styles from './AwayTradeBar.module.css';

export interface AwayTradeBarProps {
  /** The pair the trade is on, as a person reads it. */
  pair: string;
  direction: 'CALL' | 'PUT';
  secondsRemaining: number;
  /** True for the doubled recovery trade, which is the one worth flagging. */
  martingale: boolean;
  /**
   * How many trades are running away from this chart, this one included.
   *
   * Each watched pair runs its own cycle, so there can be several. The bar
   * names the nearest to finishing and counts the rest: "a trade is running
   * elsewhere" and "three are" are different things to know, and a bar that
   * mentioned only one would be hiding the others.
   */
  awayCount: number;
  onGoBack: () => void;
}

function mmss(total: number): string {
  const s = Math.max(0, total);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function AwayTradeBar({
  pair,
  direction,
  secondsRemaining,
  martingale,
  awayCount,
  onGoBack,
}: AwayTradeBarProps) {
  return (
    // `alert` rather than `status`: this is the one thing on the page that is
    // about a different market, and a screen reader landing here needs to know
    // that before it reads any of the numbers around it.
    <div className={styles.bar} role="alert">
      <span className={styles.icon} aria-hidden="true">
        {martingale ? '🔁' : '⏱️'}
      </span>

      <span className={styles.text}>
        {martingale
          ? tr('مضاعفة شغالة على ', 'Recovery trade running on ')
          : tr('صفقة شغالة على ', 'Trade running on ')}
        <strong>{pair}</strong>
        <span className={styles.dir}> · {direction === 'CALL' ? '▲' : '▼'} {direction}</span>
        {awayCount > 1 && (
          <span className={styles.more}>
            {tr(` · و${awayCount - 1} غيرها`, ` · and ${awayCount - 1} more`)}
          </span>
        )}
      </span>

      <span className={styles.clock} dir="ltr">
        {mmss(secondsRemaining)}
      </span>

      <button type="button" onClick={onGoBack} className={styles.back}>
        {tr('روح لها', 'Go to it')}
      </button>
    </div>
  );
}
