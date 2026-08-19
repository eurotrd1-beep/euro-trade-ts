'use client';

/**
 * Signal notifications — the entry in the phone's notification shade, or the
 * desktop notification on the web.
 *
 * Two delivery paths, tried in order:
 *
 *  1. Capacitor's LocalNotifications plugin. This is the one that reaches the
 *     ANDROID SHADE, which is what the web `Notification` API cannot reliably
 *     do from inside a WebView. It is looked up on `window.Capacitor.Plugins`
 *     at runtime rather than imported, so the web bundle does not depend on a
 *     package the browser build has no use for — and it starts working the
 *     moment the plugin is installed in apps/mobile.
 *  2. The standard web Notification API, for the browser and PWA.
 *
 * Both are best-effort. A signal is never blocked on a notification.
 */

interface LocalNotificationsPlugin {
  schedule(options: {
    notifications: Array<{
      id: number;
      title: string;
      body: string;
    }>;
  }): Promise<unknown>;
  requestPermissions(): Promise<{ display: string }>;
  checkPermissions(): Promise<{ display: string }>;
}

function capacitorPlugin(): LocalNotificationsPlugin | null {
  try {
    const cap = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
    const plugin = cap?.Plugins?.['LocalNotifications'];
    return (plugin as LocalNotificationsPlugin | undefined) ?? null;
  } catch {
    return null;
  }
}

