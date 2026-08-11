/**
 * Facts about indicators that cannot be derived by running them.
 *
 * Everything the strategy reference can observe, it observes. This file is for
 * what observation cannot tell you — most importantly, when an indicator
 * produces a perfectly plausible number out of data that does not exist.
 */

/**
 * Indicators whose answer depends on `candle.volume`.
 *
 * **The feed carries no volume.** Pocket Option streams tick PRICES; the
 * scraper builds candles from them (`{t, o, h, l, c}` — check the raw API, the
 * key is simply absent), and the app substitutes a constant so the field is
 * never undefined. So every indicator below is computing over a number that was
 * invented at the edge of the system.
 *
 * They are NOT removed from the registry. Nothing here is wrong with the code —
 * the input is missing. The day the feed carries volume, or the day the app
 * moves to a source that does, all of them start working again on their own.
 *
 * Derived by measurement, not by reading: each indicator was run twice, once
 * with a flat volume and once with a varying one, and listed if the answer
 * moved. An indicator reaching the field through a helper would be invisible to
 * a source scan. `test/volume-meta.test.ts` re-derives this and fails if it
 * drifts.
 */
export const VOLUME_DEPENDENT: ReadonlySet<string> = new Set([
  'cmf',
  'cumulative_volume_delta',
  'cvd',
  'ease_of_movement',
  'elder_force_index',
  'emv',
  'klinger',
  'klinger_oscillator',
  'liquidity_score',
  'mfi',
  'nvi',
  'obv',
  'price_vs_vwap',
  'pvi',
  'pvt',
  'vol_delta',
  'vol_ratio',
  'volume',
  'volume_oscillator',
  'volume_profile',
  'vwap',
  'wyckoff_phase',
]);

/**
 * The ones a flat volume reduces to a CONSTANT. Straightforwardly dead: the
 * rule can never be true, or is always true, whatever the market does.
 */
export const VOLUME_DEAD: ReadonlySet<string> = new Set([
  'nvi',
  'pvi',
  'vol_ratio',
  'volume',
  'volume_oscillator',
]);

/**
 * The ones where volume cancels out of the formula, leaving a valid PRICE
 * indicator wearing the wrong name.
 *
 * `vwap` is Σ(typical × V) / ΣV. Hold V constant and it factors out exactly,
 * leaving the mean typical price — verified identical to 1e-12 on live candles.
 * That is a real moving average; it is simply not a volume-weighted one. The
 * same cancellation applies to `cmf` and `mfi`.
 *
 * Usable, as long as nobody believes the name.
 */
export const VOLUME_DEGRADES_TO_PRICE: ReadonlySet<string> = new Set([
  'cmf',
  'mfi',
  'price_vs_vwap',
  'vwap',
]);

/** The warning the reference and the admin both show. */
export function volumeNote(indicator: string): string | null {
  if (!VOLUME_DEPENDENT.has(indicator)) return null;
  if (VOLUME_DEAD.has(indicator)) {
    return '⚠️ يقرا الحجم، والحجم غير متاح من Pocket Option — القيمة ثابتة ولا تتغير أبداً. لا تستخدمه.';
  }
  if (VOLUME_DEGRADES_TO_PRICE.has(indicator)) {
    return '⚠️ يقرا الحجم، والحجم غير متاح — لكن الحجم الثابت يُختصر من المعادلة فيتحول لمؤشر سعر صالح باسم مضلِّل (vwap مثلاً يساوي متوسط السعر النموذجي بالضبط). يعمل، لكنه ليس ما يوحي به اسمه.';
  }
  return '⚠️ يقرا الحجم، والحجم غير متاح من Pocket Option — الرقم يتحرك لكنه مبني على ثابت مخترع. لا تستخدمه.';
}
