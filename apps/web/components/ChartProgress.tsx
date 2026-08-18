'use client';

/**
 * How close the pair on the chart is to firing.
 *
 * Directly above the candles, because it is about the market underneath it and
 * nothing else. The percentage and the bar say the same thing on purpose: the
 * bar is read at a glance, the number is what makes it checkable.
 *
 * It reads the same `completions` map the watch card reads, in the same render.
 * That is the point of there being a map at all — two sources, even two correct
 * ones on slightly different clocks, would show one number here and a different
 * one in the card for the same pair at the same moment, and nothing on screen
 * would tell the user which was the real state.
 *
 * It is absent, not zero, when the pair has no confirmed setup. There is
 * genuinely nothing to measure then, and a bar sitting at 0% would suggest a
 * setup exists and is simply far away.
 *
 * And it is absent while a trade is running here, because the trade card is the
 * answer to "what is happening on this pair" at that point — a progress bar
 * beside it would be describing conditions that have already been met.
 */

import { tr } from '@euro/shared';
import type { SetupProgress } from '@euro/engine';
import { remainingText } from '@/lib/stageWords';
import styles from './ChartProgress.module.css';

export interface ChartProgressProps {
  /** Stage and percentage, or undefined before the first sweep has run. */
  progress: SetupProgress | undefined;
  /** True while a trade is open on this pair — the card takes over. */
  tradeHere: boolean;
  /** The pair's live price, for saying what distance is left. */
  price: number;
  /** Seconds in one candle, for the countdown beside the distance. */
  candleSeconds: number;
}

export function ChartProgress({ progress, tradeHere, price, candleSeconds }: ChartProgressProps) {
  if (tradeHere) return null;

  if (progress === undefined) {
    return (
      <div className={`${styles.strip} ${styles.quiet}`} role="status">
        <span aria-hidden="true">👀</span>
        <span className={styles.text}>
          {tr('لسه بيقرا الزوج ده', 'Reading this pair')}
        </span>
      </div>
    );
  }

  // FLOOR, never round. The approach caps at 99.9 by design, and rounding
  // turned that into a displayed 100 — a bar claiming a touch that had not
  // happened. 100 is a promise; only a real touch may print it.
  const pct = progress.percent >= 100 ? 100 : Math.floor(progress.percent);

  return (
    <div className={styles.strip} role="status">
      <span aria-hidden="true">{progress.stage === 'fired' ? '⚡' : '🎯'}</span>
      {/* The stage, not a fixed caption. A bar at 40% means nothing without
          knowing what the strategy is doing at 40%. */}
      <span className={styles.text}>{remainingText(progress, price, candleSeconds)}</span>
      <span className={styles.bar} aria-hidden="true">
        <span className={styles.fill} style={{ width: `${pct}%` }} />
      </span>
      <span
        className={styles.pct}
        aria-label={tr(`اكتمال ${pct} في المية`, `${pct} percent complete`)}
      >
        {pct}%
      </span>
    </div>
  );
}
