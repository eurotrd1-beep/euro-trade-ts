'use client';

/**
 * Where the app reads and writes its data — Supabase, D1, or both.
 *
 * ── THE SHAPE IS DELIBERATE ────────────────────────────────────────────────
 *
 * This presents the same fluent chain the Supabase client does, so a call site
 * moves across by changing `supabase()` to `db()` and nothing else. That is
 * not laziness about the API: twenty edited call sites is twenty chances to
 * change a filter by accident during a migration, and a `.eq()` that quietly
 * became a `.neq()` in the middle of a data move is a bug nobody would think
 * to look for. One shim, one place to read, one place to roll back.
 *
 * ── THREE MODES, AND WHY THE MIDDLE ONE EXISTS ─────────────────────────────
 *
 *   supabase   everything from Supabase. The rollback target, and the state
 *              the app is in today.
 *   mirror     READ from D1, WRITE to Supabase. A read that fails falls back
 *              to Supabase.
 *   d1         read and write D1. No fallback.
 *
 * The fallback lives in `mirror` and only in `mirror`, and that is the whole
 * point of having a middle mode. While writes still go to Supabase the two
 * databases hold the same rows, so a fallback returns the same answer and the
 * user sees nothing — the hub can be wrong all afternoon and the app keeps
 * working while the errors show up in the health screen.
 *
 * In `d1` mode the same fallback would be a disaster. Writes would be landing
 * in D1 while reads quietly came from a Supabase that was getting staler by
 * the hour, and everything would look fine: a user's trade history would just
 * stop growing. So in `d1` a failed read is an error, loudly, and the way back
 * is the flag — not a silent second source.
 *
 * ── THE FLAG IS READ FROM SUPABASE, ON PURPOSE ─────────────────────────────
 *
 * `configs.data_source` says which mode is live, and it is fetched from
 * Supabase even in `d1` mode. It has to be: a flag stored in the database it
 * controls cannot be used to switch away from that database when it is down,
 * which is exactly the moment it is needed. Rolling back stays a row edit in
 * a system that is, by definition, still working.
 */

import { supabase } from '@euro/shared';

export type DataMode = 'supabase' | 'mirror' | 'd1';

/**
 * Tables that stay on Supabase whatever the mode says.
 *
 * ── THE SIGNAL PIPELINE IS NOT MOVING ──────────────────────────────────────
 *
 * Four Postgres functions own these — record_signals, resolve_signals,
 * refresh_signal_daily and prune_signals — and the proxy calls all four. They
 * are not helpers around the pipeline; they ARE the pipeline, and
 * resolve_signals decides what a trade's outcome is:
 *
 *     WHEN i.price IS NULL          THEN 'unresolved'
 *     WHEN i.outcome IN (win,loss,tie) THEN i.outcome
 *     ELSE 'unresolved'   -- an outcome nobody understands is NOT a tie
 *
 * Porting that is changing settlement, and a mistake in it does not throw —
 * it changes results. So it stays where it is, and these tables stay with it.
 *
 * ── WHY EACH ONE ───────────────────────────────────────────────────────────
 *
 *   signals              written by record_signals, updated by resolve_signals
 *   signal_daily         built by refresh_signal_daily
 *   signal_write_budget  read and written inside record_signals
 *   strategy_versions    signals.strategy_version_id REFERENCES it. Moving the
 *                        writes would let a version be published to D1 that
 *                        Postgres has never heard of, and the next insert
 *                        would fail a foreign key — a split key is a key that
 *                        has stopped being enforced.
 *
 * The first three were established by listing every table the four functions
 * touch, rather than by judgement: they touch these and nothing else.
 */
const SUPABASE_ONLY: ReadonlySet<string> = new Set([
  'signals',
  'signal_daily',
  'signal_write_budget',
  'strategy_versions',
  // The view over strategy_versions and signal_daily. Its sources stay, so the
  // D1 copy would answer from rows that stopped being updated.
  'strategy_version_stats',
]);

/** True when this table answers from Supabase no matter what the mode is. */
export const staysOnSupabase = (table: string): boolean => SUPABASE_ONLY.has(table);

