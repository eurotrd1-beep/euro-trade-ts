/**
 * Native shell integration — the behaviours the Flutter WebView wrapper
 * provided by hand, now driven from the web app itself.
 *
 * Everything here is a no-op in a browser, so the same build serves the web
 * and the Capacitor app with no forked code.
 *
 * From euroapp's README, the shell was responsible for:
 *   • a loading dialog until the content painted   → the web splash covers this
 *   • hiding the scrollbar via injected CSS        → done in globals.css
 *   • the hardware back button navigating in-app   → `initBackButton` below
 *   • no white flash on launch                     → backgroundColor in the config
 *   • an offline error screen with retry           → `initNetworkWatch` below
 */

type Unsubscribe = () => void;

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True only inside the native shell. */
export function isNative(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

/**
 * Hardware back button.
 *
 * The Flutter shell called `webViewController.goBack()` when history allowed
 * and otherwise let the app close. Same rule here, with one addition: the
 * splash and the main screen are roots, so backing out of them exits rather
 * than returning to a screen the user has already passed through.
 */
export async function initBackButton(): Promise<Unsubscribe> {
  if (!isNative()) return () => {};

  try {
    const { App } = await import('@capacitor/app');
    const handle = await App.addListener('backButton', ({ canGoBack }) => {
      const atRoot = ['/', '/app'].includes(window.location.pathname);
      if (canGoBack && !atRoot) window.history.back();
      else void App.exitApp();
    });
    return () => void handle.remove();
  } catch {
    // Plugin missing (web build) — nothing to wire up.
    return () => {};
  }
}

/** Locks the status bar to the app's dark identity. */
export async function initStatusBar(): Promise<void> {
  if (!isNative()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');

    // Android 15 draws the WebView edge to edge by default, so the page starts
    // BEHIND the status bar. Push it back below. The CSS safe-area padding is
    // still there as a second line of defence — and carries the gesture bar at
    // the bottom, which this does not.
    await StatusBar.setOverlaysWebView({ overlay: false });

    await StatusBar.setStyle({ style: Style.Dark });
    // The admin panel keeps its own near-black; the two apps stay tellable
    // apart right down to the status bar.
    const isAdmin = location.pathname.includes('/admin');
    await StatusBar.setBackgroundColor({ color: isAdmin ? '#030712' : '#0A0714' });
  } catch {
    // Not fatal — the app just uses the platform default.
  }
}

/** Hides the native splash once the web app has actually painted. */
export async function hideSplash(): Promise<void> {
  if (!isNative()) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch {
    // Ignored: the configured timeout hides it anyway.
  }
}

/**
 * Connection watch. The Flutter shell showed a dedicated error screen with a
 * retry button; here the callback lets the UI surface a banner without losing
 * the user's place.
 */
export function initNetworkWatch(onChange: (online: boolean) => void): Unsubscribe {
  const online = () => onChange(true);
  const offline = () => onChange(false);

  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  onChange(navigator.onLine);

  return () => {
    window.removeEventListener('online', online);
    window.removeEventListener('offline', offline);
  };
}
