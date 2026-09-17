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
import {
  MAX_ROWS_PER_WRITE, buildSelect, buildWrite, parseFilters, parseQuery, type Write,
} from './db.js';
import { buildClick, buildStats, parseStats, statsReadableBy } from './rpc.js';
import { countWrites, shouldShed } from './budget.js';
import { BROADCAST_TABLES, LiveHub } from './live.js';
import { prune } from './prune.js';
import {
  expiresAt, planPrune, planRecord, planRefreshDaily, planResolve, utcDay,
  type IncomingSignal, type Resolution,
} from './pipeline.js';

export interface Env {
  DB: D1Database;
  /** Render and the schedulers. */
  SERVICE_SECRET: string;
  /**
   * The incoming secret during a rotation, accepted alongside SERVICE_SECRET.
   *
   * A secret cannot be changed in one step without an outage: the moment the
   * Worker stops accepting the old one, the proxy holding it stops being able
   * to record a signal, and it stays that way until somebody edits an
   * environment variable on another service. Accepting both for the length of
   * the handover turns that into no window at all.
   *
   * It is empty except during a rotation, and `secretEquals` is never called
   * with an empty expectation — an unset variable must not match an empty
   * header.
   */
  SERVICE_SECRET_NEXT?: string;
  /** The admin panel. */
  ADMIN_SECRET: string;
  /** The live channel every open app is attached to. */
  LIVE: DurableObjectNamespace;
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
    // Both are checked, and both with the constant-time compare — short
    // circuiting on the first would leak which of the two matched through
    // timing, which is the whole thing `secretEquals` exists to prevent.
    const current = Boolean(env.SERVICE_SECRET) && secretEquals(service, env.SERVICE_SECRET);
    const next = Boolean(env.SERVICE_SECRET_NEXT)
      && secretEquals(service, env.SERVICE_SECRET_NEXT!);
    if (!current && !next) return BAD_SECRET;
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

export { LiveHub };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    // ── The signal pipeline ────────────────────────────────────────────────
    //
    // Four endpoints, service-only, mirroring the four Postgres functions the
    // proxy calls. They write the published record — what a trade's outcome
    // was and what the statistics say — so there is no caller below `service`
    // and no way to reach them with an account id.
    if (url.pathname.startsWith('/v1/pipeline/')) {
      if (caller.kind !== 'service') return json({ error: 'service only' }, 403);

      // ── The signals still waiting to be settled ──────────────────────────
      //
      // A GET, and the only one under /v1/pipeline. It exists because the
      // settlement pass has to look in the database the signals were RECORDED
      // to: reading Supabase while recording to D1 left every signal pending
      // for ever, and nothing reported it, because a pass that finds nothing
      // is indistinguishable from one with nothing to find.
      if (url.pathname === '/v1/pipeline/pending' && request.method === 'GET') {
        try {
          const result = await env.DB.prepare(
            `SELECT "id", "symbol", "direction", "entry_price", "bar_ms", "expiry_seconds"` +
            ` FROM "signals" WHERE "outcome" = 'pending' ORDER BY "id" LIMIT 500`,
          ).all();
          return json({ rows: result.results ?? [] });
        } catch (e) {
          console.error('pending failed', e instanceof Error ? e.message : e);
          return json({ error: 'query failed' }, 500);
        }
      }

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }

