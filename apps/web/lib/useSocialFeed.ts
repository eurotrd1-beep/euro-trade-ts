'use client';

/**
 * Social win feed — ported from `_startSocialFeed` (signal_engine.dart:2573).
 *
 * A rolling list of fabricated VIP wins, one every 4 seconds, capped at 20.
 * The names, the ids, the profit range and the message format are copied
 * exactly; only the source of randomness differs, which is the point of it.
 *
 * It clears itself when the market is closed, as the original does — a feed of
 * wins while the market is shut would be obviously fake.
 */

import { useEffect, useState } from 'react';

/** Dart: `Timer.periodic(const Duration(seconds: 4), ...)` */
const TICK_MS = 4000;

/** Dart: `if (_socialWinLogs.length > 20) removeLast()` */
const MAX_ENTRIES = 20;

const NAMES = [
  'Tariq', 'Ahmed', 'VIP_Trader', 'FX_King', 'Youssef',
  'Omar', 'Amr', 'Saeed', 'Ziad', 'Karam',
];

const IDS = [
  '2948', '3840', '1947', '8302', '5512',
  '7492', '1093', '6738', '4802', '3819',
];

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export interface UseSocialFeedArgs {
  /** Symbols to draw from — the app's visible pair list. */
  pairs: readonly string[];
  /** Clears and pauses the feed, as `isWeekendClosed` does in Dart. */
  marketClosed: boolean;
}

export function useSocialFeed({ pairs, marketClosed }: UseSocialFeedArgs): string[] {
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    if (marketClosed) {
      setLogs([]);
      return;
    }
    if (pairs.length === 0) return;

    const id = setInterval(() => {
      const name = pick(NAMES);
      const userId = pick(IDS);
      // Dart: `50 + _random.nextInt(250)` → 50..299 inclusive.
      const profit = 50 + Math.floor(Math.random() * 250);
      const asset = pick(pairs).replace(' (OTC)', '');
      const direction = Math.random() < 0.5 ? 'CALL 🟢' : 'PUT 🔴';

      setLogs((prev) =>
        [`VIP ${name} (${userId}***) won +$${profit} on ${asset} ${direction}`, ...prev].slice(
          0,
          MAX_ENTRIES,
        ),
      );
    }, TICK_MS);

    return () => clearInterval(id);
  }, [pairs, marketClosed]);

  return logs;
}
