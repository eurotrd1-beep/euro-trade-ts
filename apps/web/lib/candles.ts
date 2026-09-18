/**
 * OTC candle feed — ported from `_syncEngineCandles` in main_screen.dart.
 *
 * Candles come from the Render proxy through the Cloudflare cache Worker at
 * `/api/otc/candles?symbol=…&interval=…`. The response shape is compact
 * (`o/h/l/c/t`) and `t` is in SECONDS, not milliseconds.
 */

import { getProxyUrl } from './proxyUrl';
import type { Candle } from '@euro/engine';

/**
 * The proxy reports no volume, and the Dart code substitutes a flat 1000 for
 * every candle. Several indicators divide by volume or compare it against its
 * own average, so a constant makes those terms cancel out rather than blow up.
 * Changing it would change signals.
 */
const SYNTHETIC_VOLUME = 1000.0;

/** The longest window the proxy will ever serve — `MAX_CANDLES` in server.js. */
const MAX_WINDOW = 100;

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
 *
 * ── THE WINDOW COMES BACK AS A DELTA, AND IS REASSEMBLED HERE ──────────────
 *
 * This is polled every fifteen seconds and the reply was a hundred candles
 * every time, of which at most one had changed — 1,243 bytes gzipped where 130
 * would do. So it now sends `?since=<t of the newest candle held>` and the
 * proxy replies with that candle and anything after it.
 *
 * The reassembly is deliberately HERE and not in the caller. Everything
 * downstream — the engine binding, the strategy, the chart — is handed the
 * same full, sorted, deduplicated array it has always been handed; only the
 * transport got smaller. Moving the merge into the engine would have made a
 * bandwidth change into a change in what the strategy sees, which is the one
 * thing it must not be.
 *
 * The cache is keyed by symbol AND interval because the app switches both, and
 * a EUR/USD 5m reply merged onto a EUR/USD 1m buffer would interleave two
 * different candle grids into one array that looks sorted and is nonsense.
 */
const lastWindow = new Map<string, Candle[]>();

/** Drops the delta cache — used when a reply says the server rolled past us. */
export function resetCandleCache(): void {
  lastWindow.clear();
}

function parseCandles(raw: readonly RawCandle[]): Candle[] {
  const out: Candle[] = [];
  for (const e of raw) {
    // Any incomplete candle is skipped rather than defaulted — a zeroed OHLC
    // would corrupt every indicator that touches it.
    if (
      typeof e?.o !== 'number' || typeof e.h !== 'number' ||
      typeof e.l !== 'number' || typeof e.c !== 'number' ||
      typeof e.t !== 'number'
    ) continue;
    out.push({ open: e.o, high: e.h, low: e.l, close: e.c, volume: SYNTHETIC_VOLUME, time: e.t * 1000 });
  }
  return out;
}

/**
 * Folds a delta onto the held window.
 *
 * The overlap candle is REPLACED, not kept: it was still forming when we last
 * saw it, so the server's copy is the newer truth for its high, low and close.
 */
function mergeWindow(held: readonly Candle[], delta: readonly Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of held) byTime.set(c.time, c);
  for (const c of delta) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-MAX_WINDOW);
}

export async function fetchCandles(symbol: string, interval: string): Promise<Candle[] | null> {
  if (!symbol) return null;

  const cacheKey = `${symbol}|${interval}`;
  const held = lastWindow.get(cacheKey) ?? null;
  const since = held !== null && held.length > 0 ? Math.trunc(held[held.length - 1]!.time / 1000) : null;

  const base = getProxyUrl().replace(/\/+$/, '');
  const url =
    `${base}/api/otc/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}` +
    (since === null ? '' : `&since=${since}`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status !== 200) return null;

    const body = (await res.json()) as { candles?: RawCandle[]; full?: boolean };
    const raw = body.candles;
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const fresh = parseCandles(raw);
    if (fresh.length === 0) return null;

    // `full !== false` covers both a server that sent the whole window and one
    // too old to know about `since` at all — either way what arrived IS the
    // window, and merging it onto a stale buffer would resurrect candles the
    // server has already rolled off.
    const merged = body.full !== false || held === null ? fresh : mergeWindow(held, fresh);
    lastWindow.set(cacheKey, merged);
    return merged;
  } catch {
    return null;
  }
}

/**
 * Candles for many symbols in one request.
 *
 * The watch scans every enabled pair on each candle close. One request per
 * pair would be 89 connections opening in the same 200ms window, every minute,
 * from every open app — so the proxy grew an endpoint that answers all of them
 * from the map it already holds in memory.
 *
 * Symbols the proxy has no history for are simply absent from the result. The
 * caller treats a missing symbol as "nothing to say about this pair yet",
 * which is also what it does for a pair whose history is too short.
 */
