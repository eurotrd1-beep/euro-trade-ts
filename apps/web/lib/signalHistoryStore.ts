'use client';

/**
 * Persists the signal history, per account.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * It was lost in the port. The Dart engine kept the list in
 * `SharedPreferences` under `signals_<accountId>`, loaded it whenever the
 * account was set and rewrote it on every settled trade
 * (signal_engine.dart:2055-2092). The TypeScript version kept only the React
 * state, so the list started empty on every mount: a refresh, a tab restore, a
 * reopened app, and the whole history — and every statistic computed from it —
 * was gone. Nothing looked broken, because an empty history renders as zeroes
 * rather than as an error.
 *
 * ── WHAT IS DELIBERATELY NOT PORTED ───────────────────────────────────────
 * The Dart version had one more branch: when no saved history was found it
 * called `_generateMockHistory()` and SAVED the result, so a brand-new account
 * opened the app to a history of trades it had never taken, complete with a win
 * rate. That is not restored here and should not be. A new account sees an
 * empty history, which is what an account with no trades has.
 *
 * ── PER ACCOUNT, ON PURPOSE ───────────────────────────────────────────────
 * The key carries the account id, so two accounts on one device do not read
 * each other's trades — the same reason the Dart key did.
 *
 * ── AND WHY localStorage IS NO LONGER THE ONLY COPY ────────────────────────
 * Because it is not durable, and this file was the last place still betting on
 * it. `lib/session.ts` already documents when it goes away: iOS evicts it under
 * storage pressure, in-app browsers and the Capacitor WebView clear it between
 * launches, and any "clear app data" takes it. The session survived that by
 * being written to a cookie as well. The history had no second copy, so a user
 * signing back into the SAME account found an empty log — reported, and
 * reproducible by clearing the store.
 *
 * So the history now lives in `signal_history` on the server, one row per
 * account, and localStorage stays as the cache that paints the list instantly
 * and keeps it working offline. The two are merged rather than one overwriting
 * the other, because either side can hold a trade the other has never seen: the
 * server has the trades from the user's other device, and the cache has the ones
 * settled while the network was down.
 */

import { supabase } from '@euro/shared';
import type { TradingSignal } from '@euro/engine';

/** The Dart cap, kept: fifty settled signals per account. */
const LIMIT = 50;

/** The table the migration creates. */
const TABLE = 'signal_history';

const keyFor = (accountId: string): string => `signals_${accountId}`;

/** Only the fields the history card and its statistics actually read. */
function reviveSignal(raw: Record<string, unknown>): TradingSignal | null {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const entryTime = num(raw['entryTime']);
  const status = raw['status'];
  const direction = raw['direction'];
  if (entryTime === null) return null;
  if (status !== 'WIN' && status !== 'LOSS' && status !== 'TIE' &&
      status !== 'ACTIVE' && status !== 'PENDING') return null;
  if (direction !== 'CALL' && direction !== 'PUT') return null;

  return {
    pair: typeof raw['pair'] === 'string' ? raw['pair'] : '',
    direction,
    durationMinutes: num(raw['durationMinutes']) ?? 0,
    entryPrice: num(raw['entryPrice']) ?? 0,
    currentPrice: num(raw['currentPrice']) ?? 0,
    confidence: num(raw['confidence']) ?? 0,
    entryTime,
    expiryTime: num(raw['expiryTime']) ?? entryTime,
    status,
    exitPrice: num(raw['exitPrice']),
    // Never persisted: a candle snapshot per signal would be tens of thousands
    // of numbers in a store meant for a few kilobytes, and nothing reads it
    // back off a reload.
    candlesSnapshot: null,
    marketCondition: typeof raw['marketCondition'] === 'string' ? raw['marketCondition'] : '',
    recommendation: typeof raw['recommendation'] === 'string' ? raw['recommendation'] : '',
    origin: raw['origin'] === 'monitoring' ? 'monitoring' : 'instant',
    // Kept across a reload because the history is where a user checks what a
    // martingale actually did — dropping it would leave two identical-looking
    // trades and no way to tell which one was the double.
    ...(raw['stage'] === 'martingale' || raw['stage'] === 'primary'
      ? { stage: raw['stage'] }
      : {}),
  };
}