/**
 * Reads a boolean column from either database.
 *
 * ── WHY THIS IS NOT PARANOIA ───────────────────────────────────────────────
 *
 * SQLite has no boolean type, so every `true` in Postgres arrives from D1 as
 * the number 1. `1 === true` is false in JavaScript, and the app had two
 * checks written exactly that way:
 *
 *   isBanned:      row['is_banned'] === true
 *   guaranteedWin: row['guaranteed_win'] === true
 *
 * The moment the mode flips, the first one lets every banned account back in
 * and the second turns guaranteed-win off for everyone who has it. Nothing
 * errors. Nothing is logged. The screens render, the values are simply false.
 *
 * So there is one function, it accepts both shapes, and it is the only way a
 * boolean column should ever be read.
 */
export function dbBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  // Postgres over some paths, and anything hand-written into a config row.
  if (typeof value === 'string') return value === 'true' || value === 't' || value === '1';
  return false;
}

/** Where the hub lives. Overridden by `configs.data_source.url`. */
let hubUrl = '';
let mode: DataMode = 'supabase';

/**
 * Reads that fell back to Supabase, and reads that failed outright.
 *
 * Surfaced in the health screen rather than logged and forgotten. A migration
 * where "it seems fine" is doing the work of a number is a migration that gets
 * finished on a feeling.
 */
export const hubStats = { reads: 0, fallbacks: 0, errors: 0, lastError: '' };

export function configureDataSource(config: unknown): void {
  const c = (config ?? {}) as { mode?: unknown; url?: unknown };
  mode = c.mode === 'mirror' || c.mode === 'd1' ? c.mode : 'supabase';
  hubUrl = typeof c.url === 'string' ? c.url.replace(/\/+$/, '') : '';
  // A mode that names no hub is a mode that cannot work. Falling back to
  // Supabase is the safe reading of a half-filled config row, and saying so
  // beats discovering it as a wall of failed reads.
  if (mode !== 'supabase' && hubUrl === '') {
    hubStats.lastError = 'data_source names a mode but no url — staying on Supabase';
    mode = 'supabase';
  }
}

export const currentMode = (): DataMode => mode;

// ── The request ─────────────────────────────────────────────────────────────

interface Filter { column: string; value: string }

async function hubRead(
  table: string,
  cols: string[] | null,
  filters: Filter[],
  order: { column: string; desc: boolean } | null,
  limit: number | null,
  count: boolean,
  accountId: string | null,
): Promise<{ rows: Record<string, unknown>[] }> {
  const params = new URLSearchParams();
  if (cols && cols.length > 0 && !cols.includes('*')) params.set('cols', cols.join(','));
  for (const f of filters) params.append('eq', `${f.column}:${f.value}`);
  if (order) params.set('order', `${order.column}.${order.desc ? 'desc' : 'asc'}`);
  if (limit !== null) params.set('limit', String(limit));
  if (count) params.set('count', '1');

  const headers: Record<string, string> = {};
  // The account id is a claim, not a credential — the hub scopes to it and
  // refuses everything else regardless. Sending it is what makes an
  // owner-scoped read possible at all.
  if (accountId) headers['x-account-id'] = accountId;

  const res = await fetch(`${hubUrl}/v1/${table}?${params}`, { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`${res.status} ${body.error ?? ''}`.trim());
  }
  return (await res.json()) as { rows: Record<string, unknown>[] };
}

// ── The chain ───────────────────────────────────────────────────────────────

/**
 * The account whose rows an owner-scoped read is for.
 *
 * Held here rather than passed at every call site because the Supabase client
 * has no equivalent parameter, and adding one to twenty call sites is the
 * churn this shim exists to avoid.
 */
let accountId: string | null = null;
export function setDataAccount(id: string | null): void { accountId = id; }

class Query<Row> implements PromiseLike<{ data: Row[] | null; error: Error | null; count?: number }> {
  private cols: string[] | null = null;
  private filters: Filter[] = [];
  private orderBy: { column: string; desc: boolean } | null = null;
  private rowLimit: number | null = null;
  private wantCount = false;
  private single = false;

  constructor(private readonly table: string) {}

