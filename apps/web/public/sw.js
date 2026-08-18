/*
 * Service worker — the only part of this app that runs with the tab closed.
 *
 * It exists for one reason: a push notification has to be handled by something
 * the browser can wake up on its own. A page cannot be that thing. Everything
 * else the app does — the watch loop, the engine, the chart — needs a tab, and
 * the whole point of this feature is being told while not looking.
 *
 * Deliberately tiny. A service worker that caches the app would also serve a
 * stale copy of it after a deploy, and this one has no business deciding what
 * version of the app anybody sees. It receives pushes and opens the chart.
 */

/* eslint-env serviceworker */

// Take over immediately rather than waiting for every tab to close. A user who
// presses "enable notifications" and then closes the tab must be subscribed to
// a worker that is actually in control.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }

  const title = data.title || 'إشارة جديدة';
  const symbol = data.symbol || '';
  const kind = data.kind === 'signal' ? 'signal' : 'armed';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      // The app's own icon, so the notification is recognisable in a shade
      // full of other apps.
      icon: './logo.jpg',
      badge: './logo.jpg',
      // One notification per pair per kind: a setup that re-arms replaces its
      // own line instead of stacking a second one under it.
      tag: `${kind}:${symbol}`,
      renotify: true,
      // A trade that has already opened is worth a buzz. A setup only forming
      // is not, at 3am.
      silent: kind !== 'signal',
      data: { symbol, kind },
    }),
  );
});

/*
 * Tapping the notification opens the chart for that pair.
 *
 * An already-open tab is focused and told which pair to switch to, rather than
 * opening a second copy of the app — a user with the app open in one tab and a
 * notification tapped in another would otherwise end up with two, each running
 * its own watch loop.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const symbol = (event.notification.data && event.notification.data.symbol) || '';

  event.waitUntil(
    (async () => {
      const url = new URL('./app', self.registration.scope);
      if (symbol) url.searchParams.set('pair', symbol);

      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const tab of tabs) {
        if (tab.url && tab.url.startsWith(self.registration.scope)) {
          tab.postMessage({ type: 'open-pair', symbol });
          return tab.focus();
        }
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});