function webNotificationsAvailable(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** True once notifications can actually be shown. */
export async function notificationsAllowed(): Promise<boolean> {
  const plugin = capacitorPlugin();
  if (plugin) {
    try {
      return (await plugin.checkPermissions()).display === 'granted';
    } catch {
      return false;
    }
  }
  if (!webNotificationsAvailable()) return false;
  return Notification.permission === 'granted';
}

/**
 * Asks for permission. Must be called from a user gesture — pressing the
 * signal button is where this happens — or browsers reject it silently.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const plugin = capacitorPlugin();
  if (plugin) {
    try {
      return (await plugin.requestPermissions()).display === 'granted';
    } catch {
      return false;
    }
  }
  if (!webNotificationsAvailable()) return false;
  try {
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** Android needs a distinct id per notification, or each replaces the last. */
let nextId = 1;

/**
 * ── ONE SWITCH ─────────────────────────────────────────────────────────────
 *
 * There were two ways to be told about a setup and only one of them had a
 * control: the notification while the app is closed had a switch, and the one
 * raised by the running page had none and always fired. So "turn off
 * notifications" turned off half of them, and the half it left was the half the
 * user was most likely to be looking at anyway.
 *
 * The switch now means all of them. It is stored rather than derived from the
 * push subscription because the two can disagree for reasons that have nothing
 * to do with what the user wants: a browser that cannot do push at all, a
 * permission refused in settings, a subscription the server dropped. In every
 * one of those the page can still raise a notification, and whether it should
 * is this answer and not theirs.
 *
 * Default off. An app that starts notifying somebody who never asked it to is
 * the reason browsers made the permission one-shot in the first place.
 */
const ALERTS_KEY = 'alerts_enabled';

export function alertsEnabled(): boolean {
  try {
    return localStorage.getItem(ALERTS_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAlertsEnabled(on: boolean): void {
  try {
    localStorage.setItem(ALERTS_KEY, on ? '1' : '0');
  } catch {
    /* private mode; the session keeps working, it just will not be remembered */
  }
}

export function notify(title: string, body: string): void {
  // Checked here rather than at each call site: there are several, and one that
  // forgot would be a notification arriving after the user switched them off,
  // which is the exact complaint this exists to prevent.
  if (!alertsEnabled()) return;

  const plugin = capacitorPlugin();
  if (plugin) {
    void plugin
      .schedule({
        // No smallIcon: the plugin falls back to the app icon, and naming a
        // drawable that does not exist in res/ shows a blank square instead.
        notifications: [{ id: nextId++, title, body }],
      })
      .catch(() => {
        // Permission not granted, or the plugin is unavailable.
      });
    return;
  }

  if (!webNotificationsAvailable()) return;
  try {
    if (Notification.permission === 'granted') new Notification(title, { body });
  } catch {
    // Some browsers throw for constructor use outside a service worker.
  }
}


// ── The notification ladder ─────────────────────────────────────────────────
//
// The same three rungs the proxy sends over Web Push, for the notifications
// this app raises locally. Both have to agree: a phone gets the browser's
// notification and the pushed one, and two different accounts of the same
// moment is worse than either alone.
//
//   ⚠️ The other implementation is `push-alerts.js` in euro-trade-proxy. The
//   rule is small enough to state in one line — a rung is sent only if it is
//   HIGHER than the highest already sent for that setup — and that line has to
//   read the same in both places.
//
// What it replaces: a message when a setup was ADOPTED, which is halfway up
// the scale and usually comes to nothing, and one when price REACHED the level
// saying the trade would open on the next candle. The second stopped being
// true when ‹A10› and ‹A11› arrived — reaching the level is no longer a
// promise, the candle also has to close past it, and most do not.

export const ALERT_NEAR = 96;
export const ALERT_VERY_CLOSE = 98;
export const ALERT_FIRED = 100;

const LADDER_KEY = 'alert_ladder';

/** symbol → { key: the setup, highest: the top rung already sent }. */
type Ladder = Record<string, { key: string; highest: number }>;

/**
 * Persisted, so a reload does not re-announce an opportunity in progress.
 *
 * The proxy's copy of this is a table with a primary key, because it has to
 * survive a redeploy. Here the equivalent hazard is the user refreshing the
 * page mid-candle, and `localStorage` is the same idea at the right size.
 */
function readLadder(): Ladder {
  try {
    const raw = localStorage.getItem(LADDER_KEY);
    return raw ? (JSON.parse(raw) as Ladder) : {};
  } catch {
    return {};
  }
}

function writeLadder(l: Ladder): void {
  try {
    localStorage.setItem(LADDER_KEY, JSON.stringify(l));
  } catch {
    /* private mode: the ladder falls back to per-session, which still stops
       the ordinary repeats */
  }
}

/** The message a rung puts on a lock screen. Short, and never overstated. */
function messageFor(stage: number, name: string, percent: number): [string, string] {
  if (stage === ALERT_FIRED) {
    return [`إشارة بدأت — ${name}`, `🚨 اتفتحت إشارة الآن — ${name}`];
  }
  const pct = percent.toFixed(1);
  return stage === ALERT_VERY_CLOSE
    ? [`فرصة بتقرب — ${name}`, `قريب جدًا من إصدار إشارة — ${name} — ${pct}%`]
    : [`فرصة بتقرب — ${name}`, `إشارة محتملة قريبًا — ${name} — ${pct}%`];
}

/**
 * One pair, one moment. Returns the rung it sent, or null.
 *
 * `fired` is not derived from the percentage. 100 belongs to the program
 * returning a signal — a closed candle that satisfied every rule — and a card
 * sitting at 100 because a cycle is open is not that event.
 */
export function notifyStage(args: {
  symbol: string;
  name: string;
  setupKey: string | null;
  percent: number;
  fired?: boolean;
}): number | null {
  const { symbol, name, setupKey, percent, fired = false } = args;
  const ladder = readLadder();

  if (!setupKey) {
    if (ladder[symbol] !== undefined) {
      delete ladder[symbol];
      writeLadder(ladder);
    }
    return null;
  }

  const stage = fired
    ? ALERT_FIRED
    : percent >= ALERT_VERY_CLOSE
      ? ALERT_VERY_CLOSE
      : percent >= ALERT_NEAR
        ? ALERT_NEAR
        : 0;
  if (stage === 0) return null;

  const held = ladder[symbol];
  const highest = held !== undefined && held.key === setupKey ? held.highest : 0;
  if (stage <= highest) return null;

  ladder[symbol] = { key: setupKey, highest: stage };
  writeLadder(ladder);

  const [title, body] = messageFor(stage, name, percent);
  notify(title, body);
  return stage;
}

/** Forgets every ladder — for a sign-out, or a change of account. */
export function resetLadders(): void {
  try {
    localStorage.removeItem(LADDER_KEY);
  } catch {
    /* nothing to clear */
  }
}
