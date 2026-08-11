'use client';

/**
 * Reads the signal statistics — always aggregated in Postgres, never in here.
 *
 * The temptation is to `select *` a month of signals and group them in
 * JavaScript. At ~700 signals a day that is 21,000 rows and roughly 19 MB of
 * egress EVERY time the page opens, and a 30s poll of a far smaller table once
 * burned 5.6 GB in two days on this project. So every number on the page comes
 * from `signal_stats()` or the `strategy_version_stats` view, which return tens
 * of rows. Raw signals are fetched in exactly one place: the detail list, with
 * a hard limit.
 *
 * ── THE FOUR OUTCOMES ──────────────────────────────────────────────────────
 *
 * win / loss / tie / unresolved, and `unresolved` is not a rounding detail. It
 * means the price feed had nothing usable when the trade expired. Recording
 * that as a tie — which the browser-side engine effectively did — quietly
 * inflates ties and no one ever finds out why. Ties and unresolved are both
 * excluded from the rate; only wins and losses decide it.
 *
 * `forced` marks a guaranteed-win signal. Those are excluded from every rate
 * and shown in their own box, because a rate that silently includes admin-
 * forced wins is not a measurement of anything.
 */

import { supabase } from '@euro/shared';

/** A binary option paying 80–90% needs this much just to return the stake. */
export const BREAKEVEN_LOW = 52.6;
export const BREAKEVEN_HIGH = 55.6;

/** Below this, a win rate describes the sample rather than the strategy. */
export const MIN_TRADES = 30;

export interface Bucket {
  bucket: string;
  signals: number;
  wins: number;
  losses: number;
  ties: number;
  unresolved: number;
  pending: number;
  forced: number;
  /** Null when there are fewer than MIN_TRADES decided — computed in Postgres. */
  win_rate: number | null;
}

export interface VersionStats {
  id: string;
  slot: string;
  version_number: number;
  name: string;
  uploaded_at: string;
  uploaded_by: string | null;
  is_active: boolean;
  json_hash: string;
  signals: number;
  wins: number;
  losses: number;
  ties: number;
  unresolved: number;
  pending: number;
  forced: number;
  win_rate: number | null;
}

export interface SignalRow {
  id: number;
  created_at: string;
  symbol: string;
  timeframe: string;
  direction: 'CALL' | 'PUT';
  slot: string;
  strategy_version_id: string | null;
  confidence: number | null;
  score: number | null;
  rules_matched: Array<{ i: string; r: string; v: number | string | null; ok: boolean }> | null;
  candle_snapshot: number[] | null;
  entry_price: number;
  expiry_seconds: number;
  outcome: 'pending' | 'win' | 'loss' | 'tie' | 'unresolved';
  outcome_price: number | null;
  outcome_at: string | null;
  forced: boolean;
}

export const SLOTS = [
  { id: 'instant_free', label: 'فورية — عادي' },
  { id: 'instant_paid', label: 'فورية — مدفوع' },
  { id: 'monitoring_free', label: 'مراقبة — عادي' },
  { id: 'monitoring_paid', label: 'مراقبة — مدفوع' },
];

export type RangeId = 'today' | 'yesterday' | 'this_month' | 'last_month' | 'this_year' | 'custom';

export const RANGES: Array<{ id: RangeId; label: string }> = [
  { id: 'today', label: 'النهاردة' },
  { id: 'yesterday', label: 'امبارح' },
  { id: 'this_month', label: 'الشهر الحالي' },
  { id: 'last_month', label: 'الشهر الماضي' },
  { id: 'this_year', label: 'السنة الحالية' },
  { id: 'custom', label: 'مدى مخصص' },
];

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Resolves a named range to the two dates the RPC wants. UTC, like the rows. */
export function rangeDates(id: RangeId, customFrom?: string, customTo?: string): [string, string] {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  switch (id) {
    case 'today':
      return [iso(now), iso(now)];
    case 'yesterday': {
      const d = new Date(Date.UTC(y, m, now.getUTCDate() - 1));
      return [iso(d), iso(d)];
    }
    case 'this_month':
      return [iso(new Date(Date.UTC(y, m, 1))), iso(now)];
    case 'last_month':
      return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))];
    case 'this_year':
      return [iso(new Date(Date.UTC(y, 0, 1))), iso(now)];
    case 'custom':
      return [customFrom || iso(now), customTo || iso(now)];
  }
}

