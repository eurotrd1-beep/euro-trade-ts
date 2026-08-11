/**
 * Measures real horizontal overflow on a phone-sized viewport.
 *
 * Serves the static export, loads every route at 360x800, and reports any
 * element whose right edge lands past the viewport — the thing that makes a
 * page scroll sideways and look "eaten" on a phone.
 *
 * Run: node scripts/audit-mobile.mjs [width]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = 'apps/web/out';
const WIDTH = Number(process.argv[2] ?? 360);
const HEIGHT = 800;

const ROUTES = [
  '/', '/login', '/language', '/notice', '/maintenance', '/app',
  '/admin', '/admin/vip', '/admin/analytics', '/admin/brokers', '/admin/pairs',
  '/admin/strategy', '/admin/control', '/admin/updates', '/admin/health',
  '/admin/theme', '/admin/promo', '/admin/signals',
];

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.woff2': 'font/woff2', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain',
};

/** Static file server that mirrors how GitHub Pages resolves `/x` → `x.html`. */
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const candidates =
    url.endsWith('/') ? [join(ROOT, url, 'index.html')] : [join(ROOT, url), join(ROOT, `${url}.html`)];

  for (const raw of candidates) {
    const path = normalize(raw);
    try {
      if (!(await stat(path)).isFile()) continue;
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(await readFile(path));
      return;
    } catch {
      // Try the next candidate.
    }
  }
  res.writeHead(404).end('not found');
});

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

// Past the gates, so the real screens render rather than a login form.
await context.addInitScript(() => {
  try {
    localStorage.setItem('admin_session', 'true');
    localStorage.setItem('user_verified', 'true');
    localStorage.setItem('user_account_id', '12345678');
    localStorage.setItem('user_broker', 'Pocket Option');
  } catch {
    /* ignore */
  }
});

const page = await context.newPage();
let problems = 0;

for (const route of ROUTES) {
  await page.goto(base + route, { waitUntil: 'networkidle' }).catch(() => {});
  // Client-rendered screens need a beat after hydration.
  await page.waitForTimeout(700);

  const report = await page.evaluate((vw) => {
    const doc = document.documentElement;
    const offenders = [];

    // An element wider than the viewport is only a problem if nothing above it
    // clips — a marquee inside `overflow: hidden`, or a decorative glow behind
    // a clipped card, is working as intended and must not be reported.
    const isClipped = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (o.overflow !== 'visible' || o.overflowX !== 'visible') return true;
      }
      return false;
    };

    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const overflow = Math.round(Math.max(r.right - vw, -r.left));
      if (overflow > 1 && !isClipped(el)) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
          over: overflow,
          w: Math.round(r.width),
        });
      }
    }
    // Deepest-first, keep the widest few — a parent usually overflows only
    // because a child does.
    offenders.sort((a, b) => b.over - a.over);
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      offenders: offenders.slice(0, 6),
    };
  }, WIDTH);

  const scrolls = report.scrollWidth > report.clientWidth + 1;
  if (scrolls || report.offenders.length > 0) {
    problems++;
    console.log(`\n❌ ${route}  scrollWidth=${report.scrollWidth} viewport=${report.clientWidth}`);
    for (const o of report.offenders) {
      console.log(`     +${o.over}px  <${o.tag} class="${o.cls}"> (w=${o.w})`);
    }
  } else {
    console.log(`✅ ${route}`);
  }
}

console.log(`\n${problems === 0 ? 'No horizontal overflow at' : `${problems} route(s) overflow at`} ${WIDTH}px.`);

await browser.close();
server.close();
