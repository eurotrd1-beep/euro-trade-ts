/**
 * The live object's part in the quota pause.
 *
 * A real D1 quota cannot be produced on demand, so the object is driven
 * directly with a stand-in for its state. What matters is exactly the behaviour
 * that cannot be seen until midnight on a bad day:
 *
 *   every failing query reports the quota, and every open app must be told ONCE
 *   an app opened during the lockout must be told on connect
 *   `resumed` must go out once, and only if a lockout was recorded
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** WebSocketPair exists only in the Workers runtime. */
class FakeWs {
  sent: string[] = [];
  send(m: string): void { this.sent.push(m); }
}
vi.stubGlobal('WebSocketPair', class {
  0 = new FakeWs();
  1 = new FakeWs();
});

/**
 * The Workers runtime lets a Response carry status 101 and a `webSocket`;
 * Node's does not accept 101 at all. The object's own logic is what is under
 * test here, so the constructor is relaxed for this one status.
 */
const RealResponse = globalThis.Response;
vi.stubGlobal('Response', class extends RealResponse {
  constructor(body: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
  }
  static json(data: unknown, init?: ResponseInit): Response {
    return RealResponse.json(data, init);
  }
});

const { LiveHub } = await import('../src/live.js');

function makeHub() {
  const store = new Map<string, unknown>();
  const sockets: FakeWs[] = [];
  const state = {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => { store.set(k, v); },
      delete: async (k: string) => store.delete(k),
    },
    acceptWebSocket: (ws: FakeWs) => { sockets.push(ws); },
    getWebSockets: () => sockets,
  };
  const hub = new LiveHub(state as never);
  const post = (path: string, body?: unknown) =>
    hub.fetch(new Request(`https://live${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  const connect = async (): Promise<FakeWs> => {
    await hub.fetch(new Request('https://live/connect', { headers: { Upgrade: 'websocket' } }));
    return sockets[sockets.length - 1]!;
  };
  const messages = (ws: FakeWs) => ws.sent.map((m) => JSON.parse(m) as { t: string });
  return { hub, post, connect, messages, store };
}

const RESET = Date.UTC(2099, 0, 1);

describe('announcing the lockout', () => {
  let h: ReturnType<typeof makeHub>;
  beforeEach(() => { h = makeHub(); });

  it('tells every open app', async () => {
    const a = await h.connect();
    const b = await h.connect();
    await h.post('/quota', { limit: 'write', resumes_at: RESET });
    expect(h.messages(a)).toEqual([{ t: 'quota', limit: 'write', resumes_at: RESET }]);
    expect(h.messages(b)).toEqual([{ t: 'quota', limit: 'write', resumes_at: RESET }]);
  });

  it('tells them ONCE, however many queries report it', async () => {
    // Every failing query in every isolate reports the quota. Without the
    // dedupe, each of them would wake every open app.
    const a = await h.connect();
    for (let i = 0; i < 20; i++) await h.post('/quota', { limit: 'write', resumes_at: RESET });
    expect(h.messages(a)).toHaveLength(1);
  });

  it('tells an app that connects DURING the lockout, on connect', async () => {
    await h.post('/quota', { limit: 'read', resumes_at: RESET });
    const late = await h.connect();
    expect(h.messages(late)).toEqual([{ t: 'quota', limit: 'read', resumes_at: RESET }]);
  });

  it('says nothing on connect when there is no lockout', async () => {
    const ws = await h.connect();
    expect(ws.sent).toEqual([]);
  });

  it('says nothing on connect for a lockout that has already expired', async () => {
    // A stale record must not put the pause screen up on a healthy day.
    await h.post('/quota', { limit: 'write', resumes_at: Date.now() - 1000 });
    const ws = await h.connect();
    expect(ws.sent).toEqual([]);
  });

  it('announces again for a NEW day', async () => {
    const a = await h.connect();
    await h.post('/quota', { limit: 'write', resumes_at: RESET });
    await h.post('/quota', { limit: 'write', resumes_at: RESET + 86_400_000 });
    expect(h.messages(a)).toHaveLength(2);
  });
});

describe('announcing the end', () => {
  let h: ReturnType<typeof makeHub>;
  beforeEach(() => { h = makeHub(); });

  it('tells every open app once, and clears the record', async () => {
    const a = await h.connect();
    await h.post('/quota', { limit: 'write', resumes_at: RESET });
    await h.post('/resumed');
    await h.post('/resumed');
    expect(h.messages(a).map((m) => m.t)).toEqual(['quota', 'resumed']);
    expect(h.store.size).toBe(0);
  });

  it('says nothing if there was no lockout', async () => {
    // The recovery check only runs while one is recorded, but the object must
    // not broadcast a resume for an outage nobody was told about.
    const a = await h.connect();
    await h.post('/resumed');
    expect(a.sent).toEqual([]);
  });

  it('lets a later connect see a healthy state', async () => {
    await h.post('/quota', { limit: 'write', resumes_at: RESET });
    await h.post('/resumed');
    const ws = await h.connect();
    expect(ws.sent).toEqual([]);
  });
});

describe('the recorded state', () => {
  it('is readable for the recovery check', async () => {
    const h = makeHub();
    const empty = await (await h.hub.fetch(new Request('https://live/quota-state'))).json();
    expect(empty).toEqual({ quota: null });
    await h.post('/quota', { limit: 'read', resumes_at: RESET });
    const set = await (await h.hub.fetch(new Request('https://live/quota-state'))).json();
    expect(set).toEqual({ quota: { limit: 'read', resumes_at: RESET } });
  });

  it('coerces an unexpected limit to write rather than storing junk', async () => {
    const h = makeHub();
    await h.post('/quota', { limit: 'nonsense', resumes_at: RESET });
    const set = await (await h.hub.fetch(new Request('https://live/quota-state'))).json() as {
      quota: { limit: string };
    };
    expect(set.quota.limit).toBe('write');
  });
});