  select(columns = '*', opts?: { count?: 'exact'; head?: boolean }): this {
    this.cols = columns === '*' ? null : columns.split(',').map((c) => c.trim());
    if (opts?.count === 'exact') this.wantCount = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value: String(value) });
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { column, desc: opts?.ascending === false };
    return this;
  }

  limit(n: number): this { this.rowLimit = n; return this; }

  /** One row or null — never an error for "no rows", same as Supabase. */
  maybeSingle(): this { this.single = true; this.rowLimit = 1; return this; }

  async run(): Promise<{ data: Row[] | null; error: Error | null; count?: number }> {
    // Not a fallback — a home. These never reach the hub in any mode.
    if (mode === 'supabase' || staysOnSupabase(this.table)) return this.viaSupabase();

    try {
      hubStats.reads++;
      const body = await hubRead(
        this.table, this.cols, this.filters, this.orderBy, this.rowLimit,
        this.wantCount, accountId,
      );
      if (this.wantCount) {
        const n = Number(body.rows[0]?.['count'] ?? 0);
        return { data: [] as Row[], error: null, count: n };
      }
      return { data: body.rows as Row[], error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      hubStats.lastError = `${this.table}: ${message}`;

      // `mirror` only. In `d1` the two databases have diverged, and a silent
      // second source would serve a stale answer that looks exactly like a
      // fresh one.
      if (mode === 'mirror') {
        hubStats.fallbacks++;
        return this.viaSupabase();
      }
      hubStats.errors++;
      return { data: null, error: new Error(message) };
    }
  }

  private async viaSupabase(): Promise<
    { data: Row[] | null; error: Error | null; count?: number }
  > {
    let q = supabase().from(this.table).select(
      this.cols === null ? '*' : this.cols.join(','),
      this.wantCount ? { count: 'exact' } : undefined,
    ) as unknown as {
      eq: (c: string, v: string) => typeof q;
      order: (c: string, o: { ascending: boolean }) => typeof q;
      limit: (n: number) => typeof q;
      then: unknown;
    };
    for (const f of this.filters) q = q.eq(f.column, f.value);
    if (this.orderBy) q = q.order(this.orderBy.column, { ascending: !this.orderBy.desc });
    if (this.rowLimit !== null) q = q.limit(this.rowLimit);

    const res = (await (q as unknown as Promise<{
      data: Row[] | null; error: Error | null; count?: number;
    }>));
    return res;
  }

  // Awaiting the chain runs it, exactly as the Supabase builder does.
  then<R1 = { data: Row[] | null; error: Error | null; count?: number }, R2 = never>(
    onFulfilled?: ((v: { data: Row[] | null; error: Error | null; count?: number }) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onFulfilled, onRejected);
  }
}

class Table<Row> {
  constructor(private readonly name: string) {}
  select(columns?: string, opts?: { count?: 'exact'; head?: boolean }): Query<Row> {
    return new Query<Row>(this.name).select(columns, opts);
  }

  /**
   * Writes go to whichever database the mode says owns them.
   *
   * There is no fallback here in any mode. A write that lands in one database
   * and not the other is a divergence, and a divergence discovered later
   * cannot be resolved by looking at either side — neither knows it is the one
   * that is wrong.
   */
  async upsert(values: Record<string, unknown>): Promise<{ error: Error | null }> {
    if (mode !== 'd1' || staysOnSupabase(this.name)) {
      const { error } = await supabase().from(this.name).upsert(values);
      return { error: error as Error | null };
    }
    return this.hubWrite('upsert', values, []);
  }

  /**
   * Synchronous, like the Supabase builder it stands in for.
   *
   * It returned a Promise<UpdateChain> at first, which made every call site
   * write `(await update(x)).eq(...)` — and an awaited chain that has not been
   * given its `.eq()` yet is an UPDATE with no WHERE waiting to happen.
   */
  update(values: Record<string, unknown>): UpdateChain {
    return new UpdateChain(this.name, values);
  }

