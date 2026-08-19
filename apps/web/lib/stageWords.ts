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
      // Three things can be true once a setup is armed, and they are different
      // enough that one sentence cannot carry all of them:
      //   ≥ 98  the ‹A11› depth is already there — only the close is outstanding
      //   ≥ 95  price is past the level but still short of the depth
      //   ≥ 90  the level was touched and price came back off it
      const left = secondsToClose(timeframeSeconds);
      if (progress.percent >= 98) {
        return tr(
          `العمق اتحقق — لو قفلت كده فيه إشارة · باقي ${left}ث`,
          `Depth met — a signal if it closes here · ${left}s left`,
        );
      }
      if (progress.percent >= 95 && progress.needBps !== undefined) {
        return tr(
          `فاضل ${progress.needBps.toFixed(1)} نقطة أساس للعمق · باقي ${left}ث للإغلاق`,
          `${progress.needBps.toFixed(1)} bps of depth to go · ${left}s to close`,
        );
      }
      if (progress.percent >= 90) {
        return tr(
          `لمس المستوى ورجع — مستني يعديه تاني · باقي ${left}ث`,
          `Touched and came back — waiting for it to cross again · ${left}s left`,
        );
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
 * How to order two pairs: by the percentage, highest first.
 *
 * The same number the row displays. Ordering by anything else — pips, stage,
 * distance — puts a pair showing 96% above one showing 98%, and there is no
 * explanation for that on screen: the reader can only see the two numbers and
 * the order contradicting them.
 *
 * Pips and the percentage nearly agree, since the percentage falls as the gap
 * grows, but not exactly: the gap is measured against each pair's own leg, so
 * equal distances on unequal legs give different readings. When they disagree
 * the visible number wins.
 *
 * Not rounded. The order is meant to move — "which pair is closest" changes
 * tick by tick — and a tie falls to the symbol so equal readings hold a fixed
 * order instead of an arbitrary one.
 */
export function byNearest(a: SetupProgress, b: SetupProgress): number {
  return b.percent - a.percent;
}
