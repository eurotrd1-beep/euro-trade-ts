/**
 * euro-trade-data — the only way into D1.
 *
 * ── STAGE ZERO ─────────────────────────────────────────────────────────────
 *
 * Nothing reads this yet. The app is still on Supabase and stays there until
 * stage two, and every stage after this one keeps a config row that points back.
 * What exists here is the schema, the gate, and the identification of callers —
 * so that the thing being reviewed is the security model, on its own, before
 * any data depends on it.
 *
 * ── THE ONE RULE ───────────────────────────────────────────────────────────
 *
 * There is no path to a table that does not pass `decide()`. Not a shortcut for
 * the admin, not a fast path for the scraper, not a debug endpoint. The moment
 * there are two ways in, the second one is where the hole will be — and the
 * hole this migration is most at risk of repeating was exactly that shape: a
 * table with no policy, reachable because nothing said it was not.
 *
 * ── HOW A CALLER IS IDENTIFIED ─────────────────────────────────────────────
 *
 * From secrets this Worker holds, compared in constant time, and never from
 * anything the request asserts about itself. An `x-account-id` header alone
 * makes you nobody: it is only believed alongside a valid account, and the
 * account can only reach its own rows regardless.
 *
 * ── THE ADMIN CREDENTIAL HAS TO CHANGE, AND THIS IS WHY ────────────────────
 *
 * `lib/adminAuth.ts` is a client-side gate on a statically exported site, and
 * it says so itself. The password hash it ships is sha256('joex') — the
 * username is the password — and it would not matter if it were strong,
 * because the anon key is public and RLS is open: the panel's writes can be
 * made straight against the API without visiting the panel at all. Today
 * anyone on the internet can grant themselves VIP, ban an account, or switch
 * on guaranteed_win.
 *
 * ADMIN_SECRET is what replaces it, and the difference is where it lives. A
 * hash compiled into the bundle is public the moment the bundle ships. A
 * secret held by this Worker is never sent to a browser at all — the admin
 * TYPES it at sign-in, it is kept in that browser only, and it travels as
 * `x-admin-secret` on each request. There is no verify endpoint on purpose:
 * the sign-in form makes a real admin request and keeps the secret only if it
 * is not answered with the 401 above, so this Worker never becomes an oracle
 * that confirms a guess for free.
 *
 * That makes the secret's strength the whole defence, so it is GENERATED, not
 * chosen — `openssl rand -base64 32` — and it is rotated by setting it again
 * with `wrangler secret put`, which signs every admin browser out at once.
 *
 * ── WHAT IS STILL OPEN, STATED PLAINLY ─────────────────────────────────────
 *
 * The panel keeps talking to Supabase until the admin pages move, so the hole
 * above is open until then. It cannot be closed early from the Postgres side:
 * `supabase/migrations/20260810_lock_rls.sql` has the `users` lock written out
 * and deliberately commented, because dropping that policy with the panel
 * still on the anon key takes sign-in and the whole admin down in the same
 * minute. The close and the move are one step, not two.
 */

import { decide, type Caller } from './access.js';
import { buildSelect, buildWrite, parseQuery, type Write } from './db.js';

export interface Env {
  DB: D1Database;
  /** Render and the schedulers. */
  SERVICE_SECRET: string;
  /** The admin panel. */
  ADMIN_SECRET: string;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-account-id, x-admin-secret, x-service-secret',
  'Access-Control-Max-Age': '86400',
};

/**
 * Constant-time compare.
 *
 * `===` on secrets leaks their length and their first differing byte through
 * timing. It is a small leak and an easy one to close, and the alternative is
 * explaining later why it was left open.
 */
function secretEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Returned when a request presents a secret that is wrong.
 *
 * The alternative — quietly treating it as an unidentified browser — is worse
 * than it sounds. The admin panel would ask for the user list, be refused, and
 * render an empty table: the screen for "your credential is wrong" and the
 * screen for "there are no users" would be the same screen. Say which.
 */
