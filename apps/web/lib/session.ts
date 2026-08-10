/**
 * Session storage.
 *
 * The session lived in `localStorage` alone, which is not durable enough in
 * practice: iOS evicts it under storage pressure, in-app browsers and the
 * Capacitor WebView can clear it between launches, and any private-mode tab
 * drops it on close. The symptom is a user being asked to sign in again for no
 * apparent reason.
 *
 * So it is written to BOTH localStorage and a long-lived cookie, and read from
 * either — whichever survived. Every successful load re-writes both, which also
 * keeps the cookie's expiry rolling forward instead of lapsing after a year of
 * active use.
 */

import { KEY_USER_VERIFIED, KEY_USER_ACCOUNT_ID, KEY_USER_BROKER } from '@euro/shared';

const COOKIE_MAX_AGE_DAYS = 365;

export interface Session {
  accountId: string;
  broker: string;
}

function writeCookie(name: string, value: string): void {
  try {
    const maxAge = COOKIE_MAX_AGE_DAYS * 24 * 60 * 60;
    // `SameSite=Lax` keeps it on normal navigation without exposing it
    // cross-site. No `Secure` flag so it still works on a local http dev server.
    document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
  } catch {
    // Cookies disabled — localStorage may still have it.
  }
}

function readCookie(name: string): string | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function clearCookie(name: string): void {
  try {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  } catch {
    // Nothing to do.
  }
}

function readLocal(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage unavailable — the cookie carries the session.
  }
}

/** Writes the session to every store. Safe to call repeatedly. */
export function saveSession(accountId: string, broker: string): void {
  writeLocal(KEY_USER_VERIFIED, 'true');
  writeLocal(KEY_USER_ACCOUNT_ID, accountId);
  writeLocal(KEY_USER_BROKER, broker);

  writeCookie(KEY_USER_VERIFIED, 'true');
  writeCookie(KEY_USER_ACCOUNT_ID, accountId);
  writeCookie(KEY_USER_BROKER, broker);
}

/**
 * Reads the session from whichever store still has it, then re-writes both so
 * a store that was cleared is repaired and the cookie's expiry rolls forward.
 */
export function loadSession(): Session | null {
  const verified = readLocal(KEY_USER_VERIFIED) ?? readCookie(KEY_USER_VERIFIED);
  const accountId = readLocal(KEY_USER_ACCOUNT_ID) ?? readCookie(KEY_USER_ACCOUNT_ID);
  const broker = readLocal(KEY_USER_BROKER) ?? readCookie(KEY_USER_BROKER) ?? '';

  if (verified !== 'true' || !accountId) return null;

  saveSession(accountId, broker);
  return { accountId, broker };
}

/** Signs out — must clear BOTH stores or the session would resurrect. */
export function clearSession(): void {
  for (const key of [KEY_USER_VERIFIED, KEY_USER_ACCOUNT_ID, KEY_USER_BROKER]) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // Ignored.
    }
    clearCookie(key);
  }
}
