/**
 * euro-trade-price-hub — one upstream connection, one Durable Object, every user.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * Today every browser holds its own WebSocket to Render, and Render sends every
 * one of them the same price. That is the only part of the bill that grows with
 * users. Here Render sends the price ONCE, to one Durable Object, which fans it
 * out — and Cloudflare does not charge for outgoing WebSocket messages, so the
 * fan-out itself is free however many people are watching.
 *
 * ── WHY RENDER STILL HOLDS THE UPSTREAM ────────────────────────────────────
 *
 * The obvious design has the Durable Object connect to the price source itself.
 * Measured, that does not survive the free plan: the source sends 79.9 frames a
 * second for eighteen pairs, which is 6.9 million messages a day. Billed at the
 * documented 20:1 ratio for incoming WebSocket messages that is 345,000
 * requests against a limit of 100,000 — over by three and a half times before a
 * single user connects. And a Durable Object cannot reduce its OWN incoming
 * count; only something in front of it can.
 *
 * So Render keeps the upstream socket it already has, batches to 500 ms, and
 * sends two messages a second instead of eighty. That is 8,640 requests a day,
 * 8.6% of the limit. The batching has to live there, not here.
 *
 * ── AND WHY THAT ALSO FIXES THE DURATION BILL ──────────────────────────────
 *
 * Duration is charged on a fixed 128 MB whatever the object actually uses, so
 * an object that is awake around the clock costs 11,059 GB-s a day against a
 * 13,000 limit — 85%, with no way to shrink it. An OUTBOUND WebSocket would
 * have locked that in, because outgoing sockets cannot hibernate.
 *
 * Every socket here is INBOUND, so all of them hibernate: clients stay
 * connected while the object is not in memory. The object therefore only costs
 * duration while it is actually being fed, and `clients` below is what makes
 * that true — Render is told how many people are listening and sends nothing
 * when the answer is zero. Twelve active hours a day is 42% of the allowance
 * instead of 85%, and a quiet night is very close to nothing.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 *
 * It does not build candles. Those are built and stored by the scraper and
 * served from `/api/otc/candles`, and a second implementation here would be a
 * second source of truth that drifts from the first. This moves the part of the
 * load that grows with users — the live price — and nothing else.
 */

export interface Env {
  PRICE_HUB: DurableObjectNamespace;
  /** Shared secret Render presents on /ingest. A Worker secret, never a var. */
  INGEST_SECRET: string;
}

/** One object, always this name. Never one per pair — that multiplies the bill
 *  by the number of pairs, and the fan-out is free anyway. */
const HUB_NAME = 'prices';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, hub: HUB_NAME });
    }

    if (url.pathname !== '/ws' && url.pathname !== '/ingest') {
      return new Response('not found', { status: 404 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    // Checked HERE, at the edge, so a wrong secret never reaches the object and
    // never costs it a request.
    if (url.pathname === '/ingest' && request.headers.get('x-ingest-secret') !== env.INGEST_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    const id = env.PRICE_HUB.idFromName(HUB_NAME);
    return env.PRICE_HUB.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export class PriceHub implements DurableObject {
  private readonly state: DurableObjectState;
  /** The newest price per symbol, so a socket joining a still market is not
   *  left with a blank chart until something moves. */
  private latest = new Map<string, number>();

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    // Answer protocol pings without waking the object. Incoming pings are not
    // billed and this keeps them from counting as events that block hibernation.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).pathname === '/ingest' ? 'ingest' : 'client';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // `acceptWebSocket`, NOT `server.accept()`. This is the Hibernation API: it
    // is what lets the object leave memory while these sockets stay connected,
    // and it is the whole reason the duration bill tracks usage instead of the
    // clock. `accept()` would keep the object resident for ever.
    this.state.acceptWebSocket(server, [role]);

    if (role === 'client') {
      // Whatever we already know, immediately. Same reason the price fan-out on
      // the proxy hands a new subscriber the last value: a pair that has not
      // moved for two minutes would otherwise show a new chart nothing at all.
      if (this.latest.size > 0) {
        server.send(JSON.stringify({ t: 'snap', p: Object.fromEntries(this.latest) }));
      }
      this.announceClientCount();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Only the ingest socket may write prices. Tags come from `acceptWebSocket`
    // and survive hibernation, so this holds after the object has been evicted
    // and brought back — which is exactly when a role check done any other way
    // would have been forgotten.
    const tags = this.state.getTags(ws);
    if (!tags.includes('ingest')) return;

    let batch: Record<string, number>;
    try {
      const body = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
      batch = body && typeof body === 'object' ? (body.p ?? body) : {};
    } catch {
      return; // one malformed batch costs one batch, never the socket
    }

    const out: Record<string, number> = {};
    let any = false;
    for (const [sym, price] of Object.entries(batch)) {
      // A non-finite price is not a price, and it is not remembered either, so
      // the next real value still reads as a change.
      if (typeof price !== 'number' || !Number.isFinite(price)) continue;
      if (this.latest.get(sym) === price) continue;   // unchanged costs nothing to skip
      this.latest.set(sym, price);
      out[sym] = price;
      any = true;
    }
    if (!any) return;

    const frame = JSON.stringify({ t: 'p', p: out });
    for (const sock of this.state.getWebSockets('client')) {
      // Outgoing messages are free, so this loop is the cheap part however many
      // sockets it runs over. A send that throws is a socket that has gone; the
      // close handler will tidy it.
      try { sock.send(frame); } catch { /* closing */ }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.state.getTags(ws).includes('client')) this.announceClientCount();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (this.state.getTags(ws).includes('client')) this.announceClientCount();
  }

  /**
   * Tells the feeder how many people are listening.
   *
   * This is the message that keeps the duration bill honest: Render sends
   * nothing while the answer is zero, no events reach this object, and after
   * ten quiet seconds it hibernates — with every client still connected. An
   * object fed around the clock costs 85% of the free daily allowance; one fed
   * only while somebody is watching costs a fraction of that.
   *
   * Outgoing messages are not billed, so saying it on every change is free.
   */
  private announceClientCount(): void {
    const n = this.state.getWebSockets('client').length;
    const frame = JSON.stringify({ t: 'clients', n });
    for (const sock of this.state.getWebSockets('ingest')) {
      try { sock.send(frame); } catch { /* closing */ }
    }
  }
}