export interface StatsFilter {
  from: string;
  to: string;
  slot?: string | null;
  versionId?: string | null;
  symbol?: string | null;
}

/** One aggregate query. `groupBy` decides how many rows come back, never more than ~200. */
export async function fetchStats(f: StatsFilter, groupBy: 'total' | 'day' | 'symbol' | 'slot' | 'version'): Promise<Bucket[]> {
  const { data, error } = await supabase().rpc('signal_stats', {
    p_from: f.from,
    p_to: f.to,
    p_group_by: groupBy,
    p_slot: f.slot ?? null,
    p_version: f.versionId ?? null,
    p_symbol: f.symbol ?? null,
  });
  if (error) throw new Error(error.message);
  return (data as Bucket[] | null) ?? [];
}

/** Every version ever published, with its lifetime numbers. Tens of rows. */
export async function fetchVersions(): Promise<VersionStats[]> {
  const { data, error } = await supabase()
    .from('strategy_version_stats')
    .select('*')
    .order('uploaded_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data as VersionStats[] | null) ?? [];
}

/** The full JSON of one version — fetched only when the copy button is pressed. */
export async function fetchVersionJson(id: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase()
    .from('strategy_versions')
    .select('strategy_json')
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return (data?.['strategy_json'] as Record<string, unknown>) ?? {};
}

/**
 * Raw signals. The only place that reads the big table, and it is capped.
 *
 * Rows older than 30 days are pruned once their day is rolled up, so this
 * returns nothing for an old range — by design. The aggregate survives; the
 * per-signal detail does not.
 */
export async function fetchSignals(f: StatsFilter, limit = 200, outcome?: string): Promise<SignalRow[]> {
  let q = supabase()
    .from('signals')
    .select('*')
    .gte('created_at', `${f.from}T00:00:00Z`)
    .lte('created_at', `${f.to}T23:59:59Z`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (f.slot) q = q.eq('slot', f.slot);
  if (f.versionId) q = q.eq('strategy_version_id', f.versionId);
  if (f.symbol) q = q.eq('symbol', f.symbol);
  if (outcome) q = q.eq('outcome', outcome);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as SignalRow[] | null) ?? [];
}

/**
 * Wilson score interval.
 *
 * Not Wald (p ± 1.96·√(p(1−p)/n)): its coverage collapses at small n and near
 * the edges, and it produces bounds outside [0,100] that have to be clamped —
 * and clamping an interval means the interval was wrong.
 */
export function wilson(wins: number, decided: number): { low: number; high: number } | null {
  if (decided < 1) return null;
  const z = 1.96;
  const p = wins / decided;
  const d = 1 + (z * z) / decided;
  const centre = (p + (z * z) / (2 * decided)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / decided + (z * z) / (4 * decided * decided))) / d;
  return { low: (centre - margin) * 100, high: (centre + margin) * 100 };
}

export type Verdict = 'insufficient' | 'losing' | 'breakeven' | 'above' | 'proven';

/**
 * How a rate should be READ, not just displayed.
 *
 * 50% is not the bar — break-even is. A 54% strategy is not "slightly
 * profitable", it is inside the band where an 80–90% payout returns the stake
 * and nothing more, and colouring it green would be a lie told in CSS.
 */
export function verdictFor(wins: number, losses: number): Verdict {
  const decided = wins + losses;
  if (decided < MIN_TRADES) return 'insufficient';
  const rate = (wins / decided) * 100;
  const ci = wilson(wins, decided);
  if (rate < BREAKEVEN_LOW) return 'losing';
  if (rate < BREAKEVEN_HIGH) return 'breakeven';
  if (ci && ci.low > BREAKEVEN_HIGH) return 'proven';
  return 'above';
}

export function rateText(wins: number, losses: number): string {
  const decided = wins + losses;
  if (decided < MIN_TRADES) return `عيّنة غير كافية (${decided})`;
  return `${((wins / decided) * 100).toFixed(1)}%`;
}