export async function fetchCandlesBulk(
  symbols: readonly string[],
  interval: string,
): Promise<Map<string, Candle[]>> {
  const out = new Map<string, Candle[]>();
  if (symbols.length === 0) return out;

  // ── Each symbol asks from its own newest candle ─────────────────────────
  //
  // Twenty pairs of a hundred candles is ~24 KB gzipped on every candle close,
  // and one candle per pair is new. A single shared `since` could not work:
  // pairs tick at different moments, so their newest candles differ and one
  // timestamp would be wrong for all but one of them. So the list carries a
  // `since` per symbol, and a symbol the cache has never seen is sent plain and
  // comes back whole.
  //
  // Same cache and same merge as `fetchCandles` above, so a pair fetched by
  // either path leaves a window the other can extend.
  const spec = symbols
    .map((sym) => {
      const held = lastWindow.get(`${sym}|${interval}`);
      if (held === undefined || held.length === 0) return sym;
      return `${sym}:${Math.trunc(held[held.length - 1]!.time / 1000)}`;
    })
    .join(',');

  const base = getProxyUrl().replace(/\/+$/, '');
  const url =
    `${base}/api/otc/candles-bulk?symbols=${encodeURIComponent(spec)}` +
    `&interval=${encodeURIComponent(interval)}`;

  try {
    // Longer than the single-symbol timeout: this is one request doing the
    // work of ninety, and failing it early would lose all of them.
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2) });
    if (res.status !== 200) return out;

    const body = (await res.json()) as {
      candles?: Record<string, RawCandle[]>;
      full?: Record<string, boolean>;
    };
    for (const [symbol, raw] of Object.entries(body.candles ?? {})) {
      if (!Array.isArray(raw)) continue;
      const fresh = parseCandles(raw);
      if (fresh.length === 0) continue;

      const cacheKey = `${symbol}|${interval}`;
      const held = lastWindow.get(cacheKey) ?? null;
      // A proxy too old to answer with `full` omits the map entirely, and
      // `body.full?.[symbol]` is then undefined — which must read as "this IS
      // the window", never as a delta. Merging a whole window onto a held one
      // would resurrect candles the server has already rolled off.
      const isDelta = body.full !== undefined && body.full[symbol] === false;
      const merged = isDelta && held !== null ? mergeWindow(held, fresh) : fresh;
      lastWindow.set(cacheKey, merged);
      out.set(symbol, merged);
    }
  } catch {
    /* one failed sweep — the watch tries again on the next candle */
  }
  return out;
}

export interface OtcStatus {
  /**
   * Every symbol's latest price, as the proxy has it.
   *
   * Already in the payload and previously discarded. The watch reads it to
   * see how close a pair is to its level between candles, which is how an
   * alert can arrive before the candle that produces the signal closes.
   */
  prices: Record<string, number>;
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
/**
 * Two pollers, one request.
 *
 * `useOtcStatus` polls this every 20 seconds for the market-open state and the
 * reconnecting banner; the engine's price poll asks the same endpoint every 10
 * for the progress bars. Same URL, same payload, two HTTP round trips — and at
 * 315 bytes of body against 315 bytes of response headers, the SECOND request
 * costs almost exactly what the first one did. That made this the largest
 * single line in the bill once the candle windows became deltas.
 *
 * So the sharing is done here, in the transport, and neither caller changes:
 *
 *   • a request already in flight is joined rather than duplicated — two
 *     callers landing in the same moment share one round trip, with no
 *     staleness at all;
 *   • a result younger than `STATUS_TTL_MS` is reused.
 *
 * The TTL is deliberately just under the faster poller's own interval. The
 * engine's ten-second poll is therefore always served fresh — it is never
 * handed a value it could have fetched itself — while the twenty-second poll,
 * which lands at an arbitrary offset, almost always finds one waiting.
 *
 * Only successes are remembered. A failure returns null and is not cached, so
 * the banner's "two consecutive bad polls" rule still counts two real polls.
 */
const STATUS_TTL_MS = 9000;
let statusAt = 0;
let statusValue: OtcStatus | null = null;
let statusInflight: Promise<OtcStatus | null> | null = null;

/** Drops the shared status result — for tests and for a proxy switch. */
export function resetStatusCache(): void {
  statusAt = 0;
  statusValue = null;
  statusInflight = null;
}

export async function fetchOtcStatus(activeSymbol: string): Promise<OtcStatus | null> {
  if (statusInflight !== null) return statusInflight;
  if (statusValue !== null && Date.now() - statusAt < STATUS_TTL_MS) return statusValue;

  statusInflight = fetchOtcStatusUncached(activeSymbol).then((v) => {
    statusInflight = null;
    if (v !== null) { statusValue = v; statusAt = Date.now(); }
    return v;
  });
  return statusInflight;
}

/**
 * `activeSymbol` only selects which entry the `open`/`healthy`/`nextOpen`
 * fields describe; the prices are every symbol either way. The two callers pass
 * the SAME chart symbol — `page.tsx` hands `chartSymbol` to both — so a shared
 * result describes the pair each of them meant.
 */
async function fetchOtcStatusUncached(activeSymbol: string): Promise<OtcStatus | null> {
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
    const livePrices: Record<string, number> = {};
    for (const [symbol, entry] of Object.entries(prices)) {
      if (typeof entry?.p === 'number') livePrices[symbol] = entry.p;
    }

    return {
      prices: livePrices,
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
