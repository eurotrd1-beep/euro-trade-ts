'use client';

/**
 * The pairs the user has chosen. One list, for everything.
 *
 * ── WHY IT IS ONE LIST ─────────────────────────────────────────────────────
 *
 * Because two would drift, and the drift would be invisible. The app had a
 * chosen-pairs list inside the notification code (`push_symbols`) and, quite
 * separately, watched every pair the catalogue offered. So "which pairs am I
 * following" already had two different answers depending on which part of the
 * app you asked, and the version where the user picks the watch list too would
 * have made it three.
 *
 * The failure that produces is the worst kind: a user selects EUR/USD, the
 * watch sweeps something else, and a notification arrives about a pair they
 * never chose — or worse, does not arrive about the one they did. Nothing
 * errors. There is no screen where the mismatch is visible. It just quietly
 * does the wrong thing for as long as nobody works out why.
 *
 * So this is the only place the answer lives. The watch reads it, the
 * notification subscription reads it, the card reads it.
 *
 * ── AN EMPTY LIST IS A REAL STATE ──────────────────────────────────────────
 *
 * It means "I have not chosen yet", and it is what the generate button is
 * disabled on. Deliberately NOT the same as "all of them": a user who has
 * chosen nothing wants nothing yet, and quietly treating that as everything is
 * how somebody ends up with 89 notification streams they never asked for.
 *
 * There is no `null` here either. The notification channel used to read
 * `symbols: null` as "no selection made", which was a third meaning for the
 * same field. Selecting every pair now stores every pair, explicitly, after
 * being told what that means.
 */

const PREFIX = 'watched_pairs';

/** What the notification code used before this file existed. Read once, then retired. */
const LEGACY_KEY = 'push_symbols';

function keyFor(accountId: string | null): string {
  // Per account, because two people on one device do not share a watch list —
  // the same reason the program state and the trade history are per account.
  return `${PREFIX}:${accountId ?? 'anon'}`;
}

function parse(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    return value.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return null;
  }
}

/**
 * The chosen pairs, or an empty list.
 *
 * Migrates the notification code's old list on first read, so a user who had
 * already picked pairs for notifications does not arrive to an empty selection
 * and a disabled button. `'all'` was how that key stored "everything", and it
 * cannot be expanded here — this file does not know the catalogue — so it comes
 * back empty and the caller fills it in with `everything`.
 */
export function loadWatched(accountId: string | null): string[] {
  if (typeof localStorage === 'undefined') return [];

  const own = parse(localStorage.getItem(keyFor(accountId)));
  if (own !== null) return own;

  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy === null || legacy === 'all') return [];
  return parse(legacy) ?? [];
}

/** True when the old notification key said "every pair", so the caller can expand it. */
export function legacyWantedEverything(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(LEGACY_KEY) === 'all';
}

export function saveWatched(accountId: string | null, symbols: readonly string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    // Sorted and de-duplicated on the way in, so the stored value is the same
    // whatever order the picker happened to collect them in. That makes "did
    // the selection change" a string comparison instead of a set comparison.
    const clean = [...new Set(symbols)].sort();
    localStorage.setItem(keyFor(accountId), JSON.stringify(clean));
    // The old key is not left behind to be migrated a second time on some
    // other device that syncs storage.
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* private mode; the server copy of the subscription is what matters */
  }
}

/**
 * Whether choosing this many pairs means one notification stream per pair.
 *
 * The threshold is not about performance — 89 pairs cost a fraction of a
 * millisecond to evaluate. It is about what arrives on the user's phone: every
 * chosen pair is announced individually, so a large selection is a large number
 * of separate alerts, and that is worth being asked about rather than
 * discovered overnight.
 */
export const NOISY_SELECTION = 10;