/** Reads the stored history. Returns [] for anything unreadable. */
export function loadHistory(accountId: string): TradingSignal[] {
  if (!accountId || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(keyFor(accountId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: TradingSignal[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') continue;
      const sig = reviveSignal(item as Record<string, unknown>);
      // A row written by an older shape is skipped, not allowed to throw. One
      // bad entry must not cost the user the other forty-nine.
      if (sig !== null) out.push(sig);
    }
    return out.slice(0, LIMIT);
  } catch {
    return [];
  }
}

/**
 * Writes the history back, newest first, capped.
 *
 * Silent on failure by design: a full or blocked store is not a reason to
 * interrupt someone mid-trade, and the list still works for this session.
 */
export function saveHistory(accountId: string, history: readonly TradingSignal[]): void {
  if (!accountId || typeof localStorage === 'undefined') return;
  try {
    const trimmed = history.slice(0, LIMIT).map((s) => ({ ...s, candlesSnapshot: null }));
    localStorage.setItem(keyFor(accountId), JSON.stringify(trimmed));
  } catch {
    // Quota exceeded or storage disabled.
  }
}

// ── The durable copy ────────────────────────────────────────────────────────

/**
 * One trade's identity, for merging two copies of the list.
 *
 * Entry time is aligned to the candle open and only one trade is ever open at a
 * time, so a pair and a direction at the same entry time is the same trade —
 * whichever device recorded it.
 */
const identityOf = (s: TradingSignal): string => `${s.entryTime}|${s.pair}|${s.direction}`;

/** A settled row is worth more than the same row still marked open. */
const isSettled = (s: TradingSignal): boolean =>
  s.status === 'WIN' || s.status === 'LOSS' || s.status === 'TIE';

/**
 * Unions two copies of the history, newest first, capped.
 *
 * Neither side wins wholesale, because both can hold trades the other has never
 * seen: the server carries what the user's other device recorded, and the cache
 * carries what settled while the network was down. Where the same trade appears
 * twice the settled version is kept, so a stale ACTIVE row from a session that
 * was closed mid-trade can never overwrite its own outcome.
 */
export function mergeHistories(
  a: readonly TradingSignal[],
  b: readonly TradingSignal[],
): TradingSignal[] {
  const byIdentity = new Map<string, TradingSignal>();
  for (const s of [...a, ...b]) {
    const key = identityOf(s);
    const seen = byIdentity.get(key);
    if (seen === undefined) { byIdentity.set(key, s); continue; }
    if (!isSettled(seen) && isSettled(s)) byIdentity.set(key, s);
  }
  return [...byIdentity.values()]
    .sort((x, y) => y.entryTime - x.entryTime)
    .slice(0, LIMIT);
}

/**
 * Reads the durable copy.
 *
 * Returns null — not [] — when the server could not be asked, so the caller can
 * tell "this account has no trades" apart from "we do not know yet". The second
 * one must never be allowed to overwrite the local cache.
 *
 * A missing table returns null too, which is what makes deploying the app before
 * running the migration harmless: the history simply stays device-local until
 * the table exists.
 */
export async function fetchRemoteHistory(accountId: string): Promise<TradingSignal[] | null> {
  if (!accountId) return null;
  try {
    const { data, error } = await supabase()
      .from(TABLE)
      .select('signals')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) return null;
    const raw = (data as { signals?: unknown } | null)?.signals;
    if (!Array.isArray(raw)) return data === null ? [] : null;

    const out: TradingSignal[] = [];
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue;
      const sig = reviveSignal(item as Record<string, unknown>);
      if (sig !== null) out.push(sig);
    }
    return out.slice(0, LIMIT);
  } catch {
    return null;
  }
}

/**
 * Writes the durable copy. Never throws and never awaited on a trading path —
 * a blocked network is not a reason to interrupt someone mid-trade, and the
 * local cache already has the row.
 */
export async function pushRemoteHistory(
  accountId: string,
  history: readonly TradingSignal[],
): Promise<void> {
  if (!accountId) return;
  try {
    const trimmed = history.slice(0, LIMIT).map((s) => ({ ...s, candlesSnapshot: null }));
    // `updated_at` is deliberately not sent: the trigger sets it from the
    // server clock, because a client's clock can be wrong or lied about.
    await supabase().from(TABLE).upsert({ account_id: accountId, signals: trimmed });
  } catch {
    // Offline, blocked, or the migration has not been run yet.
  }
}

/**
 * Marks abandoned trades as PENDING.
 *
 * A stored ACTIVE trade whose expiry has already passed was opened in a session
 * that closed before it finished, so its outcome was never observed. The one
 * thing that must not happen here is inventing one: the exit price at that
 * instant is gone, and settling it now against a price from minutes or days
 * later would manufacture a win or a loss out of nothing. PENDING says exactly
 * what is true — the trade was placed and the result is unknown — and the
 * history card counts it out of the win rate rather than into it.
 *
 * A trade still inside its window is left ACTIVE for the resume effect, but only
 * on its own pair: on any other chart there is no price that can settle it.
 */
export function resolveOpenTrades(
  history: readonly TradingSignal[],
  pair: string,
  active: TradingSignal | null,
): TradingSignal[] {
  const now = Date.now();
  return history.map((s) => {
    if (s.status !== 'ACTIVE') return s;
    // The trade being counted down right now is not abandoned.
    if (active !== null && active.entryTime === s.entryTime && active.pair === s.pair) return s;
    if (s.expiryTime > now && s.pair === pair) return s;
    return { ...s, status: 'PENDING' as const };
  });
}
