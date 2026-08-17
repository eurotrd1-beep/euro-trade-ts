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
 * One difference from Dart, and it is a deliberate improvement rather than a
 * behaviour change: the Dart screen opens ~10 separate `.stream()` calls, one
 * per config row, and a transient DB blip made ALL of them re-subscribe and
 * re-fetch at once. Here a single channel carries every `configs` change and
 * fans it out locally, so a reconnect costs one subscription instead of ten.
 * The data each listener sees is identical.
 */

import { supabase } from '@euro/shared';
import type { ConfigRow, PairRow } from '@euro/shared';

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
] as const;

const configListeners = new Map<string, Set<ConfigListener>>();
let configChannel: ReturnType<ReturnType<typeof supabase>['channel']> | null = null;
/** Last known value per row, so a late subscriber gets the snapshot at once. */
const configCache = new Map<string, Record<string, unknown>>();

function ensureConfigChannel(): void {
  if (configChannel) return;

  // One channel, one filtered subscription per row. Handlers must all be
  // registered BEFORE subscribe() — postgres_changes bindings added afterwards
  // are silently ignored — which is why the list is a constant rather than
  // being grown as callers arrive.
  let channel = supabase().channel('configs:watched');
  for (const id of WATCHED_CONFIG_IDS) {
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'configs', filter: `id=eq.${id}` },
      (payload) => {
        const row = (payload.new ?? payload.old) as ConfigRow | null;
        if (!row?.id) return;
        const data = (row.data ?? {}) as Record<string, unknown>;
        configCache.set(row.id, data);
        for (const fn of configListeners.get(row.id) ?? []) fn(data);
      },
    );
  }
  configChannel = channel.subscribe();
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
    void (async () => {
      try {
        const { data } = await supabase()
          .from('configs')
          .select('data')
          .eq('id', id)
          .maybeSingle();
        const value = (data?.['data'] ?? {}) as Record<string, unknown>;
        configCache.set(id, value);
        onData(value);
      } catch {
        // Leave the caller on its documented default.
      }
    })();
  }

  return () => {
    listeners.delete(onData);
  };
}

/** Watches the whole `pairs` table: one snapshot, then rare deltas. */
export function watchPairs(onData: (pairs: PairRow[]) => void): () => void {
  let cancelled = false;

  void (async () => {
    try {
      const { data } = await supabase().from('pairs').select('*').order('order');
      if (!cancelled) onData((data as PairRow[] | null) ?? []);
    } catch {
      if (!cancelled) onData([]);
    }
  })();

  const channel = supabase()
    .channel('pairs:all')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pairs' }, () => {
      // A delta could be applied in place, but the table is tiny and changes
      // are rare — re-reading keeps ordering and filtering trivially correct.
      void (async () => {
        try {
          const { data } = await supabase().from('pairs').select('*').order('order');
          if (!cancelled) onData((data as PairRow[] | null) ?? []);
        } catch {
          // Keep the previous list.
        }
      })();
    })
    .subscribe();

  return () => {
    cancelled = true;
    void supabase().removeChannel(channel);
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
      const { data } = await supabase().from('users').select('*').eq('id', accountId).maybeSingle();
      if (!cancelled) onData((data as Record<string, unknown> | null) ?? null);
    } catch {
      // Keep the last known state rather than downgrading the user.
    }
  }

  void read();

  const channel = supabase()
    .channel(`users:${accountId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'users', filter: `id=eq.${accountId}` },
      () => void read(),
    )
    .subscribe();

  return () => {
    cancelled = true;
    void supabase().removeChannel(channel);
  };
}
