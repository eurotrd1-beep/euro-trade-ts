'use client';

/**
 * The pair the chart is following, and why.
 *
 * The chart moves on its own now. Without a line saying so, that is just a
 * screen that changes markets for no visible reason — and a user who does not
 * know why cannot tell it apart from a bug. So this says what is being watched,
 * how close it is, and offers the one control that matters: stop.
 *
 * It also has to be honest about the common case. Most of the time nothing is
 * close: at any given moment around seventy of the eighty-nine pairs have no
 * setup at all, and none of the rest may be near. That is not a loading state
 * and it is not an error, and saying "waiting" is the truth rather than a
 * placeholder for a number that does not exist yet.
 */

import { tr } from '@euro/shared';
import styles from './LeaderStrip.module.css';

export interface LeaderStripProps {
  /** Null when nothing is close enough to be worth following. */
  leader: { symbol: string; percent: number } | null;
  paused: boolean;
  /** Hidden entirely while a trade is on screen — that owns the chart. */
  tradeOpen: boolean;
  displayName: (chartSymbol: string) => string;
  onResume: () => void;
}

export function LeaderStrip({ leader, paused, tradeOpen, displayName, onResume }: LeaderStripProps) {
  if (tradeOpen) return null;

  if (paused) {
    return (
      <div className={styles.strip} role="status">
        <span className={styles.pausedIcon} aria-hidden="true">⏸️</span>
        <span className={styles.text}>
          {tr('المتابعة التلقائية موقوفة — إنت اخترت الزوج بنفسك', 'Auto-follow paused — you picked this pair')}
        </span>
        <button type="button" onClick={onResume} className={styles.resume}>
          {tr('استأنف', 'Resume')}
        </button>
      </div>
    );
  }

  if (leader === null) {
    return (
      <div className={`${styles.strip} ${styles.quiet}`} role="status">
        <span aria-hidden="true">👀</span>
        <span className={styles.text}>
          {tr('بنراقب كل الأزواج — مفيش فرصة قريبة دلوقتي', 'Watching every pair — nothing close yet')}
        </span>
      </div>
    );
  }

  const pct = Math.round(leader.percent);

  return (
    <div className={styles.strip} role="status">
      <span aria-hidden="true">🎯</span>
      <span className={styles.text}>
        {tr('أقرب فرصة: ', 'Closest: ')}
        <strong>{displayName(leader.symbol)}</strong>
      </span>

      {/* The number and the bar say the same thing, on purpose: the bar is
          read at a glance and the number is what makes it checkable. */}
      <span className={styles.bar} aria-hidden="true">
        <span className={styles.fill} style={{ width: `${pct}%` }} />
      </span>
      <span className={styles.pct} aria-label={tr(`اكتمال ${pct} في المية`, `${pct} percent complete`)}>
        {pct}%
      </span>
    </div>
  );
}
