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

const configListeners = new Map<string, Set<ConfigListener>>();
let configChannel: ReturnType<ReturnType<typeof supabase>['channel']> | null = null;
/** Last known value per row, so a late subscriber gets the snapshot at once. */
const configCache = new Map<string, Record<string, unknown>>();

function ensureConfigChannel(): void {
  if (configChannel) return;

  configChannel = supabase()
    .channel('configs:all')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'configs' },
      (payload) => {
        const row = (payload.new ?? payload.old) as ConfigRow | null;
        if (!row?.id) return;
        const data = (row.data ?? {}) as Record<string, unknown>;
        configCache.set(row.id, data);
        for (const fn of configListeners.get(row.id) ?? []) fn(data);
      },
    )
    .subscribe();
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
