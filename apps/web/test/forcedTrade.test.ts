/**
 * The guaranteed-win account's trades close.
 *
 * ── THE BUG ────────────────────────────────────────────────────────────────
 *
 * A forced trade's card kept counting past its own expiry and never produced a
 * result. The cause was a grid mismatch, and it is arithmetic rather than
 * judgement, so it pins exactly.
 *
 * A trade is settled by finding its own candle:
 *
 *     candles.find(c => c.time === open.entryTime)
 *
 * Candle times arrive from the feed already snapped to the interval — the
 * scraper writes `Math.floor(sec / ivSec) * ivSec` — so on a 5m chart every
 * candle time is a multiple of 300 seconds. The forced path built its entry
 * time with `alignExpiry`, which snaps to a SIXTY-second grid whatever the
 * chart is on. Four presses in five therefore produced an entry time no candle
 * could ever carry, the find returned undefined, and the trade could not be
 * settled by any path at all.
 *
 * `alignExpiry` is not wrong — it is a Dart-parity function and the parity test
 * holds it to Dart's behaviour. It was being asked a question it was never
 * written to answer. `nextCandleWindow` answers that one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { guaranteedWinExit, outcomeFor, type Candle } from '@euro/engine';
import { nextCandleWindow } from '@/lib/tradeWindow';

const ENGINE_SRC = readFileSync(
  fileURLToPath(new URL('../lib/useSignalEngine.ts', import.meta.url)),
  'utf8',
);

const MIN = 60_000;
const FIVE = 5 * MIN;

/** What `alignExpiry` did, reproduced so the two grids can be compared. */
function oldAligned(nowMs: number, minutes: number): { entryTime: number; expiryTime: number } {
  const sec = Math.trunc(nowMs / 1000);
  const start = Math.trunc(sec / 60) * 60;
  return { entryTime: start * 1000, expiryTime: (start + minutes * 60) * 1000 };
}

/** The feed's own grid: every candle time is a multiple of the interval. */
function feed(fromMs: number, count: number, tf: number): Candle[] {
  const first = Math.floor(fromMs / tf) * tf;
  return Array.from({ length: count }, (_, i) => ({
    open: 1.1,
    high: 1.2,
    low: 1.0,
    close: 1.15,
    volume: 1000,
    time: first + i * tf,
  }));
}

/** The two questions `reconcileOpenTrade` asks, in the order it asks them. */
const barFor = (candles: readonly Candle[], entryTime: number): Candle | undefined =>
  candles.find((c) => c.time === entryTime);
const isFinished = (candles: readonly Candle[], entryTime: number): boolean =>
  candles.some((c) => c.time > entryTime);

describe('the grid a forced trade lands on', () => {
  it('put the entry where no 5m candle could ever be — the bug', () => {
    // 12:03:20 — a perfectly ordinary moment to press the button.
    const now = Date.UTC(2026, 7, 20, 12, 3, 20);
    const candles = feed(now - 20 * FIVE, 30, FIVE);

    const old = oldAligned(now, 5);
    expect(new Date(old.entryTime).toISOString()).toBe('2026-08-20T12:03:00.000Z');
    // 12:03 is not on the five-minute grid, so the trade's candle does not exist.
    expect(barFor(candles, old.entryTime)).toBeUndefined();
  });

  it('lands on a real candle now, on both timeframes', () => {
    for (const [tf, label] of [
      [MIN, '2026-08-20T12:04:00.000Z'],
      [FIVE, '2026-08-20T12:05:00.000Z'],
    ] as const) {
      const now = Date.UTC(2026, 7, 20, 12, 3, 20);
      const w = nextCandleWindow(now, tf);
      expect(new Date(w.entryTime).toISOString()).toBe(label);
      expect(w.expiryTime - w.entryTime).toBe(tf);

      // Once the feed has produced that candle and one after it, the trade is
      // findable and finished — which is all settlement needs.
      const candles = feed(now - 20 * tf, 30, tf);
      const withTrade = [...candles, { ...candles[0]!, time: w.entryTime }, { ...candles[0]!, time: w.expiryTime }];
      expect(barFor(withTrade, w.entryTime)).toBeDefined();
      expect(isFinished(withTrade, w.entryTime)).toBe(true);
    }
  });

  it('never hands back a window that has already started', () => {
    // Snapping BACK was the other half of the mistake: it gave the trade a
    // candle that was already part-way through when the button was pressed.
    for (const offset of [0, 1, 20_000, 59_999, 299_999]) {
      const now = Date.UTC(2026, 7, 20, 12, 0, 0) + offset;
      for (const tf of [MIN, FIVE]) {
        expect(nextCandleWindow(now, tf).entryTime).toBeGreaterThan(now);
      }
    }
  });

  it('is always on the timeframe grid, so the find can never miss', () => {
    for (const tf of [MIN, FIVE]) {
      for (let s = 0; s < 600; s += 7) {
        const w = nextCandleWindow(Date.UTC(2026, 7, 20, 12, 0, 0) + s * 1000, tf);
        expect(w.entryTime % tf).toBe(0);
        expect(w.expiryTime % tf).toBe(0);
      }
    }
  });

  it('gives a full candle of trade, not whatever was left of one', () => {
    // Pressed 59 seconds into a minute: the old window was one second long.
    const now = Date.UTC(2026, 7, 20, 12, 0, 59);
    expect(oldAligned(now, 1).expiryTime - now).toBe(1000);
    const w = nextCandleWindow(now, MIN);
    expect(w.expiryTime - w.entryTime).toBe(MIN);
  });

  it('falls back to a minute rather than a zero-length trade', () => {
    const now = Date.UTC(2026, 7, 20, 12, 0, 30);
    const w = nextCandleWindow(now, 0);
    expect(w.expiryTime - w.entryTime).toBe(MIN);
    expect(w.entryTime).toBeGreaterThan(now);
  });
});