  private async hubWrite(
    op: 'insert' | 'upsert' | 'update' | 'delete',
    values: Record<string, unknown>,
    where: Filter[],
  ): Promise<{ error: Error | null }> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (accountId) headers['x-account-id'] = accountId;
      const res = await fetch(`${hubUrl}/v1/${this.name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ op, values, where }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(`${res.status} ${body.error ?? ''}`.trim());
      }
      return { error: null };
    } catch (e) {
      hubStats.errors++;
      const message = e instanceof Error ? e.message : String(e);
      hubStats.lastError = `${this.name} ${op}: ${message}`;
      return { error: new Error(message) };
    }
  }
}

class UpdateChain {
  private filters: Filter[] = [];
  constructor(
    private readonly table: string,
    private readonly values: Record<string, unknown>,
  ) {}

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value: String(value) });
    return this;
  }

  async run(): Promise<{ error: Error | null }> {
    if (mode !== 'd1' || staysOnSupabase(this.table)) {
      let q = supabase().from(this.table).update(this.values) as unknown as {
        eq: (c: string, v: string) => typeof q;
      };
      for (const f of this.filters) q = q.eq(f.column, f.value);
      const { error } = await (q as unknown as Promise<{ error: Error | null }>);
      return { error };
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accountId) headers['x-account-id'] = accountId;
    const res = await fetch(`${hubUrl}/v1/${this.table}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ op: 'update', values: this.values, where: this.filters }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const message = `${res.status} ${body.error ?? ''}`.trim();
      hubStats.errors++;
      hubStats.lastError = `${this.table} update: ${message}`;
      return { error: new Error(message) };
    }
    return { error: null };
  }

  then<R1, R2 = never>(
    onFulfilled?: ((v: { error: Error | null }) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onFulfilled, onRejected);
  }
}

// ── The two ported Postgres functions ───────────────────────────────────────
//
// Neither is a table read, so neither goes through the chain above. They follow
// the same mode rules: mirror falls back, d1 does not.

/**
 * `signal_stats`, as an aggregate the hub computes.
 *
 * Returns null when the caller should use Supabase — either the mode says so,
 * or the hub failed and we are in a mode that may fall back. Null is "ask the
 * other one", not "no data": an empty array here would render as a screen with
 * no trades on it, which is a different and much worse answer.
 */
export async function statsViaHub(
  params: Record<string, string | null>,
): Promise<Record<string, unknown>[] | null> {
  if (mode === 'supabase') return null;

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null) query.set(k, v);

  try {
    hubStats.reads++;
    const res = await fetch(`${hubUrl}/v1/stats?${query}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const body = (await res.json()) as { rows?: Record<string, unknown>[] };
    return body.rows ?? [];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    hubStats.lastError = `stats: ${message}`;
    if (mode === 'mirror') { hubStats.fallbacks++; return null; }
    hubStats.errors++;
    throw new Error(message);
  }
}

/**
 * `increment_click`, the one thing the public may write.
 *
 * Silent on failure in every mode, which is the behaviour it already had: a
 * counter that did not increment is not a reason to interrupt somebody
 * signing in, and the RPC was fire-and-forget too.
 */
export async function countClick(row: string, field: string): Promise<void> {
  try {
    if (mode === 'd1') {
      await fetch(`${hubUrl}/v1/click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row, field }),
      });
      return;
    }
    await supabase().rpc('increment_click', { row_id: row, field_name: field });
  } catch {
    // Analytics only. A counter that did not increment is not a reason to
    // interrupt a login or block an advert, and neither original awaited a
    // result either.
  }
}

/**
 * A `users` row, written for whichever database owns it.
 *
 * ── TWO COLUMNS DO NOT SURVIVE A STRAIGHT COPY ─────────────────────────────
 *
 * `vip_expiry` is a timestamptz in Postgres and `vip_expiry_ms` an INTEGER in
 * D1; `created_at` and `created_ms` likewise. Sending the Postgres names to D1
 * is refused by the column whitelist, which is the good outcome — the bad one
 * is sending an ISO STRING to a column typed for milliseconds, because SQLite
 * would store it happily and every later comparison against a number would be
 * false. A VIP account whose expiry compares as never-expired, or as
 * always-expired, and no error either way.
 *
 * So the translation lives here, once, rather than at the call site.
 */
export function usersRowFor(values: Record<string, unknown>): Record<string, unknown> {
  if (mode !== 'd1') return values;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === 'vip_expiry' || key === 'created_at') {
      const column = key === 'vip_expiry' ? 'vip_expiry_ms' : 'created_ms';
      if (value === null || value === undefined) { out[column] = null; continue; }
      const ms = typeof value === 'number' ? value : Date.parse(String(value));
      // A date that will not parse is left out rather than written as NaN or
      // 0 — 0 is 1970, which reads as an expiry that passed long ago.
      if (Number.isFinite(ms)) out[column] = Math.round(ms);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The entry point. `db().from('candles').select('*').eq('key', k)`. */
export function db(): { from: <Row = Record<string, unknown>>(table: string) => Table<Row> } {
  return { from: <Row,>(table: string) => new Table<Row>(table) };
}