export const BAD_SECRET = Symbol('bad-secret');

/**
 * Guesses per minute, per address, against the credential check.
 *
 * ── WHY THIS IS NOT THE RATE LIMITING BINDING ─────────────────────────────
 *
 * It was, first. `ratelimits` in wrangler.jsonc, `env.AUTH_LIMITER.limit()`,
 * and wrangler listed it on deploy as "10 requests/60s". Then thirty guesses in
 * a row from one address all came back 401 rather than 429, so I logged the
 * verdict and tailed it: fifteen calls, one address, `{"success":true}` every
 * single time. The binding is configured, deployed and invoked, and it does not
 * enforce anything on this account.
 *
 * A protection that reports success while doing nothing is worse than none,
 * because it is the one you stop thinking about. So it is counted here instead,
 * in the cache, where it can be watched failing.
 *
 * ── HOW ───────────────────────────────────────────────────────────────────
 *
 * One cache entry per address, holding a count, expiring after a minute. The
 * cache is per data centre and the increment is not atomic, so a determined
 * attacker racing many connections at once will get a few more guesses through
 * than the number below. That is fine: the purpose is to make a million guesses
 * take longer than an afternoon, not to count them exactly.
 *
 * Only requests that PRESENT a secret are counted. A browser reading candles
 * never touches this, so a burst of ordinary traffic cannot lock the admin out
 * — which is the failure that makes people switch rate limits off again.
 */
const AUTH_ATTEMPTS_PER_MINUTE = 10;

async function overAuthLimit(request: Request): Promise<boolean> {
  const presenting = request.headers.has('x-admin-secret') ||
    request.headers.has('x-service-secret');
  if (!presenting) return false;

  // Cloudflare sets this and a client cannot forge it. A header the request
  // chose, like x-forwarded-for, would let an attacker reset their own counter
  // by changing one line.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const key = new Request(`https://auth-limit.invalid/${encodeURIComponent(ip)}`);
  const cache = caches.default;

  let count = 0;
  try {
    const seen = await cache.match(key);
    if (seen) count = Number(await seen.text()) || 0;
  } catch {
    // A cache that cannot be read must not lock anybody out. Failing open is
    // the right way round here: this guards a secret, it is not the secret.
    return false;
  }

  if (count >= AUTH_ATTEMPTS_PER_MINUTE) return true;

  await cache.put(key, new Response(String(count + 1), {
    headers: { 'Cache-Control': `max-age=60` },
  }));
  return false;
}

