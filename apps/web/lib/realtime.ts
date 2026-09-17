/**
 * Supabase Realtime subscriptions for `configs` and `pairs`.
 *
 * Ported from `_pollConfig` / `_pollPairs` in main_screen.dart. The comment on
 * the Dart original is worth carrying over verbatim, because it records a real
 * incident:
 *
 *   > Realtime sends only the initial snapshot + deltas on change, so a rarely-
 *   > changing config costs almost no Egress — vs a 30s poll which re-downloaded
 *   > everything per user and burned ~5.6GB in 2 days.
 *
 * So: never replace these with polling.
 *
 * ── AND HOW THE PUSH WORKS NOW ────────────────────────────────────────────
 *
 * This file used to say Supabase kept this one job after everything else had
 * moved, because D1 has no way to tell anyone a row changed. That is still true
 * of D1 — the push comes from the Worker instead, which is the only thing that
 * knows a row changed, through a Durable Object holding one socket per open
 * app (`lib/live.ts`).
 *
 * The shape is the same as before in the way that matters: a snapshot on
 * arrival and a nudge per change, never a poll. The warning above still governs
 * this file.
 *
 * One difference worth knowing. A Supabase delta carried the new ROW; this
 * carries only `{ table, ids }` and the listener re-reads. That is a security
 * decision — `users` is owner-scoped, and a socket is not a credential, so a
 * broadcast carrying rows would hand every open browser somebody else's role
 * and ban state. It also means a reconnect can simply refetch, which is how a
 * missed message becomes "a few seconds late" instead of "wrong until reload".
 *
 * One difference from Dart, and it is a deliberate improvement rather than a
 * behaviour change: the Dart screen opens ~10 separate `.stream()` calls, one
 * per config row, and a transient DB blip made ALL of them re-subscribe and
 * re-fetch at once. Here a single channel carries every `configs` change and
 * fans it out locally, so a reconnect costs one subscription instead of ten.
 * The data each listener sees is identical.
 */

import type { UserRow } from '@euro/shared';
import { db } from './dataHub';
import { onChange, onResync } from './live';
import type { PairRow } from '@euro/shared';

type ConfigListener = (data: Record<string, unknown>) => void;

/**
 * Every `configs` row the app actually watches — and the subscription filter.
 *
 * This list is not documentation. It used to be one unfiltered subscription on
 * the whole table, which meant the server pushed EVERY configs change to every
 * open app and this file threw away the ones nobody had asked for. That is fine
 * for a table that changes when an admin edits something; `configs` is not that
 * table. The proxy wrote a 16.6KB price snapshot into it every 20 seconds, so
 * each user was receiving ~3MB an hour of a row the app never reads: 4.3 million
 * realtime messages a month at 100 users, against a ceiling of 5 million.
 *
 * The price row has moved to `price_snapshot` (see the migration), and the
 * remaining hot-ish writers — `otc_status`, `otc_scan`, `otc_token`,
 * `captcha_balance` — are filtered out here rather than trusted to stay quiet.
 *
 * ADDING A ROW: put its id here. `watchConfig` on an id that is missing still
 * fetches the value once, so nothing breaks — but it will never update live,
 * which is exactly the kind of bug that looks like "realtime is flaky".
 */
const WATCHED_CONFIG_IDS = [
  'chart_settings',
  'price_system',
  'display_source',
  'maintenance',
  'social',
  // The price hub switch. Listed here because the note above says to: an id
  // left out is fetched once and then never updates again, and a rollback that
  // needs a reload before it takes effect is not a rollback.
  'price_feed',
] as const;

const configListeners = new Map<string, Set<ConfigListener>>();
let configWired = false;
/** Last known value per row, so a late subscriber gets the snapshot at once. */
const configCache = new Map<string, Record<string, unknown>>();

/** Re-reads one row and hands it to whoever is watching it. */
async function refetchConfig(id: string): Promise<void> {
  try {
    const { data } = await db()
      .from<{ data: Record<string, unknown> }>('configs')
      .select('data')
      .eq('id', id)
      .maybeSingle();
    const value = (data?.['data'] ?? {}) as Record<string, unknown>;
    configCache.set(id, value);
    for (const fn of configListeners.get(id) ?? []) fn(value);
  } catch {
    // Leave every listener on the value it already has. A failed refetch is a
    // stale screen for a few seconds; clearing the cache would be a blank one.
  }
}

