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
import { buildClick, buildStats, parseStats, statsReadableBy } from './rpc.js';

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
 * WRONG guesses per minute, per address.
 *
 * ── WHAT THIS COUNTS, AND WHAT IT USED TO COUNT ───────────────────────────
 *
 * It counted every request that presented a secret, right or wrong. That
 * throttled the thing it was supposed to protect: `scripts/compare.mjs` asks
 * the hub for nineteen counts in a row with a valid service secret, and the
 * eleventh came back 429. The scraper writing candles for twenty-two pairs
 * would have hit the same wall, in production, as a data outage with no
 * obvious cause.
 *
 * So only FAILED credentials are counted now. A valid secret is never
 * throttled, however fast it arrives, and a wrong one is — which is the only
 * traffic brute force is made of. The check has to come after the comparison
 * rather than before it, which is fine: the comparison is constant-time and
 * reveals nothing on its own.
 *
 * ── WHY NOT THE RATE LIMITING BINDING ─────────────────────────────────────
 *
 * It was, first. wrangler listed it on deploy as "10 requests/60s", and thirty
 * wrong secrets in a row all came back 401 rather than 429. Logging the verdict
 * and tailing the Worker showed fifteen calls, one address, {"success":true}
 * every time: configured, deployed, invoked, enforcing nothing. A protection
 * that reports success while doing nothing is worse than none, because it is
 * the one you stop thinking about.
 *
 * Counted in the cache instead — one entry per address, expiring after a
 * minute. It is per data centre and the increment is not atomic, so a
 * distributed attack gets more than ten a minute. It turns an afternoon into a
 * campaign; it does not make a weak secret strong, and nothing can.
 */
const WRONG_GUESSES_PER_MINUTE = 10;

const limitKey = (request: Request): Request => {
  // Cloudflare sets this and a client cannot forge it. A header the request
  // chose, like x-forwarded-for, would let an attacker reset their own counter
  // by changing one line.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  return new Request(`https://auth-limit.invalid/${encodeURIComponent(ip)}`);
};

/** True when this address has already used up its wrong guesses. */
async function overAuthLimit(request: Request): Promise<boolean> {
  try {
    const seen = await caches.default.match(limitKey(request));
    if (!seen) return false;
    return (Number(await seen.text()) || 0) >= WRONG_GUESSES_PER_MINUTE;
  } catch {
    // A cache that cannot be read must not lock anybody out. Failing open is
    // the right way round: this guards a secret, it is not the secret.
    return false;
  }
}

/** Records one wrong guess. */
async function countWrongGuess(request: Request): Promise<void> {
  try {
    const key = limitKey(request);
    const seen = await caches.default.match(key);
    const count = seen ? (Number(await seen.text()) || 0) : 0;
    await caches.default.put(key, new Response(String(count + 1), {
      headers: { 'Cache-Control': 'max-age=60' },
    }));
  } catch {
    // Unwritable cache: the guess still gets its 401, it just is not counted.
  }
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

    // Identified once, here, and passed down. Doing it per route invited a
    // route that forgot to.
    const caller = identify(request, env);
    if (caller === BAD_SECRET) {
      // Counted and refused. The 429 comes first for an address that has
      // already spent its guesses, so a flood costs the attacker a cache read
      // and nothing more.
      if (await overAuthLimit(request)) return json({ error: 'too many attempts' }, 429);
      await countWrongGuess(request);
      return json({ error: 'bad credential' }, 401);
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

    // ── The two ported Postgres functions ──────────────────────────────────
    //
    // Fixed statements a request supplies values to, which is what a function
    // was. They are separate from the generic path on purpose: "we need one
    // more query" is how a generic path becomes a place to express arbitrary
    // SQL.

    // GET /v1/stats?from=&to=&group_by=&slot=&version=&symbol=
    if (url.pathname === '/v1/stats' && request.method === 'GET') {
      if (!statsReadableBy(caller)) return json({ error: 'not allowed' }, 403);

      const filter = parseStats(url.searchParams);
      if (filter === null) {
        // A malformed date would compare as text against a real one and return
        // a silently wrong range — worse than a refusal, because it looks like
        // an answer.
        return json({ error: 'from and to must be YYYY-MM-DD' }, 400);
      }

      try {
        const { sql, binds } = buildStats(filter);
        const result = await env.DB.prepare(sql).bind(...binds).all();
        return json({ rows: result.results ?? [] });
      } catch (e) {
        console.error('stats failed', e instanceof Error ? e.message : e);
        return json({ error: 'query failed' }, 500);
      }
    }

    // POST /v1/click  { "row": "brokers", "field": "pocketLogins" }
    //
    // The one thing the public may write, and it can only make a number
    // larger by one. `clicks` itself stays service-write.
    if (url.pathname === '/v1/click' && request.method === 'POST') {
      let body: { row?: unknown; field?: unknown };
      try {
        body = (await request.json()) as { row?: unknown; field?: unknown };
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }

      const statement = buildClick(String(body.row ?? ''), String(body.field ?? ''));
      if (statement === null) return json({ error: 'bad counter name' }, 400);

      try {
        await env.DB.prepare(statement.sql).bind(...statement.binds).run();
        return json({ ok: true });
      } catch (e) {
        console.error('click failed', e instanceof Error ? e.message : e);
        return json({ error: 'write failed' }, 500);
      }
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
