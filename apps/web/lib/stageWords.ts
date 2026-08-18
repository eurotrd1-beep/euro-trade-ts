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
 * How to order two pairs: by how many pips are left to the level.
 *
 * ── WHY PIPS AND NOT THE PERCENTAGE ────────────────────────────────────────
 *
 * Every watched pair is on the same timeframe, so every candle closes at the
 * same instant and the time factor is identical for all of them. What is left
 * to separate them is distance — and the percentage does not rank by distance,
 * because it measures each pair's gap against its OWN leg. A pair with a long
 * leg and ten pips to go can read higher than one with a short leg and five,
 * and the second is the one about to fire.
 *
 * So the order is the raw distance, in pips, so a JPY pair and a EUR pair are
 * measured on the same scale rather than by their unscaled price difference.
 *
 * ── NO QUANTISING ──────────────────────────────────────────────────────────
 *
 * The comparison used to be rounded so the list would hold still. It is not any
 * more: the order is meant to move, because the thing it describes moves. The
 * pair nearest to touching is the answer to a question that changes tick by
 * tick, and freezing the answer to keep the list calm is answering a different
 * question.
 */
export function byNearest(a: SetupProgress, b: SetupProgress): number {
  // Touched first, and nothing outranks it: that pair is not approaching a
  // trade, it has one.
  const touched = (p: SetupProgress): number => (p.percent >= 100 ? 1 : 0);
  const byTouch = touched(b) - touched(a);
  if (byTouch !== 0) return byTouch;

  // Then distance, when both have one to measure.
  if (a.gap !== undefined && b.gap !== undefined) {
    // The level doubles as the scale: a price above 10 is quoted to two places,
    // so its pip is a hundredth rather than a ten-thousandth.
    const inPips = (p: SetupProgress): number =>
      p.gap! / ((p.level ?? 1) >= 10 ? 0.01 : 0.0001);
    const d = inPips(a) - inPips(b);
    if (d !== 0) return d;
  }

  // A pair with no distance to measure has no setup, and sits below one that
  // has: the percentage carries the stage, so it settles the rest.
  return b.percent - a.percent;
}