function ensureConfigChannel(): void {
  if (configWired) return;
  configWired = true;

  // The nudge names the rows that changed, so only those are re-read. A write
  // that names none — which nothing does today — refetches everything watched,
  // because "something in configs changed" with no id is not a reason to
  // ignore it.
  onChange((change) => {
    if (change.table !== 'configs') return;
    const ids = change.ids.length > 0
      ? change.ids.filter((id) => configListeners.has(id))
      : [...configListeners.keys()];
    for (const id of ids) void refetchConfig(id);
  });

  // Nothing is queued for a client that was not connected, so a reconnect
  // re-reads everything anybody is watching.
  onResync(() => {
    for (const id of configListeners.keys()) void refetchConfig(id);
  });
}

/**
 * Watches one `configs` row. Delivers the current value immediately (fetching
 * it if not cached), then every change.
 *
 * Errors are swallowed: the realtime client reconnects on its own, and a
 * transient blip must never take the screen down.
 */
export function watchConfig(id: string, onData: ConfigListener): () => void {
  ensureConfigChannel();

  // A row outside the filter list still gets its initial value below, but will
  // never see an update. Say so loudly rather than let it look like a flaky
  // connection months later.
  if (!(WATCHED_CONFIG_IDS as readonly string[]).includes(id)) {
    console.warn(
      `[realtime] configs/${id} مش في WATCHED_CONFIG_IDS — هيتقرا مرة واحدة بس ` +
        `ومش هيتحدّث لحظيًا. ضيفه في lib/realtime.ts.`,
    );
  }

  let listeners = configListeners.get(id);
  if (!listeners) {
    listeners = new Set();
    configListeners.set(id, listeners);
  }
  listeners.add(onData);

  const cached = configCache.get(id);
  if (cached) {
    onData(cached);
  } else {
    // The snapshot. Same read the nudge triggers, so there is one code path
    // for "what does this row say" rather than two that can drift.
    void refetchConfig(id);
  }

  return () => {
    listeners.delete(onData);
  };
}

/** Watches the whole `pairs` table: one snapshot, then rare deltas. */
export function watchPairs(onData: (pairs: PairRow[]) => void): () => void {
  let cancelled = false;

  // A delta could be applied in place, but the table is twenty-five rows and
  // changes when an admin edits it — re-reading keeps ordering and filtering
  // trivially correct, and costs one small query.
  const read = async (onFail: 'empty' | 'keep'): Promise<void> => {
    try {
      const { data } = await db().from<PairRow>('pairs').select('*').order('order').limit(200);
      if (!cancelled) onData((data as PairRow[] | null) ?? []);
    } catch {
      // On the FIRST read an empty list is the honest answer and the caller
      // falls back to its built-in catalogue. On a later one it would replace a
      // good list with nothing, so the previous list stays.
      if (onFail === 'empty' && !cancelled) onData([]);
    }
  };

  void read('empty');

  const offChange = onChange((change) => {
    if (change.table === 'pairs') void read('keep');
  });
  const offResync = onResync(() => { void read('keep'); });

  return () => {
    cancelled = true;
    offChange();
    offResync();
  };
}

/** Watches a single `users` row — role, VIP expiry, bans, guaranteed-win. */
export function watchUser(
  accountId: string,
  onData: (row: Record<string, unknown> | null) => void,
): () => void {
  let cancelled = false;

  async function read(): Promise<void> {
    try {
      const { data } = await db().from<UserRow>('users').select('*').eq('id', accountId).maybeSingle();
      if (!cancelled) onData((data as Record<string, unknown> | null) ?? null);
    } catch {
      // Keep the last known state rather than downgrading the user. A failed
      // read must never look like "this account lost its VIP".
    }
  }

  void read();

  // The nudge carries ids, never rows — `users` is owner-scoped and a socket is
  // not a credential, so the hub tells everybody that *an* id changed and each
  // client re-reads under its own scope. A client that asks for somebody else's
  // row gets nothing, which is why naming the id in the clear is safe.
  const offChange = onChange((change) => {
    if (change.table !== 'users') return;
    if (change.ids.length > 0 && !change.ids.includes(accountId)) return;
    void read();
  });
  const offResync = onResync(() => { void read(); });

  return () => {
    cancelled = true;
    offChange();
    offResync();
  };
}