export function identify(request: Request, env: Env): Caller | typeof BAD_SECRET {
  const service = request.headers.get('x-service-secret');
  if (service) {
    if (!env.SERVICE_SECRET || !secretEquals(service, env.SERVICE_SECRET)) return BAD_SECRET;
    return { kind: 'service' };
  }
  const admin = request.headers.get('x-admin-secret');
  if (admin) {
    if (!env.ADMIN_SECRET || !secretEquals(admin, env.ADMIN_SECRET)) return BAD_SECRET;
    return { kind: 'admin' };
  }
  // An account id is a claim, not a credential — it is what the user typed into
  // a box. It buys exactly one thing: rows scoped to that id. It is never
  // enough to reach anything else, which is why `decide` scopes rather than
  // trusts.
  const account = request.headers.get('x-account-id');
  if (account && /^[A-Za-z0-9_-]{3,64}$/.test(account)) {
    return { kind: 'user', accountId: account };
  }
  return { kind: 'public' };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);

    if (await overAuthLimit(request)) {
      // 429 rather than 401: the credential was not checked at all, and saying
      // "wrong" for a request nobody looked at would be a lie that also tells
      // an attacker their guess was tried.
      return json({ error: 'too many attempts' }, 429);
    }

    // Deliberately says nothing about the database — not the table names, not
    // the row counts, not the migration stage. A health endpoint that reports
    // any of it is a reconnaissance endpoint, and the stage in particular tells
    // an attacker exactly which half of a migration they have found.
    if (url.pathname === '/health') return json({ ok: true });

    // Stage zero exposes ONE thing: what the gate would decide. It reads no
    // data and touches no table — it is here so the access model can be
    // reviewed and tested before anything depends on it.
    if (url.pathname === '/access-check') {
      const table = url.searchParams.get('table') ?? '';
      const op = url.searchParams.get('op') === 'write' ? 'write' : 'read';
      const caller = identify(request, env);
      if (caller === BAD_SECRET) {
        return json({ error: 'bad credential' }, 401);
      }
      const d = decide(table, op, caller);
      return json({
        table,
        op,
        caller: caller.kind,
        allowed: d.allowed,
        reason: d.reason,
        // The scope's VALUE is the caller's own account id, which they supplied.
        // Echoing the column tells a reviewer the rule applied; echoing nothing
        // would make a scoped allow indistinguishable from an open one.
        scopedBy: d.scope?.column ?? null,
      }, d.allowed ? 200 : 403);
    }

    // ── The read path ───────────────────────────────────────────────────────
    //
    // GET /v1/<table>?cols=…&eq=col:value&order=col.desc&limit=n&count=1
    //
    // One route for every table, because the alternative is twenty routes and
    // the twenty-first written in a hurry without the gate. What varies per
    // table is the DECISION, and that already lives in one place.
    const read = url.pathname.match(/^\/v1\/([a-z_]+)$/);
    if (read !== null && request.method === 'GET') {
      const caller = identify(request, env);
      if (caller === BAD_SECRET) return json({ error: 'bad credential' }, 401);

      const built = buildSelect(parseQuery(read[1]!, url.searchParams), caller);
      if (!built.ok) return json({ error: built.reason }, built.status);

      try {
        const result = await env.DB.prepare(built.statement.sql)
          .bind(...built.statement.binds)
          .all();
        return json({ rows: result.results ?? [] });
      } catch (e) {
        // The message is logged, not returned. A SQL error quoted back to the
        // caller describes the schema to whoever provoked it.
        console.error('read failed', read[1], e instanceof Error ? e.message : e);
        return json({ error: 'query failed' }, 500);
      }
    }

    // ── The write path ──────────────────────────────────────────────────────
    //
    // POST /v1/<table>  { "op": "upsert", "values": {…}, "where": [{…}] }
    //
    // The body carries the operation because a write is not a URL: `values`
    // holds a whole trade history in one field, and a query string is the
    // wrong place for it. The gate is the same one.
    if (read !== null && request.method === 'POST') {
      const caller = identify(request, env);
      if (caller === BAD_SECRET) return json({ error: 'bad credential' }, 401);

      let body: Partial<Write>;
      try {
        body = (await request.json()) as Partial<Write>;
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }

      const op = body.op;
      if (op !== 'insert' && op !== 'upsert' && op !== 'update' && op !== 'delete') {
        return json({ error: "op must be insert, upsert, update or delete" }, 400);
      }

      const built = buildWrite({
        table: read[1]!,
        op,
        values: body.values ?? {},
        where: Array.isArray(body.where) ? body.where : [],
      }, caller);
      if (!built.ok) return json({ error: built.reason }, built.status);

      try {
        const result = await env.DB.prepare(built.statement.sql)
          .bind(...built.statement.binds)
          .run();
        // The row count is returned because a write that matched nothing is
        // not an error and not a success — an update whose WHERE found no row
        // reports ok, and a caller that assumes otherwise is storing nothing
        // and believing it stored something.
        return json({ ok: true, rows: result.meta?.changes ?? 0 });
      } catch (e) {
        console.error('write failed', read[1], e instanceof Error ? e.message : e);
        return json({ error: 'write failed' }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
