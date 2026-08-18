/**
 * One tab runs the strategy — G1.
 *
 * Without this, two tabs of one account hold two independent copies of the same
 * program state and both write the same `localStorage` key. Both tick the same
 * pair on the same candle, so both open a trade on it, and whichever writes its
 * cycle second erases the other's. A cycle erased between a loss and its
 * martingale is a recovery trade that never happens with nothing reporting it.
 *
 * The lease is what makes that impossible, so what is tested is the property
 * itself — never two owners — plus the two ways it has to recover: a tab that
 * dies without releasing, and two tabs claiming in the same instant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireWatchLease } from '@/lib/watchLease';

const KEY = 'watch_owner';

/** A `localStorage` that behaves like one, since the tests run in node. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
  return store;
}

/** `pagehide` is registered on window; node has none. */
function installWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener: () => undefined, removeEventListener: () => undefined },
  });
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 260));

describe('watch lease', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installStorage();
    installWindow();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the lease to the only tab asking for it', async () => {
    const lease = acquireWatchLease(() => undefined);
    await settle();
    expect(lease.owned).toBe(true);
    lease.stop();
  });

  it('never lets two tabs own it at once', async () => {
    // The whole point. Two claim together; exactly one may end up owning.
    const a = acquireWatchLease(() => undefined);
    const b = acquireWatchLease(() => undefined);
    await settle();

    const owners = [a.owned, b.owned].filter(Boolean).length;
    expect(owners, 'two tabs both believed they were the watcher').toBe(1);

    a.stop();
    b.stop();
  });

  it('a second tab stays a spectator while the first holds it', async () => {
    const a = acquireWatchLease(() => undefined);
    await settle();
    expect(a.owned).toBe(true);

    const b = acquireWatchLease(() => undefined);
    await settle();
    expect(b.owned, 'a second tab took a lease that was live').toBe(false);

    a.stop();
    b.stop();
  });

  it('takes over from a tab that died without releasing', async () => {
    // The case a lock could not survive: a tab killed by the OS, discarded
    // under memory pressure, or on a phone that ran out of battery. None of
    // those run a cleanup handler, and a held-for-ever lock would leave the
    // account permanently unwatched.
    store.set(KEY, JSON.stringify({ id: 'a-tab-that-is-gone', at: Date.now() - 60_000 }));

    const lease = acquireWatchLease(() => undefined);
    await settle();
    expect(lease.owned, 'an expired claim kept the lease from being taken').toBe(true);
    lease.stop();
  });

  it('does not take over from a tab that is merely busy', async () => {
    // A recent heartbeat means alive. Stealing on a slow frame would hand a
    // live cycle to a tab with no idea it is mid-trade.
    store.set(KEY, JSON.stringify({ id: 'a-live-tab', at: Date.now() - 2000 }));

    const lease = acquireWatchLease(() => undefined);
    await settle();
    expect(lease.owned).toBe(false);
    lease.stop();
  });

  it('hands the lease on when a tab closes cleanly', async () => {
    const a = acquireWatchLease(() => undefined);
    await settle();
    expect(a.owned).toBe(true);
    a.stop();

    const b = acquireWatchLease(() => undefined);
    await settle();
    expect(b.owned, 'a released lease was not picked up').toBe(true);
    b.stop();
  });

  it('reports the change so the UI can say which tab is working', async () => {
    const seen: boolean[] = [];
    const lease = acquireWatchLease((owned) => seen.push(owned));
    await settle();
    expect(seen).toContain(true);
    lease.stop();
  });

  it('watches anyway when there is no storage to coordinate through', async () => {
    // A private window with one tab is the common case. Refusing to watch there
    // would break the app for the sake of a conflict that cannot happen.
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
    const lease = acquireWatchLease(() => undefined);
    expect(lease.owned).toBe(true);
    lease.stop();
  });
});
