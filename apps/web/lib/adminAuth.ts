/**
 * Admin gate.
 *
 * ── WHAT THIS USED TO BE, AND WHY IT CHANGED ───────────────────────────────
 *
 * A username and a SHA-256 hash, both compiled into the bundle, checked in the
 * browser. It stopped someone who wandered onto /admin and nobody else — and
 * it did not need to be bypassed at all, because the writes it guarded were
 * made with the public anon key against tables RLS left open. Anyone with the
 * bundle could make them directly.
 *
 * The gate now guards something real. Every admin write goes to the data hub,
 * which requires `x-admin-secret` and refuses the request without it. The
 * secret is not in the bundle, not in this file, and not derivable from
 * anything shipped: the admin types it, and it is held in this browser only.
 *
 * So the check moved from "does this hash match" to "does the hub accept this
 * credential" — and the second question is the one that matters, because it is
 * the same question the hub asks on every subsequent write.
 *
 * ── WHY LOCALSTORAGE AND NOT A COOKIE ──────────────────────────────────────
 *
 * The old session flag lived in both. A flag can: it said nothing. A secret
 * cannot. A cookie is attached to every request to the origin, so the
 * credential would be sent to the static host on every page load, every asset,
 * every favicon — landing in CDN and access logs that have no reason to hold
 * it. `localStorage` is never transmitted by the browser; it goes out only
 * where this code puts it, which is the `x-admin-secret` header on the hub.
 *
 * The cost is that the session no longer survives localStorage being cleared,
 * and that is the correct trade for a credential.
 *
 * ── WHY THERE IS NO "VERIFY" CALL HERE ─────────────────────────────────────
 *
 * The hub deliberately has no verify endpoint, so it can never become an oracle
 * that confirms a guess for free. Sign-in therefore makes a REAL admin request
 * (see `AdminGate`) and keeps the secret only if it is not refused. Wrong
 * guesses are counted and rate-limited by the hub exactly like any other failed
 * credential.
 */

const STORE_KEY = 'admin_secret';
const SESSION_DAYS = 30;

interface Stored {
  secret: string;
  /** When it was entered, so a forgotten browser does not stay signed in. */
  at: number;
}

function read(): Stored | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed.secret !== 'string' || parsed.secret.length === 0) return null;
    if (typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > SESSION_DAYS * 86_400_000) {
      signOutAdmin();
      return null;
    }
    return { secret: parsed.secret, at: parsed.at };
  } catch {
    // Storage blocked, or a value left by an older build. Either way: signed out.
    return null;
  }
}

/**
 * The secret to send, or null.
 *
 * `dataHub` calls this on every request and attaches the header only when it
 * returns a string, so a public page — which shares the same client — never
 * sends an admin header it does not have.
 */
export function adminSecret(): string | null {
  return read()?.secret ?? null;
}

/** True while a secret is held. Not proof it is still accepted — the hub decides that. */
export function isAdminSignedIn(): boolean {
  return read() !== null;
}

/** Keeps the secret in this browser. Called only after the hub has accepted it. */
export function signInAdmin(secret: string): void {
  try {
    globalThis.localStorage?.setItem(
      STORE_KEY,
      JSON.stringify({ secret, at: Date.now() } satisfies Stored),
    );
  } catch {
    // Nothing persists; the admin will be asked again on the next page load.
  }
}

export function signOutAdmin(): void {
  try {
    globalThis.localStorage?.removeItem(STORE_KEY);
  } catch {
    // Nothing to remove.
  }
  // The old build kept a session flag in a cookie. Clear it so a browser that
  // signed in before this change does not stay "signed in" on a stale flag.
  try {
    document.cookie = 'admin_session=; Max-Age=0; Path=/; SameSite=Lax';
  } catch {
    // No document, or cookies blocked.
  }
  try {
    globalThis.localStorage?.removeItem('admin_session');
  } catch {
    // Nothing to remove.
  }
}
