/**
 * Admin gate.
 *
 * ⚠️ READ THIS BEFORE RELYING ON IT.
 *
 * This is a client-side gate on a statically exported site. There is no server
 * to check a password against, so the check runs in the browser and the
 * credential hash ships in the bundle. It stops someone who stumbles onto
 * /admin. It does NOT stop anyone who opens devtools, and it does not need to
 * be bypassed at all: the Supabase anon key is public and RLS is open, so the
 * same writes can be made directly against the API.
 *
 * Real protection needs the plan in docs/security.md — an authenticated Route
 * Handler holding the service key, and RLS closed behind it.
 *
 * The password is stored as a SHA-256 hash rather than plaintext purely so it
 * is not greppable in the shipped JavaScript.
 */

const USERNAME = 'joex';

/** sha256('joex') */
const PASSWORD_HASH = '98f067307fdd8010ba77f4688f256897a593488be1a4fbb10f43e70130bc7f38';

const SESSION_KEY = 'admin_session';
const COOKIE_MAX_AGE_DAYS = 30;

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Verifies a username/password pair. */
export async function checkCredentials(username: string, password: string): Promise<boolean> {
  if (username.trim().toLowerCase() !== USERNAME) return false;
  try {
    return (await sha256(password)) === PASSWORD_HASH;
  } catch {
    // crypto.subtle needs a secure context; without it the gate cannot verify.
    return false;
  }
}

// ── Session, stored the same durable way as the user session ────────────────

function writeCookie(value: string): void {
  try {
    document.cookie = `${SESSION_KEY}=${value}; Max-Age=${COOKIE_MAX_AGE_DAYS * 86400}; Path=/; SameSite=Lax`;
  } catch {
    // Cookies blocked — localStorage may still hold it.
  }
}

function readCookie(): string | null {
  try {
    return document.cookie.match(new RegExp(`(?:^|; )${SESSION_KEY}=([^;]*)`))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** True while the admin session is valid. Re-writes both stores to keep it alive. */
export function isAdminSignedIn(): boolean {
  let local: string | null = null;
  try {
    local = globalThis.localStorage?.getItem(SESSION_KEY) ?? null;
  } catch {
    local = null;
  }

  const token = local ?? readCookie();
  if (token !== 'true') return false;

  // Repair whichever store was cleared and roll the cookie expiry forward.
  signInAdmin();
  return true;
}

export function signInAdmin(): void {
  try {
    globalThis.localStorage?.setItem(SESSION_KEY, 'true');
  } catch {
    // Cookie carries it.
  }
  writeCookie('true');
}

export function signOutAdmin(): void {
  try {
    globalThis.localStorage?.removeItem(SESSION_KEY);
  } catch {
    // Nothing to remove.
  }
  try {
    document.cookie = `${SESSION_KEY}=; Max-Age=0; Path=/; SameSite=Lax`;
  } catch {
    // Nothing to remove.
  }
}
