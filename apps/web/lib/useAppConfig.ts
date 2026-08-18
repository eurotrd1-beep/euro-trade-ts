'use client';

/**
 * Live admin configuration — one hook replacing the ten separate `.stream()`
 * listeners `main_screen.dart` wires up in `initState`.
 *
 * Every default here is the one the Dart code falls back to when the row is
 * missing, so a fresh install or an unreachable backend behaves identically.
 */

import { useEffect, useState } from 'react';
import { watchConfig, watchPairs, watchUser } from './realtime';
import type { PairRow } from '@euro/shared';

export interface AppConfig {
  /** 'sim' | 'scraping' — anything other than 'sim' resolves to 'scraping'. */
  chartMode: 'sim' | 'scraping';
  /** Raw `price_system` value; null until the row arrives. */
  priceSystem: string | null;
  /**
   * Whether the rows have actually arrived.
   *
   * Every field above has a starting value, and a starting value is
   * indistinguishable from a loaded one to anybody reading the object. That
   * cost the app its price feed on every single open: `priceSystem` starts
   * null, the caller fell back to `chartMode`, `chartMode` started at 'sim',
   * and so the app ran the SIMULATOR for the length of one round-trip while
   * the database sat there saying 'scraping'. Ask this before treating a
   * default as an answer.
   */
  loaded: boolean;
  /** 'po' | 'all' — which data source users may see. */
  displaySource: string;
  maintenance: { isActive: boolean; message: string; endsAt: string | null };
  social: { telegram: string; whatsapp: string; youtube: string };
}

const INITIAL: AppConfig = {
  // Starts on the real feed, not the simulator. A default is a guess, and the
  // guess should be the mode that shows real prices — the simulator is a
  // deliberate choice an operator makes, never somewhere the app drifts into
  // while it waits for a network reply.
  chartMode: 'scraping',
  priceSystem: null,
  loaded: false,
  displaySource: 'all',
  maintenance: { isActive: false, message: '', endsAt: null },
  social: { telegram: '', whatsapp: '', youtube: '' },
};

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

export function useAppConfig(): AppConfig {
  const [config, setConfig] = useState<AppConfig>(INITIAL);

  useEffect(() => {
    const patch = (p: Partial<AppConfig>) => setConfig((c) => ({ ...c, ...p }));

    const unsubs = [
      watchConfig('chart_settings', (d) =>
        // Dart: `mode == 'sim' ? 'sim' : 'scraping'` — anything unknown means
        // scraping, so a typo in the admin never silently falls back to sim.
        patch({ chartMode: str(d['mode'], 'sim') === 'sim' ? 'sim' : 'scraping' }),
      ),

      watchConfig('price_system', (d) =>
        patch({
          priceSystem: typeof d['value'] === 'string' ? d['value'] : null,
          loaded: true,
        }),
      ),

      watchConfig('display_source', (d) => patch({ displaySource: str(d['value'], 'all') })),

      watchConfig('maintenance', (d) =>
        patch({
          maintenance: {
            isActive: d['isActive'] === true,
            message: str(d['message']),
            endsAt: typeof d['endsAt'] === 'string' ? d['endsAt'] : null,
          },
        }),
      ),

      watchConfig('social', (d) =>
        patch({
          social: {
            telegram: str(d['telegram']),
            whatsapp: str(d['whatsapp']),
            youtube: str(d['youtube']),
          },
        }),
      ),

    ];

    return () => {
      for (const off of unsubs) off();
    };
  }, []);

  return config;
}

/** Live pair list, replacing the local fallback as soon as it arrives. */
export function usePairs(): PairRow[] | null {
  const [pairs, setPairs] = useState<PairRow[] | null>(null);
  useEffect(() => watchPairs(setPairs), []);
  return pairs;
}

export interface LiveUser {
  role: string;
  vipExpiry: Date | null;
  isBanned: boolean;
  banReason: string;
  guaranteedWin: boolean;
  /** False until the row has been seen at least once. */
  loaded: boolean;
  /** True when the row existed and then disappeared — the account was deleted. */
  deleted: boolean;
}

/**
 * Live user state. The Dart screen watches this row to react to an admin
 * granting VIP, banning, or deleting the account while the app is open.
 */
export function useLiveUser(accountId: string | null): LiveUser {
  const [user, setUser] = useState<LiveUser>({
    role: 'standard',
    vipExpiry: null,
    isBanned: false,
    banReason: '',
    guaranteedWin: false,
    loaded: false,
    deleted: false,
  });

  useEffect(() => {
    if (!accountId) return;
    let seen = false;

    return watchUser(accountId, (row) => {
      if (row === null) {
        // Only treat a missing row as a deletion if we had seen it before —
        // otherwise a first-load failure would look like a deleted account.
        setUser((u) => ({ ...u, loaded: true, deleted: seen }));
        return;
      }
      seen = true;
      const expiryRaw = row['vip_expiry'];
      const expiry = typeof expiryRaw === 'string' ? new Date(expiryRaw) : null;

      setUser({
        role: typeof row['role'] === 'string' ? row['role'] : 'standard',
        vipExpiry: expiry && !Number.isNaN(expiry.getTime()) ? expiry : null,
        isBanned: row['is_banned'] === true,
        banReason: typeof row['ban_reason'] === 'string' ? row['ban_reason'] : '',
        guaranteedWin: row['guaranteed_win'] === true,
        loaded: true,
        deleted: false,
      });
    });
  }, [accountId]);

  return user;
}
