/**
 * Supabase client and the dynamic proxy-server config.
 *
 * Ported from lib/supabase_config.dart and lib/services/server_config.dart.
 * Same project, same tables, same `configs` rows — nothing about the backend
 * changes in this migration.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Project URL and anon key.
 *
 * The anon key is public by design — it ships in every client build and is
 * safe to expose PROVIDED row-level security actually restricts access. See
 * the note in `docs/security.md`: right now every table is `USING (true)`,
 * which means this key grants full read/write. That is a pre-existing
 * condition carried over from the Dart apps, not something introduced here.
 */
export const SUPABASE_URL = 'https://dlzqdmqkvlvwnjhqxqym.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRsenFkbXFrdmx2d25qaHF4cXltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2ODk3OTQsImV4cCI6MjA5ODI2NTc5NH0.Gchfry1V4vDnwSKk-uF9r7C10PfhXUkt2E4EpWGbdAg';

let client: SupabaseClient | null = null;

/** Lazily creates the shared client. Safe to call from anywhere. */
export function supabase(): SupabaseClient {
  client ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  return client;
}

// ── Proxy server config ─────────────────────────────────────────────────────

/**
 * Fallback until the config row loads, so the app works on first paint and when
 * Supabase is unreachable.
 */
export const DEFAULT_PROXY_URL = 'https://euro-trade-proxy-1.onrender.com';

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
 * Prefers `proxy_server_url`, falling back to the legacy `tv_server_url` row
 * for installations where the migration has not been applied.
 */
export async function loadProxyUrl(): Promise<void> {
  for (const id of ['proxy_server_url', 'tv_server_url']) {
    try {
      const { data } = await supabase()
        .from('configs')
        .select('data')
        .eq('id', id)
        .maybeSingle();
      const url = clean((data?.['data'] as Record<string, string> | undefined)?.['url']);
      if (url) {
        setProxyUrl(url);
        return;
      }
    } catch {
      // Try the next id; the default stands if both fail.
    }
  }
}

/** Realtime subscription — an admin change reaches every open app instantly. */
export function startProxyRealtime(): () => void {
  const channel = supabase()
    .channel('configs:proxy_server_url')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'configs', filter: 'id=eq.proxy_server_url' },
      (payload) => {
        const row = payload.new as { data?: Record<string, string> } | null;
        const url = clean(row?.data?.['url']);
        if (url) setProxyUrl(url);
      },
    )
    .subscribe();

  return () => {
    void supabase().removeChannel(channel);
  };
}
