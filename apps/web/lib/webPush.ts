'use client';

/**
 * Web Push — being told about a setup with the app closed.
 *
 * ── WHY THIS IS NOT THE NOTIFICATION THE APP ALREADY HAD ───────────────────
 *
 * `signalNotify.ts` shows a notification from a running page. That is the
 * right tool while the app is open and the wrong one for what was asked: the
 * user wants to be told about a forming setup while the browser is shut. A
 * page that is not running cannot notice anything, cannot fetch a candle and
 * cannot raise a notification.
 *
 * So there are two halves and neither of them is here. A service worker, which
 * the browser can wake on its own, receives the message and shows it. And the
 * proxy generator, which already evaluates every pair every minute around the
 * clock with the same engine, decides when to send. This file is only the
 * handshake between them: ask permission, register the worker, hand the
 * resulting subscription to the proxy, and undo all of it on request.
 *
 * ── THE KEY ────────────────────────────────────────────────────────────────
 *
 * Subscribing needs the PUBLIC half of the server's VAPID pair, which is
 * public by design — it identifies the sender and can do nothing on its own.
 * It is fetched from the proxy rather than built into the app so that rotating
 * the pair is an environment change on one service instead of a rebuild and
 * redeploy of the front end. The private half never leaves the server.
 */

import { getProxyUrl } from '@euro/shared';

/** What the button needs to know to draw itself. */
export type PushState =
  | 'unsupported' // no service worker or no push API — an old browser, or http
  | 'unavailable' // the server has no keys, so nothing could ever be sent
  | 'denied' // the user said no, and only browser settings can undo that
  | 'off'
  | 'on';

const base = (): string => getProxyUrl().replace(/\/+$/, '');

/**
 * The chosen pairs, remembered on this device.
 *
 * The server holds the authoritative copy — it is what decides who gets sent
 * what — but the picker has to open showing the current choice, and asking the
 * proxy for it would mean an endpoint that hands a subscription's settings to
 * anyone who knows its endpoint string. Kept here instead, and `null` means
 * every pair.
 */
const CHOICE_KEY = 'push_symbols';

export function storedSymbols(): string[] | null {
  try {
    const raw = localStorage.getItem(CHOICE_KEY);
    if (raw === null || raw === 'all') return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

function rememberSymbols(symbols: string[] | null): void {
  try {
    localStorage.setItem(CHOICE_KEY, symbols === null ? 'all' : JSON.stringify(symbols));
  } catch {
    /* private mode — the server copy is the one that matters */
  }
}

/**
 * Where the worker lives.
 *
 * The app is served from a sub-path on GitHub Pages, and a worker's scope can
 * never be broader than its own URL — one at the domain root would be rejected
 * outright, and one registered without the prefix would 404. Both come from
 * the base path the build was made with.
 */
function workerUrl(): string {
  const prefix = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return `${prefix}/sw.js`;
}

function scope(): string {
  const prefix = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return `${prefix}/`;
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** The VAPID public key, or null when the server cannot send at all. */
async function serverKey(): Promise<string | null> {
  try {
    const res = await fetch(`${base()}/api/push/key`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { available?: boolean; key?: string };
    return body.available === true && body.key ? body.key : null;
  } catch {
    return null;
  }
}

/**
 * The key as the browser wants it: raw bytes, not base64url text.
 *
 * `applicationServerKey` takes a Uint8Array. Passing the string works in some
 * browsers and throws in others, which is the kind of difference that only
 * shows up on somebody else's phone.
 */
function decodeKey(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register(workerUrl(), { scope: scope() });
  } catch {
    return null;
  }
}

/** What state the button should show, without changing anything. */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';

  const key = await serverKey();
  if (key === null) return 'unavailable';

  try {
    const reg = await navigator.serviceWorker.getRegistration(scope());
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub === null ? 'off' : 'on';
  } catch {
    return 'off';
  }
}

/**
 * Turns notifications on. Returns the state to show afterwards.
 *
 * The permission prompt is only raised from here, i.e. from a real click. A
 * browser asked on page load denies permanently in some versions and the user
 * can then only undo it in settings — so it is asked once, at the moment they
 * have just said they want it.
 */
export async function enablePush(
  accountId: string | null,
  plan: string,
  symbols: string[] | null,
): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';

  const key = await serverKey();
  if (key === null) return 'unavailable';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';

  const reg = await registration();
  if (reg === null) return 'unsupported';

  // Wait for it to be in control. Subscribing against a worker that is still
  // installing produces a subscription the browser drops on the next reload.
  await navigator.serviceWorker.ready;

  let sub: PushSubscription;
  try {
    const existing = await reg.pushManager.getSubscription();
    sub =
      existing ??
      (await reg.pushManager.subscribe({
        // Required by every browser that implements this: a push that cannot
        // be shown to the user is not allowed to be delivered silently.
        userVisibleOnly: true,
        applicationServerKey: decodeKey(key) as BufferSource,
      }));
  } catch {
    return 'off';
  }

  try {
    const res = await fetch(`${base()}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), accountId, plan, symbols }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // The browser would now hold a subscription the server has no record of
      // and would never send to. Undone rather than left as a button that says
      // "on" and does nothing.
      await sub.unsubscribe().catch(() => undefined);
      return 'off';
    }
  } catch {
    await sub.unsubscribe().catch(() => undefined);
    return 'off';
  }

  rememberSymbols(symbols);
  return 'on';
}

/**
 * Turns them off, on both sides.
 *
 * The server is told first. If only the browser forgot, the endpoint would
 * keep working and the user would keep receiving notifications they had just
 * switched off, with nothing left on their side to switch off again.
 */
export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  try {
    const reg = await navigator.serviceWorker.getRegistration(scope());
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub === null) return 'off';

    await fetch(`${base()}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => undefined);

    await sub.unsubscribe().catch(() => undefined);
    return 'off';
  } catch {
    return 'off';
  }
}

/**
 * Keeps the stored account and plan current for an already-on subscription.
 *
 * A user enables notifications before logging in, or upgrades to paid, and the
 * row would otherwise keep whatever was true the day they pressed the button.
 * Silent and best-effort: it must never interrupt anything.
 */
export async function refreshPush(
  accountId: string | null,
  plan: string,
  symbols: string[] | null,
): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.getRegistration(scope());
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub === null) return;
    await fetch(`${base()}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), accountId, plan, symbols }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best effort */
  }
}
