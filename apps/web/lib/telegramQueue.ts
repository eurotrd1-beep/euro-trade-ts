/**
 * The manual-publishing queue — reads and the one write the admin is allowed.
 *
 * In manual mode (`configs.telegram.mode = 'manual'`) the generator on Render
 * writes the finished message into `telegram_queue` instead of sending it, and
 * waits for `status` to become `approved`. Everything in this file is one side
 * of that: read what is waiting, and record the decision.
 *
 * The browser can do exactly two things to a row — approve it or reject it —
 * and only while it is still `pending`. That is enforced by RLS and a
 * column-level grant (see `20260819_telegram_queue.sql`), not by this file;
 * what is here is the same rule stated once more so a caller does not have to
 * read the migration to know why an update silently affected no rows.
 */

import { supabase, type TelegramQueueRow } from '@euro/shared';

export type { TelegramQueueRow };

/** How many decided rows the review page keeps on screen. */
const HISTORY_LIMIT = 30;

export const KIND_LABEL: Record<TelegramQueueRow['kind'], string> = {
  signal: 'فتح إشارة',
  result: 'نتيجة صفقة',
  daily: 'ملخص اليوم',
};

export const STATUS_LABEL: Record<TelegramQueueRow['status'], string> = {
  pending: 'مستنية',
  approved: 'اتوافق عليها — بتتبعت',
  sent: 'اتبعتت',
  rejected: 'اتجاهلت',
};

/** Everything still waiting on a decision, oldest first — that is the order they matter in. */
export async function fetchPending(): Promise<TelegramQueueRow[]> {
  const { data, error } = await supabase()
    .from('telegram_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as TelegramQueueRow[];
}

/** The last decisions, newest first — approved-but-not-yet-sent shows up here. */
export async function fetchDecided(): Promise<TelegramQueueRow[]> {
  const { data, error } = await supabase()
    .from('telegram_queue')
    .select('*')
    .neq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw error;
  return (data ?? []) as TelegramQueueRow[];
}

/** Pending count for the sidebar badge — `head` so no rows cross the wire. */
export async function countPending(): Promise<number> {
  const { count, error } = await supabase()
    .from('telegram_queue')
    .select('event_key', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (error) throw error;
  return count ?? 0;
}

/**
 * Records the decision.
 *
 * `status = 'pending'` is repeated in the filter deliberately. The row may
 * have expired, been decided from another open tab, or been sent by the
 * generator between the page loading and the button being pressed; matching on
 * `pending` makes a stale click update nothing instead of overwriting a
 * decision that already happened. The RLS policy says the same thing — this is
 * the half that lets the caller find out, because a filtered update that
 * matches nothing is not an error.
 */
export async function decide(
  eventKey: string,
  status: 'approved' | 'rejected',
): Promise<boolean> {
  const { data, error } = await supabase()
    .from('telegram_queue')
    .update({ status })
    .eq('event_key', eventKey)
    .eq('status', 'pending')
    .select('event_key');
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Distinguishes concurrent subscribers; see `watchQueue`. */
let watcherSeq = 0;

/**
 * Live updates for as long as the page is open.
 *
 * A signal is worth publishing for the length of one trade. Waiting for a
 * refresh to find out it arrived is the same as not getting it, so the queue
 * is watched rather than polled — and the callback just asks the caller to
 * re-read, because the rows are few and a delta merge would be more code with
 * more ways to drift from the table.
 */
export function watchQueue(onChange: () => void): () => void {
  const channel = supabase()
    // Numbered, not a fixed name. The sidebar badge and the review page both
    // watch, and two channels sharing one topic on the same client is the
    // shape where one of them silently stops receiving.
    .channel(`telegram_queue:${++watcherSeq}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'telegram_queue' },
      () => onChange(),
    )
    .subscribe();

  return () => {
    void supabase().removeChannel(channel);
  };
}

/** True once the message is too late to be worth sending. */
export function isExpired(row: TelegramQueueRow, now: number): boolean {
  return row.expires_at !== null && Date.parse(row.expires_at) <= now;
}

/**
 * The result of a trade whose opening was rejected.
 *
 * The two share everything after the prefix, so `result:EURUSD:…` belongs to
 * `signal:EURUSD:…`. Publishing the result of an opening that was never
 * published is the one mistake this screen can make that the channel cannot
 * take back — it shows readers a call they were never given — so the row is
 * flagged rather than left to be spotted.
 */
export function orphanedResult(row: TelegramQueueRow, all: TelegramQueueRow[]): boolean {
  if (row.kind !== 'result') return false;
  const suffix = row.event_key.replace(/^result:/, '');
  return all.some((r) => r.event_key === `signal:${suffix}` && r.status === 'rejected');
}

/**
 * Arabic counts one, two, a few (3–10) and many (11+) differently, and a
 * screen that reads «من 3 دقيقة» looks like a machine wrote it — which is the
 * wrong impression for the one screen where a person is being asked to decide.
 */
function count(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** «من ٣ دقايق» — how long the message has been waiting. */
export function arabicAge(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 1) return 'دلوقتي';
  if (mins < 60) return `من ${count(mins, 'دقيقة', 'دقيقتين', 'دقايق', 'دقيقة')}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `من ${count(hrs, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`;
  return `من ${count(Math.round(hrs / 24), 'يوم', 'يومين', 'أيام', 'يوم')}`;
}

/** «باقي ٤ دقايق» / «فات وقتها» for a row that carries an expiry. */
export function arabicRemaining(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'فات وقتها';
  const mins = Math.ceil(ms / 60000);
  if (mins === 1) return 'باقي أقل من دقيقة';
  if (mins < 60) return `باقي ${count(mins, 'دقيقة', 'دقيقتين', 'دقايق', 'دقيقة')}`;
  return `باقي ${count(Math.round(mins / 60), 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`;
}
