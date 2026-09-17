'use client';

/**
 * The socket that says a row changed.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * Supabase Realtime. The app subscribed to Postgres changes on `configs`,
 * `pairs` and `users` so an admin edit reached every open app at once, and D1
 * has no equivalent — there is no way to be told a row changed.
 *
 * The note in `realtime.ts` records why polling is not the substitute: a
 * 30-second poll re-downloaded everything for every user and burned 5.6 GB in
 * two days. So the push comes from the only thing that knows a row changed —
 * the Worker that wrote it — through a Durable Object holding one socket per
 * open app.
 *
 * ── WHY IT CARRIES NO DATA ─────────────────────────────────────────────────
 *
 * A message says `{ table, ids }` and nothing else. The listener re-reads
 * through the normal path, which is scoped and authorised like every other
 * read.
 *
 * That is deliberate. `users` is one row per account, readable only by that
 * account; a broadcast carrying the row would hand every open browser somebody
 * else's role, VIP expiry and ban state, because a socket is not a credential
 * and the hub has no idea who is on the other end of one. "Row X changed" leaks
 * nothing — a client that re-reads gets its own row or nothing at all.
 *
 * ── AND WHY A RECONNECT RE-READS EVERYTHING ────────────────────────────────
 *
 * Messages sent while the socket was down are gone; nothing is queued for a
 * client that is not there. So the reconnect handler tells every listener to
 * refetch, which turns "we missed an edit" into "we were a few seconds late"
 * rather than "this screen is wrong until it is reloaded".
 */

import { reportQuota, reportResumed } from './quota';

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Some proxies close a socket that has been silent; this is cheaper than that. */
const PING_MS = 45_000;

export interface Change {
  table: string;
  ids: string[];
}

type ChangeListener = (change: Change) => void;
/** Called after a reconnect, when anything may have been missed. */
type ResyncListener = () => void;

const changeListeners = new Set<ChangeListener>();
const resyncListeners = new Set<ResyncListener>();

let socket: WebSocket | null = null;
let retry = RETRY_MIN_MS;
let ping: ReturnType<typeof setInterval> | null = null;
let url = '';
/** True once a connection has succeeded, so the first connect is not a "resync". */
let everConnected = false;
let stopped = false;

/** Told where the hub is, once, by the same config that sets the data source. */
export function configureLive(hubUrl: string): void {
  const next = (hubUrl || '').replace(/\/+$/, '');
  if (next === url) return;
  url = next;
  // A changed address means the old socket is pointing at the wrong place.
  if (socket) {
    const old = socket;
    socket = null;
    try { old.close(); } catch { /* already gone */ }
  }
  if (url && (changeListeners.size > 0 || resyncListeners.size > 0)) connect();
}

function connect(): void {
  if (stopped || socket || !url) return;
  if (typeof WebSocket === 'undefined') return;

  let ws: WebSocket;
  try {
    ws = new WebSocket(`${url.replace(/^http/, 'ws')}/v1/live`);
  } catch {
    scheduleRetry();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    retry = RETRY_MIN_MS;
    if (ping) clearInterval(ping);
    ping = setInterval(() => {
      try { ws.send('ping'); } catch { /* the close handler will deal with it */ }
    }, PING_MS);

    // Anything could have changed while this client was away. The first
    // connection is not a resync — the callers have just done their own initial
    // read — but every one after it is.
    if (everConnected) for (const fn of [...resyncListeners]) fn();
    everConnected = true;
  };

  ws.onmessage = (event) => {
    let msg: { t?: string; table?: string; ids?: unknown; resumes_at?: unknown };
    try {
      msg = JSON.parse(String(event.data)) as typeof msg;
    } catch {
      return; // 'pong', or anything else that is not ours.
    }
    // The daily quota. This socket is served by a Durable Object, not by D1,
    // which is why it still works during a lockout — and why every open app
    // hears about it at once instead of each discovering it on a failed read.
    if (msg.t === 'quota') { reportQuota(Number(msg.resumes_at)); return; }
    if (msg.t === 'resumed') { reportResumed(); return; }
    if (msg.t !== 'changed' || typeof msg.table !== 'string') return;
    const change: Change = {
      table: msg.table,
      ids: Array.isArray(msg.ids) ? msg.ids.map(String) : [],
    };
    for (const fn of [...changeListeners]) {
      try { fn(change); } catch { /* one bad listener must not stop the rest */ }
    }
  };

  const closed = (): void => {
    if (ping) { clearInterval(ping); ping = null; }
    if (socket === ws) {
      socket = null;
      scheduleRetry();
    }
  };
  ws.onclose = closed;
  ws.onerror = closed;
}

function scheduleRetry(): void {
  if (stopped || changeListeners.size + resyncListeners.size === 0) return;
  const wait = retry;
  // Doubling, capped. A hub that is down must not be hammered by every open
  // app at once — and the app keeps working meanwhile, because every screen
  // already has the value it read at startup.
  retry = Math.min(retry * 2, RETRY_MAX_MS);
  setTimeout(connect, wait);
}

/** Listens for changes. Returns the unsubscribe. */
export function onChange(fn: ChangeListener): () => void {
  changeListeners.add(fn);
  connect();
  return () => {
    changeListeners.delete(fn);
    maybeClose();
  };
}

/** Listens for "you were disconnected, refetch". Returns the unsubscribe. */
export function onResync(fn: ResyncListener): () => void {
  resyncListeners.add(fn);
  connect();
  return () => {
    resyncListeners.delete(fn);
    maybeClose();
  };
}

function maybeClose(): void {
  if (changeListeners.size + resyncListeners.size > 0) return;
  if (ping) { clearInterval(ping); ping = null; }
  const old = socket;
  socket = null;
  try { old?.close(); } catch { /* already gone */ }
}

/** For tests, and for a clean teardown. Permanent — nothing reconnects after it. */
export function stopLive(): void {
  stopped = true;
  maybeClose();
}

/**
 * Drops the socket and lets it come back, as if the connection had failed.
 *
 * For the health screen's "it is not updating, kick it" button. That button
 * used to call `stopLive()`, which is permanent: the socket closed and never
 * returned, so the repair made things strictly worse. This closes the socket
 * the same way a network drop would, which the close handler answers with a
 * reconnect and a resync.
 */
export function restartLive(): void {
  retry = RETRY_MIN_MS;
  const old = socket;
  if (old) {
    try { old.close(); } catch { /* already gone */ }
  } else {
    connect();
  }
}
