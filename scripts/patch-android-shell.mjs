/**
 * Native fixes applied to the generated Android shell after `cap sync`.
 *
 * Both of these are things the web layer cannot do for itself:
 *
 * 1. WEBVIEW SCROLLBARS. `::-webkit-scrollbar { display: none }` hides the
 *    scrollbars the page draws, but the root scroller in an Android WebView is
 *    the native View and it paints its own fading bar in `onDrawScrollBars`,
 *    where CSS has no reach.
 *
 * 2. EDGE-TO-EDGE. Targeting SDK 35 (Android 15) means the system draws the
 *    app behind the status bar and the gesture bar, and unlike earlier
 *    versions it ignores `setDecorFitsSystemWindows(true)`. The supported fix
 *    is to read the inset and pad the root view by it. Without this the top of
 *    the page sits under the clock — the panel looked bitten off.
 *
 *    This is deliberately done natively rather than in CSS. The apps load the
 *    site REMOTELY, so a CSS fix only lands after a deploy, while this one
 *    ships with the APK and works against whatever is currently published. The
 *    `env(safe-area-inset-*)` padding in globals.css stays as well, for iOS and
 *    for the browser.
 *
 * `android/` is regenerated and untracked, so this lives as a committed script
 * wired into `sync` — it cannot be silently lost by `cap add android`.
 *
 * Usage: node scripts/patch-android-shell.mjs <android-dir>
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MARKER = 'setOnApplyWindowInsetsListener';

const BODY = `
    @Override
    public void onStart() {
        super.onStart();

        android.webkit.WebView webView = getBridge().getWebView();
        if (webView != null) {
            // The page hides its own scrollbars in CSS; these are the WebView's,
            // which CSS cannot reach.
            webView.setVerticalScrollBarEnabled(false);
            webView.setHorizontalScrollBarEnabled(false);
            webView.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
        }

        // Android 15 draws the app edge to edge and ignores
        // setDecorFitsSystemWindows, so the system bars are cleared by padding
        // the root view with the reported insets instead.
        final android.view.View root = getWindow().getDecorView().findViewById(android.R.id.content);
        if (root != null) {
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root, (v, windowInsets) -> {
                androidx.core.graphics.Insets bars = windowInsets.getInsets(
                        androidx.core.view.WindowInsetsCompat.Type.systemBars()
                                | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return androidx.core.view.WindowInsetsCompat.CONSUMED;
            });
            androidx.core.view.ViewCompat.requestApplyInsets(root);
        }
    }
`;

/** Finds MainActivity.java wherever the package path puts it. */
function findMainActivity(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const found = findMainActivity(path);
      if (found) return found;
    } else if (entry === 'MainActivity.java') {
      return path;
    }
  }
  return null;
}

const androidDir = resolve(process.argv[2] ?? 'android');
const target = findMainActivity(join(androidDir, 'app', 'src', 'main', 'java'));

if (!target) {
  console.error(`MainActivity.java not found under ${androidDir}`);
  process.exit(1);
}

const source = readFileSync(target, 'utf8');

if (source.includes(MARKER)) {
  console.log('Android shell already patched.');
  process.exit(0);
}

// Matches the generated one-liner, and also an earlier patch of this file so a
// half-applied version is replaced rather than duplicated.
const patched = source.replace(
  /public class MainActivity extends BridgeActivity \{[\s\S]*\}\s*$/,
  `public class MainActivity extends BridgeActivity {\n${BODY}}\n`,
);

if (patched === source) {
  console.error('MainActivity.java did not match the expected shape; left untouched.');
  process.exit(1);
}

writeFileSync(target, patched);
console.log(`Android shell patched: ${target}`);