      try {
        // ── record: insert a batch, or refuse it whole ────────────────────
        if (url.pathname === '/v1/pipeline/record') {
          const rows = (Array.isArray(body['rows']) ? body['rows'] : []) as IncomingSignal[];
          const day = utcDay(Date.now());

          await env.DB.prepare(
            'INSERT INTO "signal_write_budget" ("day") VALUES (?) ON CONFLICT ("day") DO NOTHING',
          ).bind(day).run();
          const budget = await env.DB.prepare(
            'SELECT "written", "max_rows" FROM "signal_write_budget" WHERE "day" = ?',
          ).bind(day).first<{ written: number; max_rows: number }>();

          const plan = planRecord(rows, budget ?? { written: 0, max_rows: 20000 });

          if (plan.kind === 'empty') {
            return json({ inserted: 0, skipped: 0, capped: false, remaining: 0, ids: [] });
          }
          if (plan.kind === 'capped') {
            await env.DB.prepare(
              'UPDATE "signal_write_budget" SET "capped" = 1 WHERE "day" = ?',
            ).bind(day).run();
            return json({
              inserted: 0, skipped: plan.skipped, capped: true,
              remaining: plan.remaining, ids: [],
            });
          }

          // One statement per row rather than one batch, because the ids of
          // the rows that actually landed have to come back — a row skipped by
          // ON CONFLICT must not appear in the list the caller schedules
          // settlements from.
          const ids: unknown[] = [];
          let inserted = 0;
          for (let i = 0; i < plan.statements.length; i++) {
            const st = plan.statements[i]!;
            const res = await env.DB.prepare(st.sql).bind(...st.binds).run();
            if ((res.meta?.changes ?? 0) === 0) continue;
            inserted++;
            const row = rows[i]!;
            const createdMs = st.binds[st.binds.length - 1] as number;
            ids.push({
              id: res.meta?.last_row_id,
              symbol: row.symbol,
              entry_price: row.entry_price,
              expires_at: expiresAt(createdMs, row.expiry_seconds),
            });
          }

          await env.DB.prepare(
            'UPDATE "signal_write_budget" SET "written" = "written" + ? WHERE "day" = ?',
          ).bind(inserted, day).run();

          const b = budget ?? { written: 0, max_rows: 20000 };
          return json({
            inserted,
            skipped: rows.length - inserted,
            capped: false,
            remaining: b.max_rows - b.written - inserted,
            ids,
          });
        }

        // ── resolve: settle, once, only what is still pending ─────────────
        if (url.pathname === '/v1/pipeline/resolve') {
          const rows = (Array.isArray(body['rows']) ? body['rows'] : []) as Resolution[];
          const now = Date.now();
          let settled = 0;
          for (const st of planResolve(rows, now)) {
            const res = await env.DB.prepare(st.sql).bind(...st.binds).run();
            settled += res.meta?.changes ?? 0;
          }
          return json({ settled });
        }

        // ── refresh: rebuild the aggregate for a range ────────────────────
        if (url.pathname === '/v1/pipeline/refresh') {
          const from = String(body['from'] ?? '');
          const to = String(body['to'] ?? '');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            return json({ error: 'from and to must be YYYY-MM-DD' }, 400);
          }
          const st = planRefreshDaily(from, to);
          const res = await env.DB.prepare(st.sql).bind(...st.binds).run();
          // "changed", not "touched" — see the note in pipeline.ts.
          return json({ changed: res.meta?.changes ?? 0 });
        }

        // ── prune: aggregate first, then delete ──────────────────────────
        if (url.pathname === '/v1/pipeline/prune') {
          const keepDays = Number(body['keep_days'] ?? 30);
          if (!Number.isFinite(keepDays) || keepDays < 1) {
            return json({ error: 'keep_days must be a positive number' }, 400);
          }
          const plan = planPrune(keepDays, Date.now());
          // The summary of what is about to be deleted is made final BEFORE
          // the delete. The other order leaves those days permanently short,
          // and they read as a quiet week rather than a missing one.
          await env.DB.prepare(plan.refresh.sql).bind(...plan.refresh.binds).run();
          const res = await env.DB.prepare(plan.del.sql).bind(...plan.del.binds).run();
          return json({ deleted: res.meta?.changes ?? 0, cut: plan.cutDay });
        }

