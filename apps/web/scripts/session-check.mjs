/**
 * Session durability check.
 *
 * Exercises save → load → clear against a faithful emulation of browser
 * storage, including the part that actually matters: `document.cookie` is a
 * WRITE-ONE-READ-ALL accessor, and a cookie is deleted by re-setting it with
 * `Max-Age=0`. If clearSession() got that wrong, a "signed out" user would come
 * back signed in on the next load, because loadSession() repairs localStorage
 * from whichever store survived.
 *
 * Run with:  node scripts/session-check.mjs
 */

// ── Browser storage emulation ───────────────────────────────────────────────

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

function makeCookieJar() {
  const jar = new Map();
  return {
    get cookie() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(str) {
      const [pair, ...attrs] = str.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // Browsers delete a cookie when Max-Age is 0 (or negative).
      const maxAge = attrs
        .map((a) => a.match(/^Max-Age=(-?\d+)$/i))
        .find(Boolean)?.[1];
      if (maxAge !== undefined && Number(maxAge) <= 0) jar.delete(name);
      else jar.set(name, value);
    },
    _dump: () => Object.fromEntries(jar),
    _maxAgeOf: null,
  };
}

// Capture the Max-Age the module writes, so the expiry claim is verified too.
let lastMaxAge = null;
const cookieJar = makeCookieJar();
const rawSetter = Object.getOwnPropertyDescriptor(cookieJar, 'cookie').set;
Object.defineProperty(cookieJar, 'cookie', {
  get: Object.getOwnPropertyDescriptor(cookieJar, 'cookie').get,
  set(str) {
    const m = str.match(/Max-Age=(-?\d+)/i);
    if (m && Number(m[1]) > 0) lastMaxAge = Number(m[1]);
    rawSetter.call(cookieJar, str);
  },
});

globalThis.localStorage = makeLocalStorage();
globalThis.document = cookieJar;

// ── The module under test, inlined to match lib/session.ts exactly ──────────

const KEY_USER_VERIFIED = 'user_verified';
const KEY_USER_ACCOUNT_ID = 'user_account_id';
const KEY_USER_BROKER = 'user_broker';
const COOKIE_MAX_AGE_DAYS = 365;

const writeCookie = (n, v) => {
  document.cookie = `${n}=${encodeURIComponent(v)}; Max-Age=${COOKIE_MAX_AGE_DAYS * 86400}; Path=/; SameSite=Lax`;
};
const readCookie = (n) => {
  const m = document.cookie.match(new RegExp(`(?:^|; )${n}=([^;]*)`));
  return m?.[1] ? decodeURIComponent(m[1]) : null;
};
const clearCookie = (n) => { document.cookie = `${n}=; Max-Age=0; Path=/; SameSite=Lax`; };
const readLocal = (k) => globalThis.localStorage?.getItem(k) ?? null;
const writeLocal = (k, v) => globalThis.localStorage?.setItem(k, v);

function saveSession(accountId, broker) {
  writeLocal(KEY_USER_VERIFIED, 'true');
  writeLocal(KEY_USER_ACCOUNT_ID, accountId);
  writeLocal(KEY_USER_BROKER, broker);
  writeCookie(KEY_USER_VERIFIED, 'true');
  writeCookie(KEY_USER_ACCOUNT_ID, accountId);
  writeCookie(KEY_USER_BROKER, broker);
}

function loadSession() {
  const verified = readLocal(KEY_USER_VERIFIED) ?? readCookie(KEY_USER_VERIFIED);
  const accountId = readLocal(KEY_USER_ACCOUNT_ID) ?? readCookie(KEY_USER_ACCOUNT_ID);
  const broker = readLocal(KEY_USER_BROKER) ?? readCookie(KEY_USER_BROKER) ?? '';
  if (verified !== 'true' || !accountId) return null;
  saveSession(accountId, broker);
  return { accountId, broker };
}

function clearSession() {
  for (const key of [KEY_USER_VERIFIED, KEY_USER_ACCOUNT_ID, KEY_USER_BROKER]) {
    globalThis.localStorage?.removeItem(key);
    clearCookie(key);
  }
}

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0;
const check = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!pass) failures++;
};

console.log('1. sign in');
saveSession('12345678', 'Pocket Option');
check('localStorage has the session', readLocal(KEY_USER_ACCOUNT_ID) === '12345678');
check('cookie has the session', readCookie(KEY_USER_ACCOUNT_ID) === '12345678');
check(
  'cookie expiry is 365 days',
  lastMaxAge === 365 * 86400,
  `Max-Age=${lastMaxAge}s (${(lastMaxAge / 86400).toFixed(0)}d)`,
);

console.log('\n2. reload — session survives');
check('loadSession returns it', loadSession()?.accountId === '12345678');

console.log('\n3. localStorage evicted (the iOS / WebView case)');
globalThis.localStorage.removeItem(KEY_USER_VERIFIED);
globalThis.localStorage.removeItem(KEY_USER_ACCOUNT_ID);
check('recovered from the cookie', loadSession()?.accountId === '12345678');
check('localStorage was repaired', readLocal(KEY_USER_ACCOUNT_ID) === '12345678');

console.log('\n4. cookies blocked instead');
for (const k of [KEY_USER_VERIFIED, KEY_USER_ACCOUNT_ID, KEY_USER_BROKER]) clearCookie(k);
check('recovered from localStorage', loadSession()?.accountId === '12345678');
check('cookie was repaired', readCookie(KEY_USER_ACCOUNT_ID) === '12345678');

console.log('\n5. SIGN OUT');
clearSession();
check('localStorage empty', readLocal(KEY_USER_VERIFIED) === null && readLocal(KEY_USER_ACCOUNT_ID) === null);
check('cookies empty', readCookie(KEY_USER_VERIFIED) === null && readCookie(KEY_USER_ACCOUNT_ID) === null);
check('raw cookie string is clean', !document.cookie.includes('user_'), `"${document.cookie}"`);

console.log('\n6. reload after sign out — must stay OUT');
check('loadSession returns null', loadSession() === null);
check('no resurrection in localStorage', readLocal(KEY_USER_ACCOUNT_ID) === null);
check('no resurrection in cookies', readCookie(KEY_USER_ACCOUNT_ID) === null);

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
