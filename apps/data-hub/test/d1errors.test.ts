/**
 * Telling the daily quota apart from every other way D1 says no.
 *
 * Two things act on this answer. The spool holds rows only when D1 could not
 * take them; the app shows its pause screen only when the quota is spent. A
 * wrong answer in either direction is costly — a poison row held for ever, or
 * every user told the service is down until midnight over a network blip — so
 * the cases are pinned to the exact text Cloudflare documents, and anything
 * unrecognised must land on `unknown`, which triggers neither.
 */

import { describe, expect, it } from 'vitest';
import { classifyD1Error, quotaKind, shouldSpool } from '../src/d1errors.js';

// Verbatim from developers.cloudflare.com/d1/observability/debug-d1/.
const WRITE_QUOTA = "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details.";
const READ_QUOTA = "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details.";

// Captured from the live database.
const NOT_NULL = 'NOT NULL constraint failed: signals.symbol: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL) [code: 7500]';
const CHECK = "CHECK constraint failed: kind IN ('eligible', 'signal', 'result', 'daily'): SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK) [code: 7500]";

describe('the daily quota', () => {
  it('is recognised for writes and for reads', () => {
    expect(classifyD1Error(new Error(WRITE_QUOTA))).toBe('quota');
    expect(classifyD1Error(new Error(READ_QUOTA))).toBe('quota');
  });

  it('says which limit was hit', () => {
    expect(quotaKind(new Error(WRITE_QUOTA))).toBe('write');
    expect(quotaKind(new Error(READ_QUOTA))).toBe('read');
    expect(quotaKind(new Error('Network connection lost.'))).toBeNull();
  });

  it('survives the wrapping D1 adds in front of the message', () => {
    expect(classifyD1Error(new Error(`D1_ERROR: ${WRITE_QUOTA}`))).toBe('quota');
  });

  it('is spooled, because the rows are valid and only the day is over', () => {
    expect(shouldSpool('quota')).toBe(true);
  });
});

describe('everything that is not the quota', () => {
  it.each([
    'D1 DB is overloaded. Requests queued for too long.',
    'D1 DB is overloaded. Too many requests queued.',
    'Network connection lost.',
    "Can't read from request stream because client disconnected.",
    'Replica disconnected from primary.',
    'Exceeded maximum DB size.',
    "Your account has exceeded D1's maximum account storage limit, please contact Cloudflare to raise your limit",
  ])('%s → unavailable, not quota', (msg) => {
    // The storage one shares "Your account has exceeded D1's" with the quota
    // message. It must not be read as the daily limit: it does not reset at
    // midnight, and telling users "back soon" would be a lie.
    expect(classifyD1Error(new Error(msg))).toBe('unavailable');
  });

  it('reads a rejected row as data, never as an outage', () => {
    expect(classifyD1Error(new Error(NOT_NULL))).toBe('data');
    expect(classifyD1Error(new Error(CHECK))).toBe('data');
  });

  it('does not spool a rejected row — it would fail every replay', () => {
    expect(shouldSpool('data')).toBe(false);
  });

  it('calls anything unrecognised unknown, and does nothing with it', () => {
    // A reworded quota message must degrade to "behave as before", not to a
    // false outage and not to a held row.
    for (const msg of ['something new', 'D1_ERROR', '', 'Internal error']) {
      expect(classifyD1Error(new Error(msg))).toBe('unknown');
    }
    expect(shouldSpool('unknown')).toBe(false);
  });

  it('handles non-Error values without throwing', () => {
    expect(classifyD1Error(WRITE_QUOTA)).toBe('quota');
    expect(classifyD1Error(null)).toBe('unknown');
    expect(classifyD1Error(undefined)).toBe('unknown');
    expect(classifyD1Error({ weird: true })).toBe('unknown');
  });
});