/**
 * The tests above prove `nextCandleWindow` is right. These prove the engine
 * actually uses it — which is the half that broke. Reading the source is
 * blunter than calling the hook, and it is what a Node test can honestly
 * assert about a file whose every export needs React and a live feed.
 */
describe('what the engine is wired to', () => {
  it('no longer times a trade with the one-minute Dart helper', () => {
    // Calls and the import, not the word: the comment explaining why the
    // helper was dropped names it, and that comment is the point.
    expect(ENGINE_SRC).not.toContain('alignExpiry(');
    expect(ENGINE_SRC).not.toMatch(/^\s*alignExpiry,\s*$/m);
  });

  it('builds both forced windows from the timeframe', () => {
    // The button's path and the throw-fallback beside it. Two call sites, and
    // the fallback is the one that would be missed.
    const uses = ENGINE_SRC.match(/nextCandleWindow\(Date\.now\(\), candleMs\)/g) ?? [];
    expect(uses.length).toBe(2);
    expect(ENGINE_SRC).toContain('timeframeSeconds(a.timeframe) * 1000');
    expect(ENGINE_SRC).toContain('timeframeSeconds(argsRef.current.timeframe) * 1000');
  });

  it('settles a forced win through guaranteedWinExit, not the raw close', () => {
    expect(ENGINE_SRC).toContain(
      "settleTo(open, 'WIN', bar.open, guaranteedWinExit(open.direction, bar.open, bar.close))",
    );
  });

  it('reconciles open trades that are not on the chart', () => {
    // Without this sweep a forced trade on any pair the user navigated away
    // from is never looked at again, on any timer, for the whole session.
    expect(ENGINE_SRC).toContain('fetchCandlesBulk(strays, args.timeframe)');
  });
});

describe('the close a forced win is shown with', () => {
  // The real candle from the settlement bug: a CALL taken at the open loses.
  const entry = 1.17391;
  const realClose = 1.1723;

  it('used to contradict itself', () => {
    // What the card did: status WIN, price from a candle that fell.
    expect(outcomeFor('CALL', entry, realClose)).toBe('LOSS');
  });

  it('now shows a close that agrees with the verdict', () => {
    const shown = guaranteedWinExit('CALL', entry, realClose, () => 0.5);
    expect(outcomeFor('CALL', entry, shown)).toBe('WIN');
    // And barely moved: a fraction of a percent, not a different market.
    expect(Math.abs(shown - entry) / entry).toBeLessThan(0.0002);
  });

  it('keeps the true close whenever the true close already wins', () => {
    const winning = 1.17502;
    expect(guaranteedWinExit('CALL', entry, winning, () => 0.5)).toBe(winning);
    expect(guaranteedWinExit('PUT', entry, 1.1723, () => 0.5)).toBe(1.1723);
  });

  it('holds for both directions on a losing candle', () => {
    for (const [dir, close] of [['CALL', 1.1723], ['PUT', 1.17502]] as const) {
      const shown = guaranteedWinExit(dir, entry, close, () => 0.5);
      expect(outcomeFor(dir, entry, shown)).toBe('WIN');
    }
  });

  it('wins even on a candle that closed exactly at the entry', () => {
    // The tie band is the trap here: a margin smaller than `tieEpsilon` would
    // read as TIE, not WIN.
    for (const dir of ['CALL', 'PUT'] as const) {
      for (const r of [0, 0.5, 0.999]) {
        expect(outcomeFor(dir, entry, guaranteedWinExit(dir, entry, entry, () => r))).toBe('WIN');
      }
    }
  });
});
