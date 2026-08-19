/**
 * The rules the manual-publishing screen decides by.
 *
 * Everything here is a pure function over a queue row, and each one exists
 * because of a way the screen could publish the wrong thing:
 *
 *   • a signal whose trade has already closed — a call nobody can act on
 *   • the result of an opening that was rejected — a win or loss announced
 *     for a trade the channel was never shown
 *
 * The database enforces neither. RLS stops a decided row being re-decided; it
 * has no idea what a five-minute trade is, or that `result:X` belongs to
 * `signal:X`. That knowledge lives in these three functions, so they are the
 * ones pinned.
 */

import { describe, expect, it } from 'vitest';
import {
  arabicAge,
  arabicRemaining,
  isExpired,
  orphanedResult,
  type TelegramQueueRow,
} from '../lib/telegramQueue';

const NOW = Date.parse('2026-08-19T12:00:00Z');
const MIN = 60_000;

function row(over: Partial<TelegramQueueRow> = {}): TelegramQueueRow {
  return {
    event_key: 'signal:EURUSD:1755600000000:0',
    kind: 'signal',
    symbol: 'EURUSD',
    depth_bps: 3.5,
    body: 'رسالة',
    status: 'pending',
    expires_at: null,
    created_at: new Date(NOW - 2 * MIN).toISOString(),
    decided_at: null,
    ...over,
  };
}

describe('expiry', () => {
  it('holds a message with no expiry open for ever — a result does not go stale', () => {
    expect(isExpired(row({ kind: 'result', expires_at: null }), NOW)).toBe(false);
  });

  it('closes a signal the moment its trade does, not a minute after', () => {
    const at = new Date(NOW).toISOString();
    expect(isExpired(row({ expires_at: at }), NOW)).toBe(true);
    expect(isExpired(row({ expires_at: at }), NOW - 1)).toBe(false);
  });

  /**
   * The page renders once before the browser has a clock (`now = 0`), and a row
   * that reads "expired" in that first paint would show every waiting signal
   * as missed. `expires_at` is always in the future relative to the epoch, so
   * the comparison holds — this pins that it stays that way.
   */
  it('does not call anything expired before the clock is read', () => {
    expect(isExpired(row({ expires_at: new Date(NOW).toISOString() }), 0)).toBe(false);
  });
});

describe('the result of a rejected opening', () => {
  const suffix = 'EURUSD:1755600000000:0';
  const result = row({ event_key: `result:${suffix}`, kind: 'result' });

  it('is flagged when its opening was rejected', () => {
    const opening = row({ event_key: `signal:${suffix}`, status: 'rejected' });
    expect(orphanedResult(result, [result, opening])).toBe(true);
  });

  it('is not flagged when its opening was published', () => {
    const opening = row({ event_key: `signal:${suffix}`, status: 'sent' });
    expect(orphanedResult(result, [result, opening])).toBe(false);
  });

  /**
   * Nothing to compare against is not the same as a rejection. In auto-then-
   * manual switching, or after the seven-day prune, the opening may simply not
   * be in the queue — and a warning that cries wolf on every such result would
   * be ignored on the one that matters.
   */
  it('is not flagged when the opening is not in the queue at all', () => {
    expect(orphanedResult(result, [result])).toBe(false);
  });

  it('does not confuse another pair, or the same pair on another candle', () => {
    const other = row({ event_key: 'signal:GBPUSD:1755600000000:0', status: 'rejected' });
    const earlier = row({ event_key: 'signal:EURUSD:1755599700000:0', status: 'rejected' });
    expect(orphanedResult(result, [result, other, earlier])).toBe(false);
  });

  it('says nothing about an opening — only a result can be orphaned', () => {
    const opening = row({ event_key: `signal:${suffix}`, status: 'rejected' });
    expect(orphanedResult(opening, [opening])).toBe(false);
  });
});

describe('arabic counts', () => {
  const ago = (mins: number) => arabicAge(new Date(NOW - mins * MIN).toISOString(), NOW);

  it('reads as a person wrote it at one, two, few and many', () => {
    expect(ago(0)).toBe('دلوقتي');
    expect(ago(1)).toBe('من دقيقة');
    expect(ago(2)).toBe('من دقيقتين');
    expect(ago(5)).toBe('من 5 دقايق');
    expect(ago(25)).toBe('من 25 دقيقة');
    expect(ago(180)).toBe('من 3 ساعات');
  });

  it('never counts backwards when the device clock runs behind the server', () => {
    expect(arabicAge(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe('دلوقتي');
  });

  it('says the time is up rather than counting into the negative', () => {
    expect(arabicRemaining(new Date(NOW - MIN).toISOString(), NOW)).toBe('فات وقتها');
    expect(arabicRemaining(new Date(NOW).toISOString(), NOW)).toBe('فات وقتها');
    expect(arabicRemaining(new Date(NOW + 4 * MIN).toISOString(), NOW)).toBe('باقي 4 دقايق');
    expect(arabicRemaining(null, NOW)).toBeNull();
  });
});
