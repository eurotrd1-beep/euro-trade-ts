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

/**
 * Consecutive bad polls before the banner appears.
 *
 * The banner makes a claim about the price provider, so it should take more
 * than one sample to make it: a single 8s timeout while a phone changes cell
 * tower is not an outage. Two in a row is 20+ seconds of nothing, which is.
 *
 * Recovery is deliberately NOT hysteretic — the first good poll clears it at
 * once. Being slow to say "there is a problem" is caution; being slow to say
 * "it is fixed" is a stuck banner, which is the bug this exists to end.
 */
const UNHEALTHY_AFTER = 2;

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
    let badPolls = 0;

    async function poll(): Promise<void> {
      const s: OtcStatus | null = await fetchOtcStatus(activeSymbol);
      if (cancelled) return;

      // A failed poll used to freeze the whole state, which is how the banner
      // got stuck on: one unhealthy reading followed by fetches that never
      // landed left it showing for ever. It still must not false-CLOSE the
      // market — closedPairs and open keep their last known values — but the
      // health flag has to keep moving, because a fetch that will not complete
      // IS the problem the banner describes.
      if (s === null) {
        badPolls++;
        if (badPolls >= UNHEALTHY_AFTER) {
          setStatus((prev) => (prev.healthy ? { ...prev, healthy: false } : prev));
        }
        return;
      }

      if (!s.healthy) {
        badPolls++;
        // Below the threshold, take everything EXCEPT the verdict — the pair
        // list and market state are still good, only the claim is premature.
        setStatus(badPolls >= UNHEALTHY_AFTER ? s : { ...s, healthy: true });
        return;
      }

      badPolls = 0;
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
