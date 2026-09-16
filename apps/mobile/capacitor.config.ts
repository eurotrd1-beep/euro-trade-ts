import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shell configuration — replaces the entire `euroapp` Flutter project.
 *
 * The Flutter version was a WebView pointing at the GitHub Pages build, plus a
 * hand-rolled loading dialog, CSS injection to hide the scrollbar, a
 * `flutter-first-frame` JS bridge, and a back-button handler. Capacitor
 * provides all of that natively, so the whole thing collapses to this file.
 *
 * ── Bundled vs remote ──────────────────────────────────────────────────────
 * `webDir` bundles the exported site INTO the app:
 *   + starts instantly, no white flash, shell works with no connection
 *   − a UI change needs a new store release
 *
 * The Flutter app loaded the site remotely, so UI changes shipped without
 * review. To keep that, uncomment the `server` block below and every release
 * of the web app reaches users immediately — at the cost of a blank screen if
 * the host is unreachable.
 *
 * Bundled is the default here because a trading app that shows nothing when the
 * network hiccups is the worse failure. Signals and prices come from Supabase
 * and the proxy either way, so both modes need a connection to be USEFUL —
 * only the shell differs.
 */
const config: CapacitorConfig = {
  // Kept identical to the Flutter build so this app UPDATES the installed one
  // rather than sitting beside it. That also means it must be signed with the
  // same key as the old release, or Android refuses the update.
  appId: 'com.eurotrade.euro_trade',
  appName: 'EURO TRADE',

  // The bundled copy is still built and shipped; `server.url` simply takes
  // precedence while it is reachable.
  webDir: '../web/out',

  // REMOTE, as the Flutter shell was: a web release reaches users immediately,
  // with no store review and no new APK.
  //
  // Cloudflare Pages since the move off GitHub Pages. The suffix is not a typo:
  // `euro-trade.pages.dev` was already taken by another account, so Cloudflare
  // assigned `euro-trade-9lr`. The project is still named euro-trade.
  //
  // This URL is baked into every APK that ships. An installed app cannot be
  // told a new one, so changing it again means a new build and users updating
  // — which is why GitHub Pages could be deleted outright this time and could
  // not be if anyone were running an old APK.
  server: {
    url: 'https://euro-trade-9lr.pages.dev/',
    cleartext: false,
  },

  backgroundColor: '#0A0714',

  android: {
    // Matches the dark identity so there is no white flash on launch — the
    // problem the Flutter shell solved with a custom splash.
    backgroundColor: '#0A0714',
    allowMixedContent: false,
  },

  ios: {
    backgroundColor: '#0A0714',
    contentInset: 'always',
  },

  plugins: {
    SplashScreen: {
      // The web app draws its own splash, so the native one only needs to
      // cover the handover. Anything longer shows two splashes in a row.
      launchShowDuration: 600,
      backgroundColor: '#0A0714',
      showSpinner: false,
      androidSplashResourceName: 'splash',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0A0714',
    },
  },
};

export default config;
