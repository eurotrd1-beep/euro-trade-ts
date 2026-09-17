/**
 * The socket that replaced Supabase Realtime.
 *
 * Two things here fail silently if they are wrong, and both are about MISSED
 * messages rather than delivered ones:
 *
 *   a reconnect that does not refetch — the screen stays wrong until reload,
 *     because nothing is queued for a client that was not connected
 *   a retry that does not back off — every open app hammering a hub that is
 *     already down
 *
 * Delivery itself is the easy case and is tested too, but it is the one that
 * would be noticed in a minute.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A WebSocket that does nothing until a test tells it to. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.onclose?.(); }

  open(): void { this.onopen?.(); }
  deliver(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }); }
  drop(): void { this.onclose?.(); }
}

vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);

/**
 * Re-imported for every test, on purpose.
 *
 * The client is a singleton by design — one socket shared by every watcher in
 * the app — so it keeps `everConnected`, the retry delay and the socket itself
 * at module level. That is right for the app and wrong for a test file, where
 * the second test would inherit the first one's connection history and
 * "reconnect" would look like "connect". Resetting the module registry is
 * cheaper and more honest than exposing a reset function that only tests call.
 */
let live: typeof import('../lib/live.js');

const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]!;

beforeEach(async () => {
  FakeSocket.instances.length = 0;
  vi.useFakeTimers();
  vi.resetModules();
  live = await import('../lib/live.js');
  live.configureLive('https://hub.example.com');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connecting', () => {
  it('opens a websocket at the hub, not an http url', () => {
    const off = live.onChange(() => {});
    expect(latest().url).toBe('wss://hub.example.com/v1/live');
    off();
  });

  it('opens one socket for many listeners', () => {
    const a = live.onChange(() => {});
    const b = live.onChange(() => {});
    const c = live.onResync(() => {});
    expect(FakeSocket.instances).toHaveLength(1);
    a(); b(); c();
  });

  it('closes when the last listener leaves', () => {
    const off = live.onChange(() => {});
    const socket = latest();
    off();
    expect(socket.closed).toBe(true);
  });

  it('does nothing at all without a hub url', () => {
    live.configureLive('');
    FakeSocket.instances.length = 0;
    const off = live.onChange(() => {});
    expect(FakeSocket.instances).toHaveLength(0);
    off();
  });
});

describe('delivery', () => {
  it('passes a change to every listener', () => {
    const seen: unknown[] = [];
    const a = live.onChange((c) => seen.push(['a', c]));
    const b = live.onChange((c) => seen.push(['b', c]));
    latest().open();
    latest().deliver({ t: 'changed', table: 'configs', ids: ['promo'] });
    expect(seen).toEqual([
      ['a', { table: 'configs', ids: ['promo'] }],
      ['b', { table: 'configs', ids: ['promo'] }],
    ]);
    a(); b();
  });

  it('ignores anything that is not a change', () => {
    const seen: unknown[] = [];
    const off = live.onChange((c) => seen.push(c));
    latest().open();
    latest().onmessage?.({ data: 'pong' });
    latest().deliver({ t: 'something-else', table: 'configs' });
    latest().deliver({ t: 'changed' });
    expect(seen).toEqual([]);
    off();
  });

  it('survives a listener that throws', () => {
    const seen: unknown[] = [];
    const bad = live.onChange(() => { throw new Error('boom'); });
    const good = live.onChange((c) => seen.push(c));
    latest().open();
    latest().deliver({ t: 'changed', table: 'pairs', ids: [] });
    expect(seen).toHaveLength(1);
    bad(); good();
  });
});

describe('a reconnect has to refetch', () => {
  it('does NOT call resync on the first connection', () => {
    // The caller has just done its own initial read; calling it again would be
    // a duplicate query on every app start.
    let resyncs = 0;
    const off = live.onResync(() => { resyncs++; });
    latest().open();
    expect(resyncs).toBe(0);
    off();
  });

  it('calls resync after a drop and reconnect', () => {
    // Nothing is queued for a client that was not connected, so anything that
    // changed while it was away is simply gone. Without this the screen stays
    // wrong until the page is reloaded.
    let resyncs = 0;
    const off = live.onResync(() => { resyncs++; });
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(1000);
    latest().open();
    expect(resyncs).toBe(1);
    off();
  });
});

describe('retrying', () => {
  it('backs off instead of hammering', () => {
    const off = live.onChange(() => {});
    latest().open();

    const waits: number[] = [];
    let before = FakeSocket.instances.length;
    for (let i = 0; i < 4; i++) {
      latest().drop();
      // Find the delay by advancing until a new socket appears.
      let waited = 0;
      while (FakeSocket.instances.length === before && waited < 60_000) {
        vi.advanceTimersByTime(250);
        waited += 250;
      }
      waits.push(waited);
      before = FakeSocket.instances.length;
    }
    // Each wait at least as long as the one before, and growing.
    expect(waits[1]).toBeGreaterThan(waits[0]!);
    expect(waits[3]).toBeGreaterThan(waits[1]!);
    off();
  });

  it('stops retrying once nobody is listening', () => {
    const off = live.onChange(() => {});
    latest().open();
    off();
    const count = FakeSocket.instances.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(count);
  });
});

describe('keepalive', () => {
  it('pings so an idle socket is not closed under it', () => {
    const off = live.onChange(() => {});
    latest().open();
    vi.advanceTimersByTime(46_000);
    expect(latest().sent).toContain('ping');
    off();
  });
});
