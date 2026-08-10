/**
 * Turns off the Android WebView's OWN scrollbars.
 *
 * `::-webkit-scrollbar { display: none }` in globals.css hides the scrollbars
 * the page draws, but the root scroller in an Android WebView is the native
 * View, and it paints its fading scrollbar in `onDrawScrollBars` — CSS never
 * gets a say. The only way to remove it is to disable it on the View.
 *
 * This runs after `cap sync` because `android/` is regenerated and is not
 * tracked in git; keeping the edit as a script means it cannot be silently
 * lost the next time someone runs `cap add android`.
 *
 * Usage: node scripts/disable-webview-scrollbars.mjs <android-dir>
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MARKER = 'setVerticalScrollBarEnabled';

const BODY = `
    @Override
    public void onStart() {
        super.onStart();
        // The page hides its own scrollbars in CSS; these are the WebView's,
        // which CSS cannot reach. OVER_SCROLL_NEVER also drops the stretch
        // glow at the ends of a scroll.
        android.webkit.WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setVerticalScrollBarEnabled(false);
            webView.setHorizontalScrollBarEnabled(false);
            webView.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
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
  console.log('WebView scrollbars already disabled.');
  process.exit(0);
}

// The generated class is a one-liner: `public class MainActivity extends BridgeActivity {}`
const patched = source.replace(
  /public class MainActivity extends BridgeActivity \{\s*\}/,
  `public class MainActivity extends BridgeActivity {\n${BODY}}`,
);

if (patched === source) {
  console.error('MainActivity.java did not match the expected shape; left untouched.');
  process.exit(1);
}

writeFileSync(target, patched);
console.log(`WebView scrollbars disabled in ${target}`);
