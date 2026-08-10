'use client';

/**
 * Live price ticker for the login screen.
 *
 * Shows REAL prices from the project's own feed rather than invented headlines
 * — a visitor can check any of them against the market. It reads the same
 * `/api/otc/status` payload the app already caches, so it costs one request on
 * a page the user sits on for a few seconds.
 */

import { useEffect, useState } from 'react';
import { getProxyUrl, formatPrice } from '@euro/shared';
import styles from './LiveTicker.module.css';

/** Refreshed slowly: this is decoration on a login page, not a trading view. */
const REFRESH_MS = 30_000;

/** A readable spread of majors, metals and crypto. */
const WANTED = [
  'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'AUDUSD_otc', 'USDCAD_otc',
  'XAUUSD_otc', 'XAGUSD_otc', 'BTCUSD_otc', 'ETHUSD_otc', 'USCrude_otc',
];

const LABELS: Record<string, string> = {
  EURUSD_otc: 'EUR/USD', GBPUSD_otc: 'GBP/USD', USDJPY_otc: 'USD/JPY',
  AUDUSD_otc: 'AUD/USD', USDCAD_otc: 'USD/CAD', XAUUSD_otc: 'GOLD',
  XAGUSD_otc: 'SILVER', BTCUSD_otc: 'BTC/USD', ETHUSD_otc: 'ETH/USD',
  USCrude_otc: 'OIL',
};

interface Quote {
  symbol: string;
  label: string;
  price: number;
  /** Direction vs the previous poll — null until we have two samples. */
  dir: 'up' | 'down' | null;
}

export function LiveTicker() {
  const [quotes, setQuotes] = useState<Quote[]>([]);

  useEffect(() => {
    let cancelled = false;
    let previous: Record<string, number> = {};

    async function load(): Promise<void> {
      try {
        const res = await fetch(`${getProxyUrl().replace(/\/+$/, '')}/api/otc/status`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return;

        const rows = (await res.json()) as Array<{ id?: string; data?: unknown }>;
        const prices = (rows.find((r) => r.id === 'otc_prices')?.data ?? {}) as Record<
          string,
          { p?: number }
        >;

        const next: Quote[] = [];
        const snapshot: Record<string, number> = {};

        for (const symbol of WANTED) {
          const p = prices[symbol]?.p;
          if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) continue;
          snapshot[symbol] = p;
          const before = previous[symbol];
          next.push({
            symbol,
            label: LABELS[symbol] ?? symbol,
            price: p,
            dir: before === undefined || before === p ? null : p > before ? 'up' : 'down',
          });
        }

        previous = snapshot;
        if (!cancelled && next.length > 0) setQuotes(next);
      } catch {
        // A ticker that fails is simply not rendered; it must never block login.
      }
    }

    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (quotes.length === 0) return null;

  // Rendered twice so the marquee wraps seamlessly.
  const row = (keyPrefix: string) =>
    quotes.map((q) => (
      <span key={`${keyPrefix}-${q.symbol}`} className={styles.item}>
        <span className={styles.label}>{q.label}</span>
        <span className={styles.price} dir="ltr">
          {formatPrice(q.price)}
        </span>
        {q.dir && (
          <span className={q.dir === 'up' ? styles.up : styles.down} aria-hidden="true">
            {q.dir === 'up' ? '▲' : '▼'}
          </span>
        )}
      </span>
    ));

  return (
    <div className={styles.ticker} aria-hidden="true">
      <div className={styles.track}>
        {row('a')}
        {row('b')}
      </div>
    </div>
  );
}
