/**
 * App constants — ported from lib/constants.dart.
 *
 * Colours, storage keys, affiliate links and the fallback pair list, all kept
 * at their existing values. The palette in particular is load-bearing: it is
 * the app's identity and every screen references it.
 */

// ── Price formatting ────────────────────────────────────────────────────────

/**
 * Central price formatter. The precision steps down with magnitude so a JPY
 * pair, a forex pair and a crypto pair all read correctly.
 * Dart: `toStringAsFixed` → JS: `toFixed`, identical rounding for these ranges.
 */
export function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 10) return price.toFixed(3);
  return price.toFixed(5);
}

/**
 * How many symbols the catalogue holds after the asset policy.
 *
 * It was 183 until stocks and indices were dropped and commodities and crypto
 * were cut to gold, silver, BTC, ETH and SOL — the scraper does not subscribe
 * to the rest and nothing stores them. 89 is what `otc_pairs`, `pairs` and the
 * live feed all report, and `20260817_asset_policy.sql` is what set it.
 *
 * It lives here because three places were carrying the old figure separately:
 * two health checks that had been quietly warning ever since, and a headline
 * on the login screen telling visitors a number that stopped being true. A
 * count kept in one place can go stale; a count kept in three goes stale in
 * pieces, and the pieces disagree.
 */
export const CATALOGUE_SYMBOLS = 89;

// ── Local storage keys ──────────────────────────────────────────────────────

export const KEY_DEVICE_ID = 'device_id';
export const KEY_USER_VERIFIED = 'user_verified';
export const KEY_USER_ACCOUNT_ID = 'user_account_id';
export const KEY_USER_BROKER = 'user_broker';

/**
 * A stable per-browser id, generated once and persisted. Used to lock a VIP
 * account to a single device.
 *
 * Same shape as the Dart version: `d` + base36 microseconds + base36 random.
 * `performance.timeOrigin` gives sub-millisecond resolution so two tabs opened
 * in the same millisecond still differ.
 */
export function getDeviceId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(KEY_DEVICE_ID);
    if (existing) return existing;
  } catch {
    // Fall through and mint a transient id.
  }

  const micros = Math.trunc((performance.timeOrigin + performance.now()) * 1000);
  const rand = Math.trunc(Math.random() * 0x7fffffff);
  const id = `d${micros.toString(36)}${rand.toString(36)}`;

  try {
    globalThis.localStorage?.setItem(KEY_DEVICE_ID, id);
  } catch {
    // Non-fatal: the id just will not survive a reload.
  }
  return id;
}

// ── Broker affiliate links ──────────────────────────────────────────────────

export const QUOTEX_AFFILIATE_LINK = 'https://broker-qx.pro/sign-up/?lid=2154439';
export const POCKET_OPTION_AFFILIATE_LINK =
  'https://pocketoption.com/register/?utm_source=affiliate&a=VIPTRADER';
export const EXPERT_OPTION_AFFILIATE_LINK = 'https://expertoption-track.com/143787056';

// ── Palette ─────────────────────────────────────────────────────────────────

export const COLORS = {
  spaceBackground: '#0A0714',
  cardBg: '#161129',
  accentCyan: '#00FFF0',
  accentBlue: '#1A8CFF',
  callGreen: '#00FF7F',
  putRed: '#FF2A6D',
  warningOrange: '#FFAD00',
  textPrimary: '#FFFFFF',
  textSecondary: '#8B88A0',
  borderGlow: '#2C2250',
} as const;

/** The app-wide background gradient (Dart: topLeft → bottomRight = 135deg). */
export const BACKGROUND_GRADIENT =
  'linear-gradient(135deg, #06030C 0%, #0E091F 50%, #05030A 100%)';

// ── Trading pairs ───────────────────────────────────────────────────────────

export interface PairDef {
  symbol: string;
  chartSymbol: string;
  category: string;
  type: string;
  source: string;
  isOtc: boolean;
  enabled: boolean;
}

/**
 * Pre-load fallback list. The Supabase `pairs` stream replaces this as soon as
 * it arrives; this only covers first paint and the offline case.
 */
export const DEFAULT_CURRENCY_PAIRS: readonly PairDef[] = [
  // Currencies (Pocket Option OTC)
  { symbol: 'EUR/USD OTC', chartSymbol: 'EURUSD_otc', category: 'currencies', type: 'currencies', source: 'po', isOtc: true, enabled: true },
  { symbol: 'GBP/USD OTC', chartSymbol: 'GBPUSD_otc', category: 'currencies', type: 'currencies', source: 'po', isOtc: true, enabled: true },
  { symbol: 'USD/JPY OTC', chartSymbol: 'USDJPY_otc', category: 'currencies', type: 'currencies', source: 'po', isOtc: true, enabled: true },
  { symbol: 'AUD/USD OTC', chartSymbol: 'AUDUSD_otc', category: 'currencies', type: 'currencies', source: 'po', isOtc: true, enabled: true },
  { symbol: 'USD/CAD OTC', chartSymbol: 'USDCAD_otc', category: 'currencies', type: 'currencies', source: 'po', isOtc: true, enabled: true },
  { symbol: 'AUD/CAD OTC', chartSymbol: 'AUDCAD_otc', category: 'currencies', type: 'currencies', source: 'po', isOtc: true, enabled: true },
  { symbol: 'EUR/JPY OTC', chartSymbol: 'EURJPY_otc', category: 'currencies', type: 'currencies', source: 'po', isOtc: true, enabled: true },
  { symbol: 'CAD/JPY OTC', chartSymbol: 'CADJPY_otc', category: 'currencies', type: 'currencies', source: 'po', isOtc: true, enabled: true },
  // Commodities (Pocket Option OTC)
  { symbol: 'Gold OTC', chartSymbol: 'XAUUSD_otc', category: 'commodities', type: 'commodities', source: 'po', isOtc: true, enabled: true },
  { symbol: 'Silver OTC', chartSymbol: 'XAGUSD_otc', category: 'commodities', type: 'commodities', source: 'po', isOtc: true, enabled: true },
];

/**
 * Maps a display name to its Pocket Option chart symbol
 * ("EUR/USD" → "EURUSD", "Gold OTC" → "XAUUSD_otc").
 *
 * Falls back to stripping the OTC marker and slash, then re-appending the
 * `_otc` suffix if the display name carried it.
 */
export function chartSymbolFor(
  displaySymbol: string,
  pairs: readonly PairDef[] = DEFAULT_CURRENCY_PAIRS,
): string {
  for (const p of pairs) {
    if (p.symbol === displaySymbol) return p.chartSymbol;
  }
  const isOtc = displaySymbol.toUpperCase().includes('OTC');
  const base = displaySymbol
    .replace(/\s*\(?OTC\)?/gi, '')
    .replace(/\//g, '')
    .trim();
  return isOtc ? `${base}_otc` : base;
}
