/**
 * What kind of "no" D1 just said.
 *
 * ── WHY THIS HAS TO BE ONE PLACE ───────────────────────────────────────────
 *
 * Two decisions depend on the answer, and they fail badly in opposite ways if
 * they disagree:
 *
 *   the spool — "D1 cannot take this right now, hold it". Holding a row D1
 *     REJECTED for its content is holding a poison row: every replay fails on
 *     it, and if the replay stops at the first failure, nothing behind it is
 *     ever written.
 *
 *   the app — "the daily quota is spent, show the pause screen". Showing that
 *     for a network blip tells every user the service is down until midnight.
 *
 * ── WHERE THE STRINGS COME FROM ────────────────────────────────────────────
 *
 * The quota and availability messages are Cloudflare's own, from the D1
 * debugging reference (developers.cloudflare.com/d1/observability/debug-d1/):
 *
 *   "Your account has exceeded D1's free tier daily row write limit. …"
 *   "Your account has exceeded D1's free tier daily row read limit. …"
 *   "D1 DB is overloaded. Requests queued for too long." / "… Too many requests queued."
 *   "Network connection lost." · "Replica disconnected from primary."
 *   "Can't read from request stream because client disconnected."
 *   "Exceeded maximum DB size." · "…exceeded D1's maximum account storage limit…"
 *
 * The data-rejection text was captured from the live database, since the page
 * does not list it: `NOT NULL constraint failed: signals.symbol: SQLITE_CONSTRAINT`
 * and `CHECK constraint failed: …: SQLITE_CONSTRAINT`.
 *
 * ── MATCHING TEXT IS FRAGILE, SO IT FAILS SAFE ─────────────────────────────
 *
 * These are error MESSAGES, and Cloudflare can reword one. Every pattern is
 * matched on its most distinctive phrase rather than the whole sentence, and
 * anything unrecognised is `unknown` — which neither spools nor shows the
 * pause screen. A reworded quota message degrades to "the app behaves as it
 * did before this file existed", never to "the app claims an outage".
 */

export type D1Failure =
  /** The daily free-plan limit is spent. Every query fails until 00:00 UTC. */
  | 'quota'
  /** D1 is reachable in principle and cannot answer right now. */
  | 'unavailable'
  /** D1 answered, and the answer was that the row itself is wrong. */
  | 'data'
  /** Anything else. Treated as neither of the above. */
  | 'unknown';

const QUOTA = /exceeded D1'?s free tier daily row (read|write) limit/i;

const UNAVAILABLE = new RegExp([
  'D1 DB is overloaded',
  'Network connection lost',
  'Replica disconnected',
  'client disconnected',
  'Exceeded maximum DB size',
  'maximum account storage limit',
].join('|'), 'i');

const DATA = /SQLITE_CONSTRAINT|constraint failed/i;

export function classifyD1Error(error: unknown): D1Failure {
  const text = error instanceof Error
    ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
    : String(error ?? '');
  // Quota first: its message is the most specific, and it is the one whose
  // misreading costs the most.
  if (QUOTA.test(text)) return 'quota';
  if (DATA.test(text)) return 'data';
  if (UNAVAILABLE.test(text)) return 'unavailable';
  return 'unknown';
}

/** Whether a write that failed this way should be held for later. */
export const shouldSpool = (kind: D1Failure): boolean =>
  kind === 'quota' || kind === 'unavailable';

/** Which daily limit, when the failure is the quota. */
export function quotaKind(error: unknown): 'read' | 'write' | null {
  const text = error instanceof Error ? error.message : String(error ?? '');
  const m = text.match(QUOTA);
  return m ? (m[1]!.toLowerCase() as 'read' | 'write') : null;
}

/**
 * The next 00:00 UTC — when the free plan's daily limits reset.
 *
 * "Free limits reset daily at 00:00 UTC", per the D1 pricing page. It is sent
 * to the app as a number rather than a message, so the app can schedule its
 * own check without having to parse anything.
 */
export function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** The code the app looks for. A status alone is ambiguous; this is not. */
export const QUOTA_CODE = 'd1_quota';
