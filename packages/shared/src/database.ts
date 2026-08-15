/**
 * Database row types — a hand-written mirror of supabase_schema.sql.
 *
 * The schema itself is NOT changing in this migration: the same Supabase
 * project, the same nine tables. These types exist so the TypeScript apps read
 * and write exactly the columns the Dart apps do, with the same defaults.
 *
 * Column names are snake_case because that is what PostgREST returns; nothing
 * is renamed on the way through.
 */

/** `pairs` — the tradable instrument list, admin-managed and Realtime-backed. */
export interface PairRow {
  id: string;
  symbol: string;
  chart_symbol: string;
  category: string;
  type: string;
  /** Quoted in SQL because `order` is a reserved word. */
  order: number;
  created_at: string;
  /** 'tv' | 'po' — which data path feeds this pair. */
  source: string;
  is_otc: boolean;
  enabled: boolean;
}

/** `configs` — a key/value store; every `data` shape is documented in configs.ts. */
export interface ConfigRow {
  id: string;
  data: Record<string, unknown>;
}

/** `brokers` — the broker list shown on the login/registration screen. */
export interface BrokerRow {
  id: string;
  name: string;
  logo_url: string;
  chart_url: string;
  registration_link: string;
  desc: string;
  click_key: string;
  promo_code: string;
  bonus_percent: number;
  min_deposit: number;
  is_active: boolean;
  is_recommended: boolean;
  order: number;
  /** Accent colour as `#RRGGBB`. Note the camelCase column name — it is spelled
   *  that way in the database, not `theme_color`. */
  themeColor: string;
  created_at: string;
  updated_at: string;
}

/**
 * `users` — keyed by the broker account id the user types in, not by an auth
 * user. There is no Supabase Auth in this system.
 */
export interface UserRow {
  id: string;
  broker: string;
  /** 'user' | 'vip' | … — drives which strategy the engine loads. */
  role: string;
  is_banned: boolean;
  ban_reason: string;
  /** Locks a VIP account to one device. */
  device_id: string;
  fcm_token: string;
  login_count: number;
  vip_expiry: string | null;
  /**
   * Admin-controlled: the account's signals are generated at random, ignoring
   * the strategy entirely, and every trade closes as a win.
   */
  guaranteed_win: boolean;
  clicked_broker: string;
  created_at: string;
}

/** `clicks` — analytics counters, incremented through the `increment_click` RPC. */
export interface ClickRow {
  id: string;
  data: Record<string, number>;
}

/** `otc_pairs` — the scraper's own pair list for Pocket Option. */
export interface OtcPairRow {
  id: string;
  [key: string]: unknown;
}

/** `candles` — real OHLC written by the scraper, read by the engine. */
export interface CandleRow {
  id?: number;
  symbol: string;
  timeframe: string;
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** `push_subscriptions` — Web Push endpoints for signal notifications. */
export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

/** `captcha_stats` — 2captcha solve counters shown in the admin. */
export interface CaptchaStatsRow {
  id: string;
  data: Record<string, unknown>;
}

/** `repair_log` — the system-repair screen's audit trail. */
export interface RepairLogRow {
  id: string;
  [key: string]: unknown;
}

export interface Database {
  pairs: PairRow;
  configs: ConfigRow;
  brokers: BrokerRow;
  users: UserRow;
  clicks: ClickRow;
  otc_pairs: OtcPairRow;
  candles: CandleRow;
  push_subscriptions: PushSubscriptionRow;
  captcha_stats: CaptchaStatsRow;
  repair_log: RepairLogRow;
}

export type TableName = keyof Database;
