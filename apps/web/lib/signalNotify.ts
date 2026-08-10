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

export function notify(title: string, body: string): void {
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
