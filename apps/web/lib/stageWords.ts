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

/** One short line: what is left before this pair can produce a trade. */
export function remainingText(progress: SetupProgress, price: number): string {
  switch (progress.stage) {
    case 'fired':
      return tr('اتأكد — الصفقة داخلة الشمعة الجاية', 'Confirmed — the trade enters next candle');

    case 'armed': {
      if (progress.level === undefined || progress.gap === undefined) {
        return tr('مستني السعر يلمس المستوى', 'Waiting for price to reach the level');
      }
      // Touched on the live price, but the strategy judges on the CLOSE — so
      // this is the one state where saying "the trade is coming" would be a
      // promise the strategy has not made.
      if (progress.gap <= 0) {
        return tr('لمس المستوى — مستني الشمعة تقفل تأكّد', 'Level touched — waiting for the candle to close');
      }
      return tr(
        `فاضل ${pips(progress.gap, price)} نقطة على المستوى`,
        `${pips(progress.gap, price)} pips left to the level`,
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
 * How to order two pairs.
 *
 * By stage first, then by the gap that is actually left — not by percentage.
 * The percentage is a fraction of each pair's OWN leg, so two pairs can both
 * read 90% while one needs a pip and the other needs six. The user is choosing
 * what to watch next, and "nearly touching" beats "90% of a long way".
 */
export function byNearest(a: SetupProgress, b: SetupProgress): number {
  const rank = (p: SetupProgress): number =>
    p.stage === 'fired' ? 4 : p.stage === 'armed' ? 3 : p.stage === 'rejected' ? 2 : p.stage === 'pivots' ? 1 : 0;

  const byStage = rank(b) - rank(a);
  if (byStage !== 0) return byStage;

  // Within the armed band, the smaller remaining distance wins.
  if (a.gap !== undefined && b.gap !== undefined) return a.gap - b.gap;
  return b.percent - a.percent;
}
