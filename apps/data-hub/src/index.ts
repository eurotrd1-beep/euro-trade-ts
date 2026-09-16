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

    // Deliberately says nothing about the database. A health endpoint that
    // reports table names or row counts is a reconnaissance endpoint.
    if (url.pathname === '/health') return json({ ok: true, stage: 0 });

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

    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
