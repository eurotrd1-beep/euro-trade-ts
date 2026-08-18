/**
 * The analysis sequence the signal button runs — ported from
 * `requestNextSignal` (signal_engine.dart:2301).
 *
 * Stages 400 ms apart, then it WAITS for the current candle to close so the
 * trade opens with the next one. That wait is the whole point of the button.
 *
 * -- WHAT THESE LINES USED TO SAY -------------------------------------------
 *
 * Twelve stages narrating RSI, Stochastic, CCI, ATR, ADX, MFI, VWAP, CMF and
 * volume delta, finishing on "the final confluence of 18 technical
 * indicators". The docstring defended them: not decoration, live values, proof
 * the analysis is reading your pair.
 *
 * That stopped being true when the rule strategies went. The engine runs one
 * program now and it reads one thing — whether price returned to the 0.236
 * retracement of the last confirmed swing. None of those nine numbers reaches
 * the decision.
 *
 * Four of them were worse than irrelevant. MFI, CMF, VWAP and volume delta
 * read `candle.volume`, and Pocket Option sends no volume: `candles.ts`
 * substitutes a flat `SYNTHETIC_VOLUME = 1000`. Run CMF and volume delta over
 * any four unrelated price series and they return 0.3750 and 37.500 every
 * time, because a constant input has a constant output. The app was printing
 * two fixed numbers to every user on every pair, formatted to three decimals,
 * under a heading that said real analysis.
 *
 * So the lines now describe the strategy that actually runs, and every number
 * in them is computed from the swing the trade is placed on. There are fewer
 * of them, because there are fewer true things to say.
 */

import { detectSwing, supportResistance } from '@euro/engine';
import { formatPrice, tr } from '@euro/shared';
import type { Candle } from '@euro/engine';

/** Dart: `await Future.delayed(const Duration(milliseconds: 400))` per stage. */
export const STAGE_DELAY_MS = 400;

/** Dart polls the candle-close countdown every 100 ms. */
export const WAIT_TICK_MS = 100;

/** The one level the strategy watches. Must match `FIB` in `programs/fib236.ts`. */
const FIB = 0.236;

export interface StageInput {
  candles: readonly Candle[];
  currentPrice: number;
  pair: string;
}

/** A price gap in pips, at the pair's own scale. */
function pips(distance: number, price: number): string {
  const pip = price >= 10 ? 0.01 : 0.0001; // JPY-scale pairs quote two places
  return (distance / pip).toFixed(1);
}

/**
 * Builds the stage messages up front. The values do not change during the
 * sequence — the candle buffer is fixed the moment the button is pressed — so
 * computing them once shows the user the same numbers the wait began with.
 */
