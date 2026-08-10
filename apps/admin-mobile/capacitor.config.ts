import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shell for the ADMIN panel — a second app, deliberately separate from
 * the one users install.
 *
 * It is the same deployed site, opened at /admin. There is no second build and
 * no duplicated code: the panel already lives inside the web app, so this file
 * is the whole "admin app".
 *
 * Its own appId means it installs alongside EURO TRADE with its own icon and
 * its own entry in the launcher, and an operator never has to hunt for a hidden
 * route inside the trading app.
 *
 * REMOTE only, on purpose. The panel is an operator tool: it is useless without
 * a connection anyway (every screen reads Supabase), and shipping it remotely
 * means a fix reaches the operator the moment it is deployed.
 */
const config: CapacitorConfig = {
  appId: 'com.eurotrade.admin',
  appName: 'EURO ADMIN',

  // Nothing is bundled — `server.url` is the app. The directory still has to
  // exist for the CLI, and pointing it at the same export keeps `cap sync`
  // working without a second build.
  webDir: '../web/out',

  server: {
    // NO trailing slash. `output: 'export'` with the default `trailingSlash`
    // emits admin.html, not admin/index.html, so GitHub Pages serves /admin
    // and 404s on /admin/. Nested routes (/admin/vip, /admin/health) work the
    // same way and are reached by the client router anyway.
    url: 'https://eurotrd1-beep.github.io/euro-trade-ts/admin',
    cleartext: false,
  },

  // The admin palette, not the user app's — the same distinction the screens
  // themselves make, so an operator can tell at a glance which app is open.
  backgroundColor: '#030712',

  android: {
    backgroundColor: '#030712',
    allowMixedContent: false,
  },

  ios: {
    backgroundColor: '#030712',
    contentInset: 'always',
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#030712',
      showSpinner: false,
      androidSplashResourceName: 'splash',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#030712',
    },
  },
};

export default config;
