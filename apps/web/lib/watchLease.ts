'use client';

/**
 * One tab runs the strategy. The rest watch.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 *
 * A program's state — the open cycle, the armed setup, the fired keys — lives
 * in `localStorage`, and `useSignalEngine` reads it ONCE per pair and then
 * keeps its own copy in memory. Two tabs of the same account therefore hold two
 * independent copies of the same state machine and both write to the same key.
 *
 * What that produces is not a cosmetic problem. Both tabs tick the same pair on
 * the same candle, so both can open a trade on it in the same minute — two
 * entries in the history for one setup. Both then write their own cycle to the
 * shared key, so whichever finishes second erases the other's, and a cycle
 * erased between the loss and the martingale is a recovery trade that simply
 * never happens with nothing anywhere reporting it.
 *
 * The app had no cross-tab coordination of any kind: no `BroadcastChannel`, no
 * `storage` listener, nothing.
 *
 * ── THE FIX, AND WHY IT IS A LEASE ─────────────────────────────────────────
 *
 * A lease rather than a lock, because a lock needs releasing and a browser tab
 * is not a thing that can be relied upon to release anything. It is killed by
 * the OS, discarded under memory pressure, or loses its device to a flat
 * battery, and none of those run a cleanup handler. A lock would then be held
 * by a tab that no longer exists and the account would go quiet for ever.
 *
 * So ownership is a claim with a heartbeat, and it expires. The owner rewrites
 * its timestamp every few seconds; any tab that sees a stale timestamp takes
 * over. The worst case is a gap of one expiry window with nobody watching,
 * which is a missed candle — recoverable, and vastly preferable to a duplicate
 * trade or a lost martingale.
 *
 * The claim is a compare-and-set through `localStorage`, which is not atomic.
 * Two tabs claiming in the same instant can both believe they won, so a claim
 * is re-read after a short settle and the tab whose id is not there stands
 * down. That leaves a window of milliseconds where two tabs think they are the
 * owner; the tick interval is seconds, so it closes long before either acts.
 */

const KEY = 'watch_owner';

/** How long a claim stays valid without a heartbeat. */
const TTL_MS = 12_000;

/** How often the owner renews. Comfortably inside the TTL so a slow frame does
 *  not cost it the lease. */
const BEAT_MS = 4000;

/** How long to wait before believing a contested claim. */
const SETTLE_MS = 120;

interface Claim {
  id: string;
  at: number;
}

/** Distinct per tab, and per reload — two reloads of one tab are two claimants. */
function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.trunc(Math.random() * 1e9)}`;
  }
}

function read(): Claim | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const { id, at } = parsed as Partial<Claim>;
    return typeof id === 'string' && typeof at === 'number' ? { id, at } : null;
  } catch {
    return null;
  }
}

function write(claim: Claim): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(claim));
  } catch {
    /* private mode, or full. `available` handles it. */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WatchLease {
  /** True while this tab is the one allowed to run the strategy. */
  readonly owned: boolean;
  /** Stops renewing and hands the lease on, if it is held. */
  release(): void;
  /** Cancels everything. Called on unmount. */
  stop(): void;
}

/**
 * Claims the lease if it is free or expired, and keeps it while it is held.
 *
 * `onChange` fires whenever ownership flips, so the UI can say which tab is
 * doing the work rather than looking broken in the ones that are not.
 */
export function acquireWatchLease(onChange: (owned: boolean) => void): WatchLease {
  const id = newId();
  let owned = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const available = typeof localStorage !== 'undefined';

  const set = (next: boolean): void => {
    if (owned === next) return;
    owned = next;
    onChange(next);
  };

  /**
   * With no `localStorage` there is nothing to coordinate through, and the
   * choice is between one tab working and none. One tab working is right: a
   * private window with a single tab is the common case, and refusing to watch
   * there would break the app for the sake of a conflict that cannot be
   * detected anyway.
   */
  if (!available) {
    set(true);
    return { get owned() { return owned; }, release() {}, stop() {} };
  }

  async function tryClaim(): Promise<void> {
    if (stopped) return;

    const held = read();
    const fresh = held !== null && Date.now() - held.at < TTL_MS;

    if (fresh && held.id !== id) {
      set(false);
      return;
    }

    // Free, expired, or already ours.
    write({ id, at: Date.now() });

    // `localStorage` has no compare-and-set, so two tabs can write in the same
    // instant and both read back their own value. Re-reading after a settle
    // resolves it: the later write is the one that stuck, and the tab that did
    // not stick stands down.
    if (!fresh) {
      await sleep(SETTLE_MS);
      if (stopped) return;
      const after = read();
      if (after === null || after.id !== id) {
        set(false);
        return;
      }
    }

    set(true);
  }

  function beat(): void {
    if (stopped) return;
    if (owned) {
      // Renewed unconditionally rather than after re-reading: if another tab
      // has taken the lease, the check below on the next non-owner pass will
      // notice. Re-reading here would let a single slow frame cost the lease
      // and hand a live cycle to a tab that has no idea it is mid-trade.
      const held = read();
      if (held !== null && held.id !== id && Date.now() - held.at < TTL_MS) {
        set(false);
        return;
      }
      write({ id, at: Date.now() });
      return;
    }
    void tryClaim();
  }

  void tryClaim();
  timer = setInterval(beat, BEAT_MS);

  /**
   * Handing it over on the way out is a courtesy, not the mechanism. It saves
   * the other tabs one TTL of waiting when a tab closes cleanly; when it does
   * not close cleanly, the expiry is what covers it.
   */
  const onLeave = (): void => {
    if (!owned) return;
    const held = read();
    if (held !== null && held.id === id) {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* nothing to do */
      }
    }
  };
  window.addEventListener('pagehide', onLeave);

  return {
    get owned() {
      return owned;
    },
    release() {
      onLeave();
      set(false);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      window.removeEventListener('pagehide', onLeave);
      onLeave();
    },
  };
}
