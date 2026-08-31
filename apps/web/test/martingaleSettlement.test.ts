/**
 * A loss that owes a martingale is recorded as a loss.
 *
 * ── THE BUG ────────────────────────────────────────────────────────────────
 *
 * The losing trade stayed marked ACTIVE — "still running" — for ever. The
 * martingale opened, ran, closed, and the trade before it was still on screen
 * as open, still open in localStorage, and still open in the copy pushed to the
 * server. Nothing ever looked at it again.
 *
 * It is not a settlement bug. The engine settled it correctly and `settleTo`
 * wrote the settled row. It is a write-ordering bug: on the candle that ends a
 * losing trade, `applyEvent` does two things in ONE synchronous block —
 *
 *     settleTo(losingTrade, 'LOSS', …)   // writes the settled row
 *     recordOpen(martingale)             // writes the new row
 *
 * — and both used to build their new list the same way:
 *
 *     mergeHistories([row], stateRef.current.history)
 *
 * `stateRef` is assigned during render. React does not render between those
 * two calls, so the second one read the list as it was BEFORE the first. It
 * merged the martingale into a list that still held the losing trade as ACTIVE,
 * and wrote that over the settled version. Last write wins, and the last write
 * was the stale one.
 *
 * `mergeHistories` cannot save it either, and the reason is worth stating:
 * merging prefers a settled row over the same row still open — but only when
 * the SAME row appears twice. Here it appears once, ACTIVE, in the stale list.
 * There is nothing for it to win against.
 *
 * The fix is one owner: `historyRef`, updated synchronously on every write, so
 * two writes in one tick compose instead of race.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TradingSignal } from '@euro/engine';
import { mergeHistories } from '@/lib/signalHistoryStore';

const ENGINE_SRC = readFileSync(
  fileURLToPath(new URL('../lib/useSignalEngine.ts', import.meta.url)),
  'utf8',
);

const MIN = 60_000;
const T = Date.parse('2026-08-31T12:00:00.000Z');

function trade(p: Partial<TradingSignal> & Pick<TradingSignal, 'entryTime' | 'status'>): TradingSignal {
  return {
    pair: 'EUR/USD OTC',
    symbol: 'EURUSD_otc',
    direction: 'CALL',
    durationMinutes: 1,
    entryPrice: 1.1,
    currentPrice: 1.1,
    confidence: 95,
    expiryTime: p.entryTime + MIN,
    exitPrice: null,
    candlesSnapshot: null,
    marketCondition: '',
    recommendation: '',
    origin: 'monitoring',
    ...p,
  };
}

/** The trade that loses, before and after the candle that ends it. */
const PRIMARY_OPEN = trade({ entryTime: T, status: 'ACTIVE', stage: 'primary' });
const PRIMARY_LOST = trade({ entryTime: T, status: 'LOSS', stage: 'primary', exitPrice: 1.09 });
/** The recovery trade, opened on the same candle close that ended the first. */
const MARTINGALE = trade({ entryTime: T + MIN, status: 'ACTIVE', stage: 'martingale' });

const rowAt = (h: readonly TradingSignal[], entryTime: number): TradingSignal | undefined =>
  h.find((s) => s.entryTime === entryTime);

describe('two history writes on one candle close', () => {
  const before: TradingSignal[] = [PRIMARY_OPEN];

  it('lost the settlement when both writers read the same stale list', () => {
    // Exactly what the two calls did, in order, with React not rendering
    // between them — so both see `before`.
    const fromSettle = mergeHistories([PRIMARY_LOST], before);
    const fromRecord = mergeHistories([MARTINGALE], before);

    // The first write was right.
    expect(rowAt(fromSettle, T)?.status).toBe('LOSS');
    // The second one, which lands last and wins, has the trade still running.
    expect(rowAt(fromRecord, T)?.status).toBe('ACTIVE');
    expect(rowAt(fromRecord, T + MIN)?.status).toBe('ACTIVE');
  });

  it('composes when the second write builds on the first', () => {
    let ref: readonly TradingSignal[] = before;
    ref = mergeHistories([PRIMARY_LOST], ref);
    ref = mergeHistories([MARTINGALE], ref);

    expect(rowAt(ref, T)?.status).toBe('LOSS');
    expect(rowAt(ref, T + MIN)?.status).toBe('ACTIVE');
    // And the loss carries its close, not a null left over from the open row.
    expect(rowAt(ref, T)?.exitPrice).toBe(1.09);
  });

  it('leaves exactly one row per trade, however many times it is written', () => {
    let ref: readonly TradingSignal[] = before;
    for (const rows of [[PRIMARY_LOST], [MARTINGALE], [PRIMARY_LOST], [MARTINGALE]]) {
      ref = mergeHistories(rows, ref);
    }
    expect(ref.filter((s) => s.entryTime === T)).toHaveLength(1);
    expect(ref.filter((s) => s.entryTime === T + MIN)).toHaveLength(1);
  });

  it('still refuses to let a stale open row overwrite a settled one', () => {
    // The guard that already existed, and which the ordering fix must not
    // weaken: another device's ACTIVE copy loses to this device's outcome.
    const ref = mergeHistories([PRIMARY_OPEN], mergeHistories([PRIMARY_LOST], before));
    expect(rowAt(ref, T)?.status).toBe('LOSS');
  });

  it('settles the whole cycle, not just the last trade', () => {
    // Loss → martingale → win, as it plays out over two candle closes.
    let ref: readonly TradingSignal[] = [];
    ref = mergeHistories([PRIMARY_OPEN], ref);
    // candle 1 closes: the primary loses and the martingale opens.
    ref = mergeHistories([PRIMARY_LOST], ref);
    ref = mergeHistories([MARTINGALE], ref);
    // candle 2 closes: the martingale wins.
    ref = mergeHistories([{ ...MARTINGALE, status: 'WIN' as const, exitPrice: 1.11 }], ref);

    expect(ref.map((s) => s.status)).toEqual(['WIN', 'LOSS']);
    expect(ref.some((s) => s.status === 'ACTIVE')).toBe(false);
  });
});

/**
 * The composition above is only worth anything if the engine actually writes
 * that way. These pin the wiring, which is the half that broke.
 */
describe('what the engine writes through', () => {
  it('has one history writer, not two', () => {
    // No write path may build its list from the render's copy any more.
    expect(ENGINE_SRC).not.toContain('mergeHistories([settled], stateRef.current.history)');
    expect(ENGINE_SRC).not.toContain('mergeHistories([signal], stateRef.current.history)');
    expect(ENGINE_SRC).not.toContain('mergeHistories([stale], stateRef.current.history)');
  });

  it('composes every write on the synchronous ref', () => {
    expect(ENGINE_SRC).toContain('mergeHistories(rows, historyRef.current)');
  });

  it('routes the settlement and the martingale through it', () => {
    expect(ENGINE_SRC).toContain('commitHistory([settled])');
    expect(ENGINE_SRC).toContain('commitHistory([signal])');
    // Both stranded-trade paths too — they write a row like any other.
    expect((ENGINE_SRC.match(/commitHistory\(\[stale\]\)/g) ?? []).length).toBe(2);
  });

  it('looks for the settle target in the ref, not a render behind', () => {
    expect(ENGINE_SRC).toContain('historyRef.current.find(');
  });

  it('coalesces the durable push instead of racing two of them', () => {
    expect(ENGINE_SRC).toContain('pushRemoteHistory(account, historyRef.current)');
    expect((ENGINE_SRC.match(/void pushRemoteHistory\(/g) ?? []).length).toBe(1);
  });
});
