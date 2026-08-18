'use client';

/**
 * What the strategy is waiting for, in words.
 *
 * A percentage says how far along a pair is and nothing about what is holding
 * it up. 40% on one pair means it has found no usable leg yet; on another it
 * means it found one and refused it. Those are different situations with
 * different odds of turning into anything, and a bar alone cannot tell them
 * apart.
 *
 * Both the card and the strip above the chart read this, so one pair is never
 * described two ways on one screen.
 */

import { tr } from '@euro/shared';
import type { SetupProgress } from '@euro/engine';

/** A price gap at the pair's own scale — two decimals for yen-sized quotes. */
export function pips(gap: number, price: number): string {
  const pip = price >= 10 ? 0.01 : 0.0001;
  const n = gap / pip;
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

/** How long until the running candle closes, at this timeframe. */
export function secondsToClose(timeframeSeconds: number): number {
  const now = Date.now() / 1000;
  return Math.max(0, Math.ceil(timeframeSeconds - (now % timeframeSeconds)));
}

/** One short line: what is left before this pair can produce a trade. */
export function remainingText(
  progress: SetupProgress,
  price: number,
  timeframeSeconds = 60,
): string {
  switch (progress.stage) {
    case 'fired':
      return tr('اتأكد — الصفقة داخلة الشمعة الجاية', 'Confirmed — the trade enters next candle');

    case 'armed': {
      if (progress.level === undefined || progress.gap === undefined) {
        return tr('مستني السعر يلمس المستوى', 'Waiting for price to reach the level');
      }
      // The touch is the last condition, and the candle's high and low record
      // it whatever price does afterwards. So this is not a wait for
      // confirmation — it IS the confirmation.
      if (progress.percent >= 100) {
        return tr('لمس المستوى — الصفقة الشمعة الجاية', 'Level touched — the trade enters next candle');
      }
      // Both numbers, because both are moving and each answers half of "will
      // this happen": how far price still has to travel, and how long it has.
      return tr(
        `فاضل ${pips(progress.gap, price)} نقطة · الشمعة تقفل بعد ${secondsToClose(timeframeSeconds)}ث`,
        `${pips(progress.gap, price)} pips left · candle closes in ${secondsToClose(timeframeSeconds)}s`,
      );
    }

    case 'rejected':
      return tr('لقى ساق ورفضها — بيدوّر على غيرها', 'Found a leg and refused it — looking for another');

    case 'pivots':
      return tr('بيرتّب القمم والقيعان', 'Pairing up the highs and lows');

    default:
      return tr('لسه بيدوّر على سوينج مؤكد', 'Still looking for a confirmed swing');
  }
}

/**
 * How to order two pairs: by the reading, highest first.
 *
 * The reading already carries everything that decides the order — how close
 * price is, and how much of the candle is left to close the gap — so ordering
 * by it means the list ranks by the same number the user is reading off the
 * bars. Sorting by anything else would put a pair above another that shows a
 * lower percentage, which is the kind of thing nobody can explain.
 *
 * Compared to one decimal place. The percentages move continuously, and two
 * pairs a thousandth apart swapping places every second is a list that cannot
 * be read; a tenth is finer than the bars can show and coarse enough to hold
 * still. Ties fall to the symbol, so equal readings have a fixed order rather
 * than an arbitrary one.
 */
export function byNearest(a: SetupProgress, b: SetupProgress): number {
  return Math.round(b.percent * 10) - Math.round(a.percent * 10);
}
