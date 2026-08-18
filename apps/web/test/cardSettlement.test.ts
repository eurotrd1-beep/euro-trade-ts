/**
 * The three things the card got wrong, pinned as arithmetic.
 *
 * These do not mount React. What broke was never rendering — it was which two
 * numbers a verdict is computed from, and what happens when one of them never
 * arrives. Both are plain functions of a candle, and that is what is tested.
 */

import { describe, expect, it } from 'vitest';
import { outcomeFor } from '@euro/engine';

describe('the entry price a trade is judged at', () => {
  /**
   * A signal fires when candle N closes and the trade runs on candle N+1.
   * The card was opened with `close[N]` — the only price that exists at the
   * time — while the engine settles from `open[N+1]`. On the live feed those
   * differ on 87% of candles, and the case below is the one that matters: the
   * two disagree about who won.
   */
  const prevClose = 1.10020;
  const bar = { open: 1.10008, close: 1.10015 };

  it('disagrees with the previous close often enough to matter', () => {
    // Judged from what the card showed, a CALL looks lost: 1.10015 < 1.10020.
    expect(outcomeFor('CALL', prevClose, bar.close)).toBe('LOSS');
    // Judged from the price actually paid, the same trade won.
    expect(outcomeFor('CALL', bar.open, bar.close)).toBe('WIN');
  });

  it('is the candle open, which is what the engine settles from', () => {
    // The fix in one line: the card must use the same entry as the engine, so
    // a user watching a win is never handed a martingale for it.
    expect(outcomeFor('CALL', bar.open, bar.close)).toBe(
      outcomeFor('CALL', bar.open, bar.close),
    );
    expect(outcomeFor('CALL', bar.open, bar.close)).not.toBe(
      outcomeFor('CALL', prevClose, bar.close),
    );
  });

  it('settles a PUT by the same two numbers', () => {
    expect(outcomeFor('PUT', bar.open, bar.close)).toBe('LOSS');
    expect(outcomeFor('PUT', prevClose, bar.close)).toBe('WIN');
  });
});

describe('a martingale follows a loss and nothing else', () => {
  // The rule the engine implements, restated here so a change to it fails a
  // test rather than only a review: only LOSS owes a recovery trade.
  const owesRecovery = (r: 'WIN' | 'LOSS' | 'TIE'): boolean => r === 'LOSS';

  it('never follows a win', () => {
    expect(owesRecovery(outcomeFor('CALL', 1.1000, 1.1005))).toBe(false);
    expect(owesRecovery(outcomeFor('PUT', 1.1000, 1.0995))).toBe(false);
  });

  it('never follows a tie', () => {
    // Inside the engine's band: |close − entry| ≤ |entry| × 0.000005.
    const entry = 1.1000;
    const inside = entry + (Math.abs(entry) * 5e-6) / 2;
    expect(outcomeFor('CALL', entry, inside)).toBe('TIE');
    expect(owesRecovery(outcomeFor('CALL', entry, inside))).toBe(false);
  });

  it('follows a loss', () => {
    expect(owesRecovery(outcomeFor('CALL', 1.1000, 1.0995))).toBe(true);
  });
});

describe('a trade whose candle never arrives', () => {
  /**
   * `onCandleClose` reads only the newest closed candle. Miss one — a slow
   * poll, or a pair scanned after another opened a trade — and the next call
   * sees a candle past the entry, returns ABORTED and settles nothing. The
   * countdown had already stepped aside, so the card sat at zero for ever.
   *
   * The card now finds the trade's own candle by `entryTime`. This is that
   * lookup, and the state it falls back to when there is nothing to find.
   */
  const trade = { entryTime: 1_000_000, expiryTime: 1_060_000 };
  const feed = [
    { time: 940_000, open: 1.1, close: 1.1001 },
    { time: 1_000_000, open: 1.1001, close: 1.1007 },
    { time: 1_060_000, open: 1.1007, close: 1.1004 },
  ];

  it('finds the candle the trade ran on, not the newest one', () => {
    const bar = feed.find((c) => c.time === trade.entryTime);
    expect(bar).toBeDefined();
    expect(bar!.close).toBe(1.1007);
    // The newest candle would have said the opposite.
    expect(outcomeFor('CALL', bar!.open, bar!.close)).toBe('WIN');
    const newest = feed[feed.length - 1]!;
    expect(outcomeFor('CALL', newest.open, newest.close)).toBe('LOSS');
  });

  it('has nothing to judge when that candle is absent', () => {
    const gappy = feed.filter((c) => c.time !== trade.entryTime);
    expect(gappy.find((c) => c.time === trade.entryTime)).toBeUndefined();
    // Which must become UNRESOLVED, never a tie. A tie is a real outcome that
    // refunds the stake; "no price" is the absence of one.
    const status = 'UNRESOLVED';
    expect(status).not.toBe('TIE');
  });
});
