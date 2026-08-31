/**
 * The candle a trade runs on, expressed as a window.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `alignExpiry` ──────────────────────────
 *
 * `alignExpiry` in the engine is a Dart-parity function and has to stay one:
 * it snaps BACK to the start of the current candle and it hard-codes a
 * one-minute grid, because that is what `signal_engine.dart` did. Both of those
 * are wrong for placing a trade here, and on a 5m chart the second one is
 * actively broken.
 *
 * A trade is settled by finding its own candle: `candles.find(c => c.time ===
 * entryTime)`. Candle times come off the feed already snapped to the interval —
 * `Math.floor(sec / ivSec) * ivSec` in the scraper — so on 5m they are
 * multiples of 300 seconds. An entry time snapped to a 60-second grid matches
 * one of those only when the minute happens to land on a five-minute boundary,
 * which is one press in five. The other four never find a candle at all, and a
 * trade whose candle cannot be found cannot be settled: the card sits at zero
 * until the stranded-trade timeout gives up on it.
 *
 * So the rule here is the one the strategy already follows: a signal decided
 * now is a trade on the NEXT candle, and it ends when that candle closes. Entry
 * and expiry are both on the feed's own grid by construction, which is what
 * makes the trade findable and therefore settleable.
 *
 * Snapping forward rather than back matters as much as the grid. Snapping back
 * hands the trade a candle that was already part-way through when it was
 * placed — the trade would be judged partly on price movement that happened
 * before it existed, and its real length would be whatever was left of the
 * candle rather than the length shown on the card.
 */
export interface TradeWindow {
  /** Start of the candle the trade runs on. Always on the timeframe's grid. */
  entryTime: number;
  /** That same candle's close. */
  expiryTime: number;
}

/**
 * The next candle after `nowMs`, on a grid of `timeframeMs`.
 *
 * A non-positive timeframe falls back to one minute rather than throwing or
 * returning a zero-length window: the caller is placing a trade, and a trade
 * that expires at the instant it opens is worse than one on the wrong grid.
 */
export function nextCandleWindow(nowMs: number, timeframeMs: number): TradeWindow {
  const tf = timeframeMs > 0 ? timeframeMs : 60_000;
  const entryTime = Math.floor(nowMs / tf) * tf + tf;
  return { entryTime, expiryTime: entryTime + tf };
}
