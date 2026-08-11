/**
 * OTC candle feed — ported from `_syncEngineCandles` in main_screen.dart.
 *
 * Candles come from the Render proxy through the Cloudflare cache Worker at
 * `/api/otc/candles?symbol=…&interval=…`. The response shape is compact
 * (`o/h/l/c/t`) and `t` is in SECONDS, not milliseconds.
 */

import { getProxyUrl } from '@euro/shared';
import type { Candle } from '@euro/engine';

/**
 * The proxy reports no volume, and the Dart code substitutes a flat 1000 for
 * every candle. Several indicators divide by volume or compare it against its
 * own average, so a constant makes those terms cancel out rather than blow up.
 * Changing it would change signals.
 */
const SYNTHETIC_VOLUME = 1000.0;

const REQUEST_TIMEOUT_MS = 8000;

interface RawCandle {
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  /** Unix seconds. */
  t?: number;
}

/**
 * Fetches candles for a symbol/interval.
 *
 * Returns `null` — not an empty array — when the fetch fails or the payload is
 * empty, because the caller must KEEP its current buffer in that case. Handing
 * the engine an empty list would wipe the indicator state and produce garbage
 * signals on the next tick.
 */
export async function fetchCandles(symbol: string, interval: string): Promise<Candle[] | null> {
  if (!symbol) return null;

  const base = getProxyUrl().replace(/\/+$/, '');
  const url = `${base}/api/otc/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status !== 200) return null;

    const body = (await res.json()) as { candles?: RawCandle[] };
    const raw = body.candles;
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const candles: Candle[] = [];
    for (const e of raw) {
      // Any incomplete candle is skipped rather than defaulted — a zeroed OHLC
      // would corrupt every indicator that touches it.
      if (
        typeof e?.o !== 'number' || typeof e.h !== 'number' ||
        typeof e.l !== 'number' || typeof e.c !== 'number' ||
        typeof e.t !== 'number'
      ) continue;

      candles.push({
        open: e.o,
        high: e.h,
        low: e.l,
        close: e.c,
        volume: SYNTHETIC_VOLUME,
        time: e.t * 1000,
      });
    }

    return candles.length > 0 ? candles : null;
  } catch {
    return null;
  }
}

export interface OtcStatus {
  /** Per-symbol closed flag, used to lock closed pairs in the asset picker. */
  closedPairs: Record<string, boolean>;
  /** False when the active symbol's last sample is stale — "reconnecting". */
  healthy: boolean;
  /** Unix seconds of the next open for the active symbol, 0 when unknown. */
  nextOpen: number;
  /** Whether the ACTIVE symbol's market is open. */
  open: boolean;
}

/**
 * Anything older than this counts as a real stall.
 *
 * Prices refresh sub-second, but scraper reconnects, proxy redeploys and poll
 * jitter routinely leave the last sample a few seconds old. The Dart comment
 * records that a 20s window "fired the banner constantly"; 60s still catches a
 * genuine outage.
 */
const STALE_AFTER_SECONDS = 60;

/**
 * A reference "now" that is NOT the user's device clock.
 *
 * This is the whole fix for a banner that showed while prices were live and
 * never went away. Sample age was `Date.now() - entry.t`, so a phone whose
 * clock runs two minutes fast makes every sample look two minutes old — for
 * ever, on a feed that is working perfectly. Device clocks are wrong all the
 * time; they are not a thing to measure a server's freshness with.
 *
 * The edge worker stamps `x-edge-ts` when it fetches from the origin: server
 * time, and it accounts for cache age. `Date` is the fallback. Only if both are
 * missing does the feed's own newest sample stand in — that still catches one
 * stalled symbol on a live feed, which is the more common failure anyway.
 */
function referenceNowSeconds(res: Response, newestSample: number): number {
  const edge = Number(res.headers.get('x-edge-ts'));
  if (Number.isFinite(edge) && edge > 0) return Math.floor(edge / 1000);

  const date = Date.parse(res.headers.get('date') ?? '');
  if (Number.isFinite(date) && date > 0) return Math.floor(date / 1000);

  return newestSample;
}

interface OtcPriceEntry {
  /** Last price. */
  p?: number;
  /** Pocket Option open flag. `false` is the ONLY thing that closes a market. */
  po?: boolean;
  /** Sample timestamp, unix seconds. */
  t?: number;
  /** Next open, unix seconds. */
  no?: number;
}

/**
 * Polls `/api/otc/status`.
 *
 * The endpoint returns Supabase-shaped ROWS, not a flat object:
 *   [ { id: 'otc_status', data: {...} }, { id: 'otc_prices', data: { SYMBOL: {...} } } ]
 * Verified against the live proxy — 2 rows, 183 symbols in `otc_prices`.
 */
export async function fetchOtcStatus(activeSymbol: string): Promise<OtcStatus | null> {
  const base = getProxyUrl().replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/otc/status`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;

    const rows = (await res.json()) as Array<{ id?: string; data?: unknown }>;
    if (!Array.isArray(rows)) return null;

    const prices = (rows.find((r) => r.id === 'otc_prices')?.data ?? {}) as Record<
      string,
      OtcPriceEntry
    >;

    const closedPairs: Record<string, boolean> = {};
    for (const [symbol, entry] of Object.entries(prices)) {
      if (entry?.po === false) closedPairs[symbol] = true;
    }

    let newestSample = 0;
    for (const e of Object.values(prices)) {
      if (typeof e?.t === 'number' && e.t > newestSample) newestSample = e.t;
    }

    const entry = prices[activeSymbol];
    const age = referenceNowSeconds(res, newestSample) - (entry?.t ?? 0);

    // A sample stamped in the FUTURE is a clock disagreement, not a stall.
    // Math.abs would be wrong here: only lateness means the feed stopped.
    return {
      closedPairs,
      healthy: entry !== undefined && age < STALE_AFTER_SECONDS,
      nextOpen: entry?.no ?? 0,
      // Only an explicit `false` closes the market — a missing flag means open,
      // so a partial payload never falsely locks the user out.
      open: entry?.po !== false,
    };
  } catch {
    // Keep the previous state: a failed poll must never false-close the market.
    return null;
  }
}

/**
 * Strips an exchange prefix and separators to the bare symbol the proxy wants.
 * Ported from `_bareSymbol()`: "BINANCE:BTC/USDT" → "BTCUSDT".
 */
export function bareSymbol(chartSymbol: string): string {
  let s = chartSymbol;
  const colon = s.indexOf(':');
  if (colon !== -1) s = s.slice(colon + 1);
  return s.replace(/\//g, '').replace(' (OTC)', '').trim();
}