        return json({ error: 'not found' }, 404);
      } catch (e) {
        console.error('pipeline', url.pathname, e instanceof Error ? e.message : e);
        return json({ error: 'pipeline failed' }, 500);
      }
    }

    // ── The live channel ────────────────────────────────────────────────────
    //
    // Open to anyone, and it does not need to be anything else: the only thing
    // that crosses it is "row X of table Y changed". Nothing about a row's
    // CONTENTS is sent, so a listener learns nothing it could not learn by
    // watching the admin panel from across the room — and to actually read the
    // row it still has to satisfy the same rules as any other read.
    //
    // One named instance, so every app in the world lands on the same object.
    if (url.pathname === '/v1/live') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ error: 'expected a websocket upgrade' }, 426);
      }
      const id = env.LIVE.idFromName('global');
      return env.LIVE.get(id).fetch(new Request('https://live/connect', request));
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

      // ── One row, or many ────────────────────────────────────────────────
      //
      // A `values` array is the asset scan upserting the whole catalogue. Each
      // row is built and AUTHORISED separately — the array is a transport
      // convenience, never a way to smuggle a row past the checks — and the
      // statements are then applied as one batch.
      const rows = Array.isArray(body.values) ? body.values : [body.values ?? {}];
      if (rows.length === 0) return json({ error: 'nothing to write' }, 400);
      if (rows.length > MAX_ROWS_PER_WRITE) {
        return json(
          { error: `${rows.length} rows, over the ${MAX_ROWS_PER_WRITE} allowed in one write` },
          400,
        );
      }
      const where = parseFilters(body.where);

      // ── The budget, before the work ─────────────────────────────────────
      //
      // Candle writes are refused once the day is 80% spent, so the rest of
      // the budget belongs to rows that cannot be rebuilt. The scraper treats
      // a refusal the way it treats any failed save: it logs and keeps the
      // candles in memory, which is where they already are.
      //
      // 429 rather than 403 — this is "not now", not "not allowed", and the
      // distinction matters to anyone reading the log at 3am.
      // ── Temporary: who is writing? ──────────────────────────────────────
      //
      // Two proxy instances are recording signals into this database and only
      // one is accounted for. A service write carries the same secret whoever
      // sends it, so the credential cannot tell them apart — but the source
      // address and colo can, and they are on every request already.
      //
      // Remove once the second writer is found and stopped.
      if (caller.kind === 'service') {
        const cf = (request as Request & { cf?: { colo?: string } }).cf;
        console.log(
          `svc-write table=${read[1]} ip=${request.headers.get('cf-connecting-ip') ?? '?'} ` +
          `colo=${cf?.colo ?? '?'} ua=${(request.headers.get('user-agent') ?? '-').slice(0, 40)}`,
        );
      }

      const budget = await shouldShed(read[1]!);
      if (budget.shed) {
        console.warn(
          `shed ${read[1]} write: ${budget.used} rows today, ` +
          `${(budget.fraction * 100).toFixed(0)}% of the daily limit`,
        );
        return json({
          error: 'daily write budget reserved for the signal pipeline',
          used: budget.used,
        }, 429);
      }

      const statements = [];
      for (const values of rows) {
        if (typeof values !== 'object' || values === null || Array.isArray(values)) {
          return json({ error: 'each row must be an object' }, 400);
        }
        const built = buildWrite(
          { table: read[1]!, op, values: values as Record<string, unknown>, where },
          caller,
        );
        if (!built.ok) return json({ error: built.reason }, built.status);
        statements.push(env.DB.prepare(built.statement.sql).bind(...built.statement.binds));
      }

      try {
        // `batch` runs them in one round trip and in one transaction, so a
        // catalogue upsert either lands whole or not at all. A loop of `run`
        // could leave the scan half-applied with no way to tell which half.
        const results = await env.DB.batch(statements);
        // The row count is returned because a write that matched nothing is
        // not an error and not a success — an update whose WHERE found no row
        // reports ok, and a caller that assumes otherwise is storing nothing
        // and believing it stored something.
        const changes = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
        // Counted after the fact, from what D1 reports it actually wrote — an
        // UPDATE that matched nothing costs nothing and should not be charged.
        ctx.waitUntil(countWrites(changes));

        // ── Tell the open apps ────────────────────────────────────────────
        //
        // Only when rows actually changed. An upsert that wrote the same values
        // reports `changes: 0`, and waking every phone to re-read a row that is
        // identical is the kind of chatter that made the old subscription
        // expensive in the first place.
        //
        // `waitUntil`, so a slow or failed broadcast cannot turn a successful
        // write into a failed request. The app's own read is the source of
        // truth; this is a nudge, and a missed nudge costs a stale screen until
        // the next one, not a lost write.
        if (changes > 0 && BROADCAST_TABLES.includes(read[1]!)) {
          const ids = rows
            .map((r) => (r as Record<string, unknown>)?.['id'])
            .filter((v): v is string | number => v !== undefined && v !== null)
            .map(String);
          const fromWhere = where
            .flatMap((f) => (f.values ? f.values : f.value !== undefined ? [f.value] : []))
            .map(String);
          ctx.waitUntil(
            env.LIVE.get(env.LIVE.idFromName('global')).fetch('https://live/publish', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                t: 'changed',
                table: read[1],
                ids: [...new Set([...ids, ...fromWhere])].slice(0, 50),
              }),
            }).then(() => undefined, () => undefined),
          );
        }

        return json({ ok: true, rows: changes });
      } catch (e) {
        console.error('write failed', read[1], e instanceof Error ? e.message : e);
        return json({ error: 'write failed' }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  },

  /**
   * Retention, on a timer.
   *
   * ── WHY THE WORKER AND NOT THE PROXY ───────────────────────────────────
   *
   * The proxy calls Postgres's prune functions today, so the obvious move was
   * to have it call these too. It is the wrong home: the proxy is a process
   * that can be down, redeploying, or asleep on a free dyno, and retention
   * that stops running is invisible — the tables simply keep growing, and the
   * first symptom is a storage or row-read limit reached weeks later.
   *
   * A Cron Trigger runs whether or not anything else is up, and it is the only
   * part of this migration that has no request behind it at all.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const results = await prune(env.DB);
      for (const r of results) {
        // Logged per table rather than as a total. A prune that deletes
        // nothing because a column name is wrong looks identical to one that
        // deletes nothing because there was nothing to delete, unless the
        // error is named.
        if (r.error) console.error(`prune ${r.table} failed: ${r.error}`);
        else if (r.deleted > 0) console.log(`prune ${r.table}: ${r.deleted}`);
      }
    })());
  },
} satisfies ExportedHandler<Env>;
