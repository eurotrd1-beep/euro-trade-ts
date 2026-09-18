'use client';

/**
 * Where the price proxy lives, and how the app hears that it moved.
 *
 * ── WHY IT IS HERE AND NOT IN `@euro/shared` ───────────────────────────────
 *
 * It used to sit beside the Supabase client, because it read `configs` and
 * subscribed to Postgres changes. Both of those are app concerns now — the row
 * comes from the hub through `db()`, and the change arrives on the live socket
 * — and `@euro/shared` cannot depend on either without the dependency pointing
 * backwards.
 *
 * What it does has not changed: one read at startup so the chart has the right
 * address before it builds, then an update whenever an admin moves the proxy,
 * without a reload.
 */

import { db } from './dataHub';
import { onChange, onResync } from './live';

/**
 * Fallback until the config row loads, so the app works on first paint and if
 * the hub is unreachable.
 */
export const DEFAULT_PROXY_URL = 'https://euro-trade-proxy.onrender.com';

let proxyUrl = DEFAULT_PROXY_URL;
const proxyListeners = new Set<(url: string) => void>();

/** Current proxy base URL, never with a trailing slash. */
export function getProxyUrl(): string {
  return proxyUrl;
}

export function onProxyUrlChange(fn: (url: string) => void): () => void {
  proxyListeners.add(fn);
  return () => proxyListeners.delete(fn);
}

function clean(url: string | null | undefined): string {
  const u = (url ?? '').trim();
  if (!u) return '';
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

function setProxyUrl(url: string): void {
  if (!url || url === proxyUrl) return;
  proxyUrl = url;
  for (const fn of proxyListeners) fn(url);
}

/**
 * One-shot load at startup so the correct URL is ready before the chart builds.
 *
 * `tv_server_url` is still read as a second choice. It is the row this setting
 * lived in before `proxy_server_url` existed, and an installation that never
 * ran the migration has the address only there.
 */
export async function loadProxyUrl(): Promise<void> {
  for (const id of ['proxy_server_url', 'tv_server_url']) {
    try {
      const { data } = await db()
        .from<{ data: Record<string, string> }>('configs')
        .select('data')
        .eq('id', id)
        .maybeSingle();
      const url = clean(data?.['data']?.['url']);
      if (url) {
        setProxyUrl(url);
        return;
      }
    } catch {
      // Try the next id; the default stands if both fail.
    }
  }
}

/**
 * Keeps the address current — an admin change reaches every open app at once.
 *
 * It was a Postgres realtime subscription filtered to the one row. The live
 * socket says which rows changed rather than what they changed to, so this
 * re-reads when it hears the id it cares about, and on a reconnect, when
 * anything could have been missed while the socket was down.
 */
export function startProxyRealtime(): () => void {
  const wanted = new Set(['proxy_server_url', 'tv_server_url']);

  const offChange = onChange((change) => {
    if (change.table !== 'configs') return;
    // No ids named means "something in configs changed" — re-read rather than
    // ignore it, since the cost is one small query.
    if (change.ids.length > 0 && !change.ids.some((id) => wanted.has(id))) return;
    void loadProxyUrl();
  });
  const offResync = onResync(() => { void loadProxyUrl(); });

  return () => {
    offChange();
    offResync();
  };
}
