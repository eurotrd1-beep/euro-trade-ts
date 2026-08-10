'use client';

/**
 * Market status polling — ported from `_pollMarketStatus` in main_screen.dart.
 *
 * Drives three things: which pairs the picker locks, the "reconnecting" banner,
 * and the market-closed state the engine is told about.
 */

import { useEffect, useState } from 'react';
import { fetchOtcStatus, type OtcStatus } from './candles';

/** Dart polls on this cadence. */
const POLL_MS = 20_000;

export interface MarketStatus {
  closedPairs: Record<string, boolean>;
  /** False when the feed has stalled — shows the reconnecting banner. */
  healthy: boolean;
  /** Whether the ACTIVE pair's market is open. Optimistic until the first poll. */
  open: boolean;
  nextOpen: number;
}

const INITIAL: MarketStatus = {
  closedPairs: {},
  healthy: true,
  // Optimistic default, as in Dart: never show a closed market before we know.
  open: true,
  nextOpen: 0,
};

export function useOtcStatus(activeSymbol: string, enabled: boolean): MarketStatus {
  const [status, setStatus] = useState<MarketStatus>(INITIAL);

  useEffect(() => {
    if (!enabled || !activeSymbol) return;
    let cancelled = false;

    async function poll(): Promise<void> {
      const s: OtcStatus | null = await fetchOtcStatus(activeSymbol);
      // null means the poll failed — keep the previous state rather than
      // false-closing the market on a network blip.
      if (cancelled || s === null) return;
      setStatus(s);
    }

    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeSymbol, enabled]);

  return status;
}