export function buildStages({ candles, currentPrice, pair }: StageInput): string[] {
  const name = pair.replace(' (OTC)', '');
  const sr = supportResistance(candles, currentPrice);
  const swing = detectSwing(candles);

  const stages: string[] = [
    tr(
      `\u{1F4CA} قراءة شموع الدقيقة لـ ${name} | ${candles.length} شمعة مقفولة...`,
      `\u{1F4CA} Reading 1-minute candles for ${name} | ${candles.length} closed candles...`,
    ),
    tr(
      '\u{1F50D} تحديد القمم والقيعان المؤكدة — كل قمة محتاجة شمعتين على كل جنب تأكّدها...',
      '\u{1F50D} Locating confirmed pivots — each needs two candles either side to confirm it...',
    ),
  ];

  if (swing === null) {
    // Not a failure and not a blank: no confirmed swing means there is nothing
    // to draw a retracement on, and the honest thing is to say so rather than
    // fill the gap with a number.
    stages.push(
      tr(
        '\u{1F4CF} مفيش سوينج مؤكد في آخر 100 شمعة — مفيش مستوى نرسمه دلوقتي...',
        '\u{1F4CF} No confirmed swing in the last 100 candles — nothing to draw a level on yet...',
      ),
      tr(
        `\u{1F6E1} الدعم ${formatPrice(sr.support)} | المقاومة ${formatPrice(sr.resistance)}...`,
        `\u{1F6E1} Support ${formatPrice(sr.support)} | Resistance ${formatPrice(sr.resistance)}...`,
      ),
      tr(
        '\u{23F3} الاستراتيجية هتفضل تقرا كل شمعة جديدة لحد ما يتكوّن سوينج...',
        '\u{23F3} The strategy keeps reading each new candle until a swing forms...',
      ),
    );
    return stages;
  }

  // Same arithmetic as `fib236.ts`: the level sits 23.6% of the way back from
  // the end of the leg towards where it started.
  const origin = swing.up ? swing.low : swing.high;
  const end = swing.up ? swing.high : swing.low;
  const level = end + FIB * (origin - end);
  const direction = swing.up ? 'CALL' : 'PUT';
  const away = Math.abs(currentPrice - level);

  stages.push(
    tr(
      `\u{1F4C9} السوينج المؤكد: من ${formatPrice(origin)} لـ ${formatPrice(end)} | المدى ${pips(swing.range, currentPrice)} نقطة...`,
      `\u{1F4C9} Confirmed swing: ${formatPrice(origin)} to ${formatPrice(end)} | range ${pips(swing.range, currentPrice)} pips...`,
    ),
    tr(
      `\u{1F4CF} رسم فيبوناتشي على الساق دي | مستوى 0.236 عند ${formatPrice(level)}...`,
      `\u{1F4CF} Drawing Fibonacci on that leg | the 0.236 level sits at ${formatPrice(level)}...`,
    ),
    tr(
      `\u{1F4CD} السعر دلوقتي ${formatPrice(currentPrice)} — على بعد ${pips(away, currentPrice)} نقطة من المستوى...`,
      `\u{1F4CD} Price is ${formatPrice(currentPrice)} — ${pips(away, currentPrice)} pips from the level...`,
    ),
    tr(
      `\u{1F9ED} اتجاه الساق ${swing.up ? 'صاعد' : 'هابط'}، يعني الصفقة ${direction} لو حصل لمس...`,
      `\u{1F9ED} The leg is ${swing.up ? 'upward' : 'downward'}, so a touch means ${direction}...`,
    ),
    tr(
      `\u{1F6E1} الدعم ${formatPrice(sr.support)} | المقاومة ${formatPrice(sr.resistance)}...`,
      `\u{1F6E1} Support ${formatPrice(sr.support)} | Resistance ${formatPrice(sr.resistance)}...`,
    ),
    tr(
      '\u{1F512} استبعاد الشمعة اللي عملت القمة نفسها من اللمس، وإلغاء المستوى لو السعر كسره...',
      '\u{1F512} Excluding the candle that made the peak from counting as a touch, and dropping the level if price breaks it...',
    ),
    tr(
      '\u{1F3C1} فرصة تعويض واحدة محجوزة لو الصفقة الأولى خسرت — واحدة بس...',
      '\u{1F3C1} One recovery trade held in reserve if the first loses — one only...',
    ),
  );

  return stages;
}

/** The countdown line shown while waiting for the candle to close. */
export function waitingText(secondsLeft: number): string {
  return tr(
    `بانتظار إغلاق الشمعة الحالية لفتح صفقة مع الشمعة القادمة: ${secondsLeft} ثانية...`,
    `Waiting for the current candle to close to open a trade with the next candle: ${secondsLeft}s...`,
  );
}

/** Dart: `_isForexPairType()` — OTC pairs trade 24/7 and are never "weekend closed". */
export function isForexPair(pairSymbol: string): boolean {
  return !pairSymbol.toUpperCase().includes('OTC');
}

export function isWeekend(now: Date = new Date()): boolean {
  const d = now.getDay();
  return d === 6 || d === 0; // Saturday or Sunday
}
