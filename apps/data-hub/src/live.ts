/**
 * The replacement for Supabase Realtime.
 *
 * ── WHAT IT REPLACES, AND WHY THAT NEEDED REPLACING AT ALL ─────────────────
 *
 * `realtime.ts` in the app subscribed to Postgres changes on `configs`, `pairs`
 * and `users`, so an admin edit reached every open app at once. D1 has nothing
 * like it — there is no way to be told a row changed — and the note in that
 * file records why the obvious substitute is not one: a 30-second poll
 * re-downloaded everything for every user and burned 5.6 GB in two days.
 *
 * So the push has to come from somewhere, and the only thing that already knows
 * a row changed is the Worker that wrote it.
 *
 * ── WHY A DURABLE OBJECT ───────────────────────────────────────────────────
 *
 * A Worker cannot hold a socket between requests; each invocation is its own
 * world. A Durable Object is a single named instance every request can reach,
 * which is exactly what fan-out needs: one place that knows every open socket.
 *
 * ── WHAT IT COSTS, WHICH IS NOTHING ────────────────────────────────────────
 *
 * Hibernation is the reason. `acceptWebSocket` hands the socket to the runtime,
 * which evicts the object from memory while nothing is happening and brings it
 * back on the next message. An idle connection bills nothing, and OUTGOING
 * messages are not billed at all — so a broadcast to every open app is free.
 *
 * What does bill is incoming messages and connection setup. This design sends
 * nothing inbound but a keepalive, and config changes are an admin editing a
 * form a few times a day. Thirty-one accounts reconnecting ten times a day is
 * ~310 requests against a daily allowance of 100,000.
 *
 * ── WHY THE BROADCAST CARRIES NO DATA ──────────────────────────────────────
 *
 * It says "this row changed", never what it changed to, and the client re-reads
 * through the normal scoped path.
 *
 * That is a security decision, not a bandwidth one. `users` is owner-scoped:
 * one row per account, readable only by that account. A broadcast carrying the
 * row would hand every open browser somebody else's role, VIP expiry and ban
 * state — and this object has no idea who is on the other end of each socket,
 * because a socket is not a credential. Telling everyone only that *an* id
 * changed leaks nothing: a client that re-reads gets its own row or nothing,
 * enforced by the same rules as every other read.
 */

/** What a client is told. Deliberately just enough to know what to re-read. */
export interface ChangeMessage {
  t: 'changed';
  table: string;
  /** The row ids that changed, when the write named them. */
  ids: string[];
}

/**
 * The daily quota, as open apps are told about it.
 *
 * Sent on this socket because this object is NOT D1: when the quota is spent,
 * every D1 query fails until 00:00 UTC, and the one channel that still works is
 * this one. It is also why the app finds out at once, everywhere — rather than
 * each app separately, the next time it happens to make a query.
 */
export type QuotaMessage =
  | { t: 'quota'; limit: 'read' | 'write'; resumes_at: number }
  | { t: 'resumed' };

interface QuotaState {
  limit: 'read' | 'write';
  resumes_at: number;
}

const QUOTA_KEY = 'quota';

/** Tables worth telling anyone about. Everything else is noise. */
export const BROADCAST_TABLES: readonly string[] = [
  'configs', 'pairs', 'users', 'brokers',
  // The admin's review queue. A queued message is worth sending for the length
  // of one trade, so waiting for a refresh to find out it arrived is the same
  // as not getting it.
  'telegram_queue',
];

export class LiveHub implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── A client attaching ──────────────────────────────────────────────
    if (url.pathname === '/connect') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      // Hibernatable: the runtime holds the socket, not this object, so an
      // idle client costs nothing and survives the object being evicted.
      this.state.acceptWebSocket(pair[1]);

      // An app opened DURING a lockout has missed the broadcast. Tell it now,
      // so it does not have to discover the quota by failing a query first.
      const quota = await this.state.storage.get<QuotaState>(QUOTA_KEY);
      if (quota && quota.resumes_at > Date.now()) {
        try {
          pair[1].send(JSON.stringify({ t: 'quota', ...quota } satisfies QuotaMessage));
        } catch {
          // The socket went away between accepting it and writing to it.
        }
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // ── The hub reporting that D1 refused on quota ──────────────────────
    //
    // Broadcast ONCE per lockout. Every failing query in every isolate reports
    // it, and without this check each of them would wake every open app.
    if (url.pathname === '/quota' && request.method === 'POST') {
      const body = (await request.json()) as Partial<QuotaState>;
      const limit = body.limit === 'read' ? 'read' : 'write';
      const resumes_at = Number(body.resumes_at) || 0;
      const current = await this.state.storage.get<QuotaState>(QUOTA_KEY);
      const alreadyKnown = current !== undefined && current.resumes_at === resumes_at;
      if (!alreadyKnown) {
        await this.state.storage.put(QUOTA_KEY, { limit, resumes_at } satisfies QuotaState);
        this.broadcast({ t: 'quota', limit, resumes_at });
      }
      return Response.json({ announced: !alreadyKnown });
    }

    // ── The hub reporting that D1 answers again ─────────────────────────
    if (url.pathname === '/resumed' && request.method === 'POST') {
      const current = await this.state.storage.get<QuotaState>(QUOTA_KEY);
      if (current !== undefined) {
        await this.state.storage.delete(QUOTA_KEY);
        this.broadcast({ t: 'resumed' });
      }
      return Response.json({ announced: current !== undefined });
    }

    if (url.pathname === '/quota-state') {
      const current = await this.state.storage.get<QuotaState>(QUOTA_KEY);
      return Response.json({ quota: current ?? null });
    }

    // ── The Worker reporting a write ────────────────────────────────────
    if (url.pathname === '/publish' && request.method === 'POST') {
      let body: ChangeMessage;
      try {
        body = (await request.json()) as ChangeMessage;
      } catch {
        return new Response('bad json', { status: 400 });
      }
      const payload = JSON.stringify({
        t: 'changed',
        table: String(body.table ?? ''),
        ids: Array.isArray(body.ids) ? body.ids.map(String).slice(0, 50) : [],
      } satisfies ChangeMessage);

      return Response.json({ sent: this.broadcast(payload) });
    }

    return new Response('not found', { status: 404 });
  }

  /** Writes one message to every open socket. Returns how many took it. */
  private broadcast(message: string | QuotaMessage): number {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    let sent = 0;
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
        sent++;
      } catch {
        // A socket that cannot be written to is already gone. Dropping it
        // here would race with the close handler; the runtime cleans up.
      }
    }
    return sent;
  }

  /**
   * The only thing a client may send.
   *
   * Inbound messages are what this design bills for, so there is exactly one
   * and it exists because some proxies close a socket that has been silent for
   * a while. Anything else is ignored rather than parsed — an endpoint that
   * accepts instructions from a browser is an endpoint that has to authorise
   * them, and this one never needs to.
   */
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === 'string' && message === 'ping') {
      try {
        socket.send('pong');
      } catch {
        // Gone mid-flight. Nothing to do.
      }
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    // Nothing to clean up — `getWebSockets()` reflects the runtime's own list.
    void socket; void code; void reason; void wasClean;
  }

  webSocketError(): void {
    // Same.
  }
}
