var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var CACHE_TTL = {
  "/api/otc/candles": 5,
  // seconds
  "/api/otc/status": 10
  // seconds
};
var STALE_TTL = 60;
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};
var worker_default = {
  async fetch(request, env, ctx) {
    const origin = (env.ORIGIN_URL || "").replace(/\/+$/, "");
    if (!origin) {
      return new Response("ORIGIN_URL not configured in wrangler.toml", {
        status: 500,
        headers: CORS
      });
    }
    const url = new URL(request.url);
    const target = origin + url.pathname + url.search;
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      return fetch(target, request);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const ttl = request.method === "GET" ? CACHE_TTL[url.pathname] : void 0;
    if (ttl === void 0) {
      const resp = await fetch(target, request);
      return corsStream(resp);
    }
    const cache = caches.default;
    const key = new Request(url.toString(), { method: "GET" });
    const now = Date.now();
    const hit = await cache.match(key);
    if (hit) {
      const age = now - Number(hit.headers.get("x-edge-ts") || 0);
      if (age < ttl * 1e3) return serve(hit, "HIT");
      if (age < (ttl + STALE_TTL) * 1e3) {
        ctx.waitUntil(store(target, key, cache));
        return serve(hit, "STALE");
      }
    }
    try {
      const fresh = await store(target, key, cache);
      return serve(fresh, "MISS");
    } catch (_) {
      if (hit) return serve(hit, "STALE");
      return new Response(JSON.stringify({ error: "origin unreachable" }), {
        status: 502,
        headers: { "Content-Type": "application/json", "X-Cache": "ERROR", ...CORS }
      });
    }
  }
};
async function store(target, key, cache) {
  const resp = await fetch(target);
  if (resp.status !== 200) throw new Error("origin " + resp.status);
  const body = await resp.arrayBuffer();
  const h = new Headers(resp.headers);
  h.delete("content-encoding");
  h.delete("content-length");
  h.set("x-edge-ts", String(Date.now()));
  h.set("Cache-Control", "public, max-age=120");
  for (const k in CORS) h.set(k, CORS[k]);
  const out = new Response(body, { status: 200, headers: h });
  await cache.put(key, out.clone());
  return out;
}
__name(store, "store");
function serve(resp, tag) {
  const h = new Headers(resp.headers);
  for (const k in CORS) h.set(k, CORS[k]);
  h.set("X-Cache", tag);
  return new Response(resp.body, { status: resp.status, headers: h });
}
__name(serve, "serve");
function corsStream(resp) {
  const h = new Headers(resp.headers);
  for (const k in CORS) h.set(k, CORS[k]);
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: h
  });
}
__name(corsStream, "corsStream");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
