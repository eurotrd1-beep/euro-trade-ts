/**
 * Facts about indicators that cannot be derived by running them.
 *
 * ── EMPTY, ON PURPOSE ──────────────────────────────────────────────────────
 *
 * This file carried three sets naming 22 indicators that read `candle.volume`,
 * which the Pocket Option feed does not carry: the scraper builds candles from
 * tick PRICES and the app substitutes a flat 1000, so every one of them was
 * computing over a number invented at the edge of the system. Some were dead
 * (a constant input makes a constant output), some quietly degraded into a
 * price indicator wearing a volume name.
 *
 * Not one of those 22 is registered any more — the registry answers to the
 * Fibonacci family and the two support/resistance readings, and none of them
 * touches volume. So the sets are empty rather than deleted: `volumeNote` is
 * still called by the reference builder and the strategy checker, and it still
 * has to be true. The day an indicator that reads volume comes back, its name
 * goes in the set below and both callers start warning again on their own.
 */

/** Indicators whose answer depends on `candle.volume`. */
export const VOLUME_DEPENDENT: ReadonlySet<string> = new Set<string>();

/** The ones a flat volume reduces to a CONSTANT — the rule can never move. */
export const VOLUME_DEAD: ReadonlySet<string> = new Set<string>();

/**
 * The ones where volume cancels out of the formula, leaving a valid PRICE
 * indicator wearing the wrong name — `vwap` with a constant V is exactly the
 * mean typical price. Usable, as long as nobody believes the name.
 */
export const VOLUME_DEGRADES_TO_PRICE: ReadonlySet<string> = new Set<string>();

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
