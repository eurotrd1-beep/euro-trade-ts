/**
 * Hard navigation helper.
 *
 * `window.location.href = '/'` sends the browser to the DOMAIN root. On GitHub
 * Pages the app lives at /<repo>/, so that lands on a 404 — which is exactly
 * what the sign-out button did.
 *
 * Next's `<Link>` and router already prepend the base path; only raw
 * `location` assignments need this.
 */

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Builds an app-absolute URL that respects the deployment's base path. */
export function appUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${BASE}${clean}`;
}

/** Full page load to an app route — use when state must be dropped entirely. */
export function hardNavigate(path: string): void {
  window.location.href = appUrl(path);
}
