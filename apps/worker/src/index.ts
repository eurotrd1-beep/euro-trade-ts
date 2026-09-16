/**
 * euro-trade-cache — edge cache in front of the OTC data proxy.
 *
 * Recovered from the live deployment (the original source had been lost; the
 * bundle pulled back from Cloudflare is kept beside this file as
 * `recovered-bundle.js` and is the parity reference for any change here).
 *
 * Behaviour, unchanged from what is deployed:
 *   • WebSocket upgrades pass straight through, untouched.
 *   • OPTIONS is answered locally with permissive CORS.
 *   • Only the listed GET paths are cached, with per-path TTLs. Everything else
 *     is proxied through with CORS headers added and the body streamed.
 *   • Cached entries are served stale-while-revalidate: fresh under the TTL,
 *     stale (with a background refresh) for a further per-path stale window,
 *     and stale again as a last resort if the origin is unreachable.
 *
 * The stale window is per-path because one of the cached paths feeds the
 * strategy rather than a chart, and stale candles there are a skipped bar
 * rather than a late redraw. See STALE_TTL below.
 */

export interface Env {
  /** Origin the Worker fronts. Set in wrangler.jsonc. */
  ORIGIN_URL: string;
}

/** Cache lifetime per path, in seconds. Paths absent here are never cached. */
const CACHE_TTL: Record<string, number> = {
  '/api/otc/candles': 15,
  '/api/otc/status': 10,
  // ── The last path that made the origin grow with users ──────────────────
  //
  // Every other endpoint here collapses onto one origin fetch however many
  // people are watching. This one did not, and it is called once per candle
  // close per user, so it was the whole of what was left of Render's
  // per-user cost — 0.05 MB an hour each, against zero for everything else.
  //
  // Ten seconds, not fifteen. This is the STRATEGY's input, not a chart's, and
  // the one thing a cache must never do to it is hide a candle close: the
  // program reads the newest closed bar on each tick, and a window served from
  // before that bar existed makes it evaluate the previous one twice and skip
  // the one in between. Ten seconds cannot span a one-minute boundary twice.
  '/api/otc/candles-bulk': 10,
};

/**
 * Extra seconds a stale entry may still be served while it refreshes, per path.
 *
 * Serving stale is right for a chart: sixty-second-old candles draw a chart
 * sixty seconds behind, and the next poll fixes it. It is NOT right for the
 * bulk sweep. A seventy-five-second-old window on a one-minute grid is missing
 * a whole candle, and the strategy reading it would step over that bar without
 * anything reporting a gap — a silent skip in the one place the project is most
 * careful about. So bulk gets none: it is either fresh enough or it goes to the
 * origin.
 */
const STALE_TTL_DEFAULT = 60;
const STALE_TTL: Record<string, number> = {
  '/api/otc/candles-bulk': 0,
};
const staleFor = (path: string): number => STALE_TTL[path] ?? STALE_TTL_DEFAULT;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  // Without this the browser hides both headers from JS. Only seven response
  // headers are readable cross-origin by default and neither of these is among
  // them, so `x-edge-ts` was being set, cached, served — and dropped before any
  // caller could read it. The app judges feed freshness against `x-edge-ts`
  // precisely so it does not have to trust the device clock; see the note on
  // referenceNowSeconds in apps/web/lib/candles.ts.
  'Access-Control-Expose-Headers': 'X-Cache, x-edge-ts, Date',
};

/** Fetches from the origin, stamps it with an edge timestamp, and caches it. */
async function store(target: string, key: Request, cache: Cache): Promise<Response> {
  const resp = await fetch(target);
  if (resp.status !== 200) throw new Error('origin ' + resp.status);

  const body = await resp.arrayBuffer();
  const h = new Headers(resp.headers);
  // Dropped because the body has already been decoded and re-measured.
  h.delete('content-encoding');
  h.delete('content-length');
  h.set('x-edge-ts', String(Date.now()));
  h.set('Cache-Control', 'public, max-age=120');
  for (const k in CORS) h.set(k, CORS[k]!);

  const out = new Response(body, { status: 200, headers: h });
  await cache.put(key, out.clone());
  return out;
}

/** Re-emits a response with CORS and an X-Cache tag (HIT / STALE / MISS). */
function serve(resp: Response, tag: string): Response {
  const h = new Headers(resp.headers);
  for (const k in CORS) h.set(k, CORS[k]!);
  h.set('X-Cache', tag);
  return new Response(resp.body, { status: resp.status, headers: h });
}

/** Streams an uncached origin response straight through, plus CORS. */
function corsStream(resp: Response): Response {
  const h = new Headers(resp.headers);
  for (const k in CORS) h.set(k, CORS[k]!);
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: h,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = (env.ORIGIN_URL || '').replace(/\/+$/, '');
    if (!origin) {
      return new Response('ORIGIN_URL not configured in wrangler.toml', {
        status: 500,
        headers: CORS,
      });
    }

    const url = new URL(request.url);
    const target = origin + url.pathname + url.search;

    // WebSockets cannot be cached or rewritten — hand the request over as-is.
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      return fetch(target, request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const ttl = request.method === 'GET' ? CACHE_TTL[url.pathname] : undefined;
    if (ttl === undefined) {
      return corsStream(await fetch(target, request));
    }

    const cache = caches.default;
    const key = new Request(url.toString(), { method: 'GET' });
    const now = Date.now();
    const hit = await cache.match(key);

    const stale = staleFor(url.pathname);
    if (hit) {
      const age = now - Number(hit.headers.get('x-edge-ts') || 0);
      if (age < ttl * 1000) return serve(hit, 'HIT');
      // `stale` is zero for the bulk sweep, so this branch never runs for it and
      // it falls through to the origin instead of handing the strategy a window
      // that is missing a candle.
      if (stale > 0 && age < (ttl + stale) * 1000) {
        // Serve the stale copy immediately; refresh after the response is sent.
        ctx.waitUntil(store(target, key, cache));
        return serve(hit, 'STALE');
      }
    }

    try {
      return serve(await store(target, key, cache), 'MISS');
    } catch {
      // Origin down: an expired copy still beats an error page.
      if (hit) return serve(hit, 'STALE');
      return new Response(JSON.stringify({ error: 'origin unreachable' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'ERROR', ...CORS },
      });
    }
  },
} satisfies ExportedHandler<Env>;
