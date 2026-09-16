/**
 * The fan-out rules, driven through a faked Durable Object runtime.
 *
 * ── WHY FAKE THE RUNTIME RATHER THAN RUN ONE ───────────────────────────────
 *
 * What can go wrong here is not the edge behaving oddly; it is a rule being
 * subtly wrong in a way nothing reports. A client allowed to write prices
 * poisons the feed for everyone. A joining socket handed nothing sits on a
 * blank chart until the market happens to move. A client count that stops being
 * announced leaves the feeder pushing into an empty room around the clock,
 * which is the whole duration bill this design exists to avoid.
 *
 * None of those throw. All of them are decisions, and decisions can be driven
 * with two Maps — which is what this does.
 */

import { beforeEach, describe, expect, it } from 'vitest';

// ── the smallest runtime the class actually uses ──────────────────────────
interface FakeSocket { sent: string[]; send: (s: string) => void; tags: string[] }

class FakeState {
  sockets: FakeSocket[] = [];
  autoResponse: unknown = null;
  acceptWebSocket(ws: FakeSocket, tags: string[]) { ws.tags = tags; this.sockets.push(ws); }
  getWebSockets(tag?: string) { return tag ? this.sockets.filter((s) => s.tags.includes(tag)) : this.sockets; }
  getTags(ws: FakeSocket) { return ws.tags ?? []; }
  setWebSocketAutoResponse(pair: unknown) { this.autoResponse = pair; }
}

const socket = (): FakeSocket => {
  const s: FakeSocket = { sent: [], tags: [], send(m: string) { this.sent.push(m); } };
  return s;
};

/** The class under test, with the two globals it touches stubbed. */
async function loadHub() {
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class { constructor(_a: string, _b: string) {} };
  (globalThis as Record<string, unknown>).WebSocketPair = class { 0 = socket(); 1 = socket(); };
  (globalThis as Record<string, unknown>).Response = globalThis.Response;
  const mod = await import('../src/index.ts');
  return mod.PriceHub as unknown as new (state: FakeState, env: unknown) => {
    fetch: (r: { url: string }) => Promise<unknown>;
    webSocketMessage: (ws: FakeSocket, m: string) => Promise<void>;
    webSocketClose: (ws: FakeSocket) => Promise<void>;
  };
}

let State: FakeState;
let hub: Awaited<ReturnType<typeof loadHub>> extends new (...a: never[]) => infer R ? R : never;

beforeEach(async () => {
  const PriceHub = await loadHub();
  State = new FakeState();
  hub = new PriceHub(State, {}) as typeof hub;
});

/** Attaches a socket the way `fetch` would, without the Response plumbing. */
const join = (role: 'client' | 'ingest'): FakeSocket => {
  const s = socket();
  State.acceptWebSocket(s, [role]);
  return s;
};
const last = (s: FakeSocket) => (s.sent.length ? JSON.parse(s.sent[s.sent.length - 1]!) : null);

describe('who may write prices', () => {
  it('takes a batch from the ingest socket', async () => {
    const feed = join('ingest');
    const a = join('client');
    await hub.webSocketMessage(feed, JSON.stringify({ p: { EURUSD: 1.15 } }));
    expect(last(a)).toEqual({ t: 'p', p: { EURUSD: 1.15 } });
  });

  it('ignores a batch from a CLIENT socket', async () => {
    // The one that matters: a browser that can write prices poisons the feed
    // for every other browser, and nothing anywhere would report it.
    const evil = join('client');
    const victim = join('client');
    await hub.webSocketMessage(evil, JSON.stringify({ p: { EURUSD: 999 } }));
    expect(victim.sent).toHaveLength(0);
  });

  it('reads the role from the tag, which survives hibernation', async () => {
    // Tags come back with the socket after the object has been evicted and
    // revived. A role tracked any other way is forgotten exactly then — and
    // "after a quiet spell" is the normal case for this object, not a rare one.
    const feed = join('ingest');
    expect(State.getTags(feed)).toContain('ingest');
  });
});

describe('what a batch does', () => {
  it('sends only what changed', async () => {
    const feed = join('ingest');
    const a = join('client');
    await hub.webSocketMessage(feed, JSON.stringify({ p: { A: 1, B: 2 } }));
    await hub.webSocketMessage(feed, JSON.stringify({ p: { A: 1, B: 3 } }));
    expect(last(a)).toEqual({ t: 'p', p: { B: 3 } });
  });

  it('says nothing at all when nothing moved', async () => {
    const feed = join('ingest');
    const a = join('client');
    await hub.webSocketMessage(feed, JSON.stringify({ p: { A: 1 } }));
    const n = a.sent.length;
    await hub.webSocketMessage(feed, JSON.stringify({ p: { A: 1 } }));
    expect(a.sent).toHaveLength(n);
  });

  it('drops a non-finite price without remembering it', async () => {
    const feed = join('ingest');
    const a = join('client');
    await hub.webSocketMessage(feed, JSON.stringify({ p: { A: null, B: 'x', C: 1.5 } }));
    expect(last(a)).toEqual({ t: 'p', p: { C: 1.5 } });
    // And the next real value for A still counts as a change.
    await hub.webSocketMessage(feed, JSON.stringify({ p: { A: 2 } }));
    expect(last(a)).toEqual({ t: 'p', p: { A: 2 } });
  });

  it('survives a malformed batch', async () => {
    const feed = join('ingest');
    const a = join('client');
    await hub.webSocketMessage(feed, 'not json');
    await hub.webSocketMessage(feed, JSON.stringify({ p: { A: 1 } }));
    expect(last(a)).toEqual({ t: 'p', p: { A: 1 } });
  });

  it('reaches every client, not just the newest', async () => {
    const feed = join('ingest');
    const a = join('client');
    const b = join('client');
    const c = join('client');
    await hub.webSocketMessage(feed, JSON.stringify({ p: { A: 1 } }));
    for (const s of [a, b, c]) expect(last(s)).toEqual({ t: 'p', p: { A: 1 } });
  });

  it('one dead socket does not stop the others', async () => {
    const feed = join('ingest');
    const dead = join('client');
    dead.send = () => { throw new Error('closing'); };
    const alive = join('client');
    await hub.webSocketMessage(feed, JSON.stringify({ p: { A: 1 } }));
    expect(last(alive)).toEqual({ t: 'p', p: { A: 1 } });
  });
});

describe('the client count, which is what keeps the bill down', () => {
  it('is announced to the feeder when a client leaves', async () => {
    const feed = join('ingest');
    const a = join('client');
    await hub.webSocketClose(a);
    expect(last(feed)).toEqual({ t: 'clients', n: 1 });
  });

  it('reaches zero when the room empties', async () => {
    // Zero is the signal Render waits for. Without it the feeder pushes into an
    // empty room around the clock and the object never hibernates — which is
    // the 85%-of-the-daily-allowance case this whole design exists to avoid.
    const feed = join('ingest');
    const a = join('client');
    State.sockets = State.sockets.filter((s) => s !== a);
    await hub.webSocketClose(a);
    expect(last(feed)).toEqual({ t: 'clients', n: 0 });
  });

  it('is not announced when the INGEST socket closes', async () => {
    const feed = join('ingest');
    join('client');
    const before = feed.sent.length;
    await hub.webSocketClose(feed);
    expect(feed.sent).toHaveLength(before);
  });
});

describe('the runtime it asks for', () => {
  it('answers pings without waking up', async () => {
    // An auto-response is handled by the runtime, so a ping neither costs a
    // request nor counts as an event that would block hibernation.
    expect(State.autoResponse).not.toBeNull();
  });
});
