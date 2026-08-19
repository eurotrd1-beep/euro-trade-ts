/**
 * A trade is judged on its candle's CLOSE, and not before the candle has one.
 *
 * The bug this pins, with the numbers it was found with. AUD/NZD OTC, 16:24
 * UTC on 2026-08-19:
 *
 *   the candle   open 1.17391 · high 1.17470 · low 1.17207 · close 1.17230
 *   the trade    PUT, taken at the open
 *   the truth    price fell from 1.17391 to 1.17230 — a WIN
 *   the card     settled against 1.17420 and recorded a LOSS
 *
 * 1.17420 is not the close of that candle or of any other. It is a price from
 * partway up the run to the high — the last tick the buffer held at the moment
 * the countdown reached zero. The card asked the CLOCK whether the minute was
 * over, which it was, and took the still-forming candle's `close` as final.
 *
 * The generator, reading the finished candle, recorded the win. So the same
 * trade had two verdicts and the wrong one was the one the user saw.
 *
 * The rule that fixes it: a candle is finished when a LATER one exists. Nothing
 * else is evidence — not the clock, not the candle being present in the buffer.
 */

import { describe, expect, it } from 'vitest';
import { outcomeFor, type Candle } from '@euro/engine';

const MIN = 60_000;
const T = Date.parse('2026-08-19T16:24:00.000Z');

const c = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  open,
  high,
  low,
  close,
  volume: 1000,
  time,
});

/** The real candle, and the one before it, from the feed. */
const FINISHED = c(T, 1.17391, 1.1747, 1.17207, 1.1723);
/** The same candle mid-flight, as the buffer held it when the clock ran out. */
const FORMING = c(T, 1.17391, 1.1742, 1.17375, 1.1742);
const NEXT = c(T + MIN, 1.17236, 1.17386, 1.17226, 1.17315);

/** The rule, as `reconcileOpenTrade` applies it. */
const isFinished = (candles: readonly Candle[], entryTime: number): boolean =>
  candles.some((x) => x.time > entryTime);

describe('the candle the trade is settled on', () => {
  it('is not finished just because the clock says the minute is over', () => {
    // The buffer holds the trade's candle and nothing after it. The minute has
    // elapsed; the candle has not been written.
    expect(isFinished([FORMING], T)).toBe(false);
  });

  it('is finished once the feed has moved on to the next one', () => {
    expect(isFinished([FINISHED, NEXT], T)).toBe(true);
  });

  it('would have flipped this trade if judged early', () => {
    // The two answers, side by side. This is the whole bug in two lines.
    expect(outcomeFor('PUT', FORMING.open, FORMING.close)).toBe('LOSS');
    expect(outcomeFor('PUT', FINISHED.open, FINISHED.close)).toBe('WIN');
  });

  it('agrees with the generator once it waits', () => {
    // What the generator recorded for this trade, from the finished candle.
    expect(outcomeFor('PUT', 1.17391, 1.1723)).toBe('WIN');
    expect(outcomeFor('PUT', FINISHED.open, FINISHED.close)).toBe('WIN');
  });

  it('settles on the close, never on the high the candle passed through', () => {
    // 1.17420 sits inside the candle's range and is not its close. No price
    // between the open and the close may decide the verdict.
    expect(FORMING.close).toBeGreaterThan(FINISHED.low);
    expect(FORMING.close).toBeLessThan(FINISHED.high);
    expect(FORMING.close).not.toBe(FINISHED.close);
  });

  it('holds for a CALL the same way', () => {
    // The mirror: a candle that dips before closing up would have been read as
    // a loss on the same mistake.
    const dipped = c(T, 1.1, 1.105, 1.09, 1.104);
    const midDip = c(T, 1.1, 1.101, 1.09, 1.0905);
    expect(outcomeFor('CALL', midDip.open, midDip.close)).toBe('LOSS');
    expect(outcomeFor('CALL', dipped.open, dipped.close)).toBe('WIN');
  });
});
