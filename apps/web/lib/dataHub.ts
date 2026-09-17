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
import { adminSecret } from './adminAuth';
import { isQuotaActive, noteHubResponse, reportResumed, setQuotaProbe } from './quota';

export type DataMode = 'supabase' | 'mirror' | 'd1';

/**
 * Tables that stay on Supabase whatever the mode says.
 *
 * ── THE LIST IS EMPTY, AND THAT IS THE POINT ───────────────────────────────
 *
 * It held the signal pipeline while four Postgres functions still owned it, and
 * then `configs` while the proxy still read and wrote that table with the
 * service key. Both have moved: the pipeline was ported and compared row by
 * row, and the scraper now routes its tables through the hub, including the
 * five config rows the browser and the scraper hand to each other —
 * `telegram`, `otc_scan`, `otc_status`, `otc_token`, `captcha_balance`.
 *
 * The mechanism stays because the reason for it will come back. A table has to
 * be read from the database it is written TO, and the moment one writer moves
 * without the other, this is where that gets recorded — with the names of both
 * writers, not just the table.
 *
 * ── THE ONE THING STILL READ FROM SUPABASE ─────────────────────────────────
 *
 * `configs.data_source`, and not through this list. `boot` fetches it directly,
 * because a flag that says which database to use cannot live in the database it
 * controls: that is exactly the row you need when that database is unreachable.
 * It is a single read of a single row on cold start, and it is the rollback.
 */
const SUPABASE_ONLY: ReadonlySet<string> = new Set([]);

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

/**
 * One filter: equals a value, or is one of a list.
 *
 * The list form is what makes the admin's bulk operations possible in a
 * browser. Global VIP patches every user row, and one request per user is not
 * an operation that finishes.
 */
interface Filter {
  column: string;
  value?: unknown;
  ne?: unknown;
  values?: unknown[];
  gte?: unknown;
  lte?: unknown;
}

/**
 * How many ids one request may name.
 *
 * The hub refuses a longer list rather than truncating it, so this number has
 * to be the same number. It is deliberately not exported from there and
 * imported here — the two packages do not share a build — so a change on one
 * side that is not made on the other shows up as a 400 with the cap in the
 * message, rather than as a silent partial write.
 */
export const MAX_IN_VALUES = 80;

/**
 * Columns the SQLite schema spells differently from Postgres.
 *
 * Only renames belong here — a column whose TYPE changed (boolean to 1/0,
 * jsonb to TEXT) is handled at the value, because the name still matches and
 * the caller still finds it. A renamed column is the dangerous one: the caller
 * asks for `vip_expiry`, D1 has no such column, and depending on where the name
 * was used the answer is either a 400 or a silent `undefined`.
 *
 * Applied in both directions — outgoing on the columns asked for, filtered on
 * and ordered by; incoming on the rows that come back.
 */
const ALIASES: Record<string, Record<string, string>> = {
  users: { vip_expiry: 'vip_expiry_ms', created_at: 'created_ms' },
  repair_log: { at: 'at_ms', created_at: 'created_ms' },
  signals: { created_at: 'created_ms', bar_time: 'bar_ms', outcome_at: 'outcome_ms' },
  strategy_versions: { uploaded_at: 'uploaded_ms' },
  strategy_version_stats: { uploaded_at: 'uploaded_ms' },
};

/** The D1 spelling of a column the app names in the Postgres way. */
const aliasOut = (table: string, column: string): string =>
  ALIASES[table]?.[column] ?? column;

/**
 * Columns that are `jsonb` in Postgres and TEXT in SQLite.
 *
 * ── WHY THIS CANNOT BE LEFT TO THE CALL SITES ──────────────────────────────
 *
 * Because the value still arrives, still has a type, and is still truthy. A
 * config read from Postgres is an object; the same row read from D1 is the
 * STRING `'{"enabled":true}'`. `data['enabled']` on that string is `undefined`
 * — not an error — so an admin screen renders every switch off, and saving the
 * form writes those offs back over the real settings.
 *
 * `signalHistoryStore` already carried a hand-written guard for exactly this,
 * with a comment describing the same loss. One guard per call site is a rule
 * that holds until somebody adds the next call site.
 *
 * Only columns declared `CHECK (json_valid(...))` in the D1 schema belong here.
 */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  candles: ['data'],
  price_snapshot: ['data'],
  configs: ['data'],
  clicks: ['data'],
  signal_history: ['signals'],
  signals: ['rules_matched', 'candle_snapshot'],
  strategy_versions: ['strategy_json'],
  push_subscriptions: ['subscription', 'symbols'],
};

/** Parses the JSON columns of a row coming back from D1. */
function jsonIn(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const columns = JSON_COLUMNS[table];
  if (columns === undefined) return row;
  const out = { ...row };
  for (const column of columns) {
    const value = out[column];
    if (typeof value !== 'string') continue;
    try {
      out[column] = JSON.parse(value);
    } catch {
      // Left as the string. The CHECK constraint makes this close to
      // impossible, and replacing it with null would destroy the row's
      // contents on the next save.
    }
  }
  return out;
}

/** Serialises the JSON columns of a row on its way to D1. */
function jsonOut(table: string, values: Record<string, unknown>): Record<string, unknown> {
  const columns = JSON_COLUMNS[table];
  if (columns === undefined) return values;
  const out = { ...values };
  for (const column of columns) {
    if (!(column in out)) continue;
    const value = out[column];
    // Already a string means it was serialised by the caller; JSON.stringify
    // would then store a quoted string of a string.
    if (typeof value === 'string' || value === null || value === undefined) continue;
    out[column] = JSON.stringify(value);
  }
  return out;
}

/**
 * A filter value, in the form D1 stores — applied at the boundary, not earlier.
 *
 * SQLite has no boolean, so `enabled = true` filters nothing: `String(true)` is
 * `'true'`, and the column holds 1. The comparison is valid, runs, and returns
 * no rows — which reads as "there are no enabled pairs" rather than as an
 * error, and the backtest that asked quietly measures nothing.
 *
 * It converts HERE, where the request is serialised, and not in `.eq()`, so the
 * Supabase path still sends Postgres a real boolean. Converting at the call
 * site would have handed `'1'` to a `boolean` column in the mode that is the
 * rollback target.
 */
const hubValue = (value: unknown): string => {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
};

/**
 * A time filter's value, in the units the aliased column stores.
 *
 * The app filters by ISO strings — `created_at >= '2026-09-01T00:00:00Z'` —
 * because that is what Postgres holds. The D1 column is `created_ms`, holding
 * an integer, and comparing an integer column to the string '2026-…' in SQLite
 * compares across storage classes: every integer sorts below every string, so
 * `created_ms >= '2026-09-01…'` is false for every row and `<=` is true for
 * all of them. Neither errors. The range simply stops meaning anything.
 */
const timeValue = (table: string, column: string, value: unknown): unknown => {
  if (aliasOut(table, column) === column) return value;       // not a renamed time column
  if (!aliasOut(table, column).endsWith('_ms')) return value;
  if (typeof value === 'number') return value;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : value;
};

/**
 * Headers every hub request carries.
 *
 * The admin secret goes on whenever this browser holds one. It is not
 * conditional on the page: a hub that refuses the write is the check, and a
 * client deciding for itself which requests "are admin requests" is a second,
 * weaker copy of a rule that already exists in one place.
 */
function hubHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  // The account id is a claim, not a credential — the hub scopes to it and
  // refuses everything else regardless. Sending it is what makes an
  // owner-scoped read possible at all.
  if (accountId) headers['x-account-id'] = accountId;
  const secret = adminSecret();
  if (secret) headers['x-admin-secret'] = secret;
  return headers;
}

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
  if (cols && cols.length > 0 && !cols.includes('*')) {
    params.set('cols', cols.map((c) => aliasOut(table, c)).join(','));
  }
  for (const f of filters) {
    const column = aliasOut(table, f.column);
    if (f.gte !== undefined) {
      params.append('gte', `${column}:${hubValue(timeValue(table, f.column, f.gte))}`);
    }
    if (f.lte !== undefined) {
      params.append('lte', `${column}:${hubValue(timeValue(table, f.column, f.lte))}`);
    }
    if (f.gte !== undefined || f.lte !== undefined) continue;
    if (f.ne !== undefined) {
      params.append('ne', `${column}:${hubValue(timeValue(table, f.column, f.ne))}`);
      continue;
    }
    if (f.values) {
      params.append('in', `${column}:${f.values.map((v) => hubValue(timeValue(table, f.column, v))).join(',')}`);
    } else {
      params.append('eq', `${column}:${hubValue(timeValue(table, f.column, f.value))}`);
    }
  }
  if (order) {
    params.set('order', `${aliasOut(table, order.column)}.${order.desc ? 'desc' : 'asc'}`);
  }
  if (limit !== null) params.set('limit', String(limit));
  if (count) params.set('count', '1');

  const res = await fetch(`${hubUrl}/v1/${table}?${params}`, { headers: hubHeaders() });
  if (!res.ok) {
    // The quota is noted before the error is raised, so the pause screen goes
    // up on the same failed read that discovered it.
    await noteHubResponse(res);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`${res.status} ${body.error ?? ''}`.trim());
  }
  // A read that succeeds while a lockout is recorded means it is over — the
  // cheapest possible way to find out, since the read was happening anyway.
  if (isQuotaActive()) reportResumed();
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
    this.filters.push({ column, value });
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters.push({ column, values: [...values] });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push({ column, gte: value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ column, ne: value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push({ column, lte: value });
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { column, desc: opts?.ascending === false };
    return this;
  }

  limit(n: number): this { this.rowLimit = n; return this; }

  /**
   * One row or null — never an error for "no rows", same as Supabase.
   *
   * ── THIS USED TO RETURN AN ARRAY, AND IT COST REAL DATA ─────────────────
   *
   * The flag was set and never read, so through the hub `maybeSingle()` handed
   * back `[row]` where Supabase hands back `row`. Nothing threw. Call sites
   * split into two camps and both were wrong in one mode:
   *
   *   `data?.['data']`  read a config out of an array → undefined → the admin
   *                     screen rendered blank and saved the blank back
   *   `data?.[0]`       read a row out of an object in Supabase mode → the
   *                     same thing in the other direction
   *
   * A different SHAPE is a loud failure; a different NAME on the same shape is
   * a silent one. Returning a distinct type is what makes the compiler catch
   * the call sites rather than leaving them to be found in production.
   */
  maybeSingle(): SingleQuery<Row> {
    this.single = true;
    this.rowLimit = 1;
    return new SingleQuery<Row>(this);
  }

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
      const rows = body.rows
        .map((row) => timesBack(this.table, row))
        .map((row) => jsonIn(this.table, row));
      return { data: rows as Row[], error: null };
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
      eq: (c: string, v: unknown) => typeof q;
      neq: (c: string, v: unknown) => typeof q;
      in: (c: string, v: unknown[]) => typeof q;
      gte: (c: string, v: unknown) => typeof q;
      lte: (c: string, v: unknown) => typeof q;
      order: (c: string, o: { ascending: boolean }) => typeof q;
      limit: (n: number) => typeof q;
      then: unknown;
    };
    for (const f of this.filters) {
      if (f.gte !== undefined) q = q.gte(f.column, f.gte);
      if (f.lte !== undefined) q = q.lte(f.column, f.lte);
      if (f.gte !== undefined || f.lte !== undefined) continue;
      if (f.ne !== undefined) { q = q.neq(f.column, f.ne); continue; }
      q = f.values ? q.in(f.column, f.values) : q.eq(f.column, f.value);
    }
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

/**
 * The result of `maybeSingle()`: the same query, unwrapped to one row.
 *
 * A wrapper rather than a flag on `Query` so the returned type differs, which
 * is the whole point — `{ data: Row | null }` and `{ data: Row[] | null }` are
 * not assignable to each other, so every call site had to be looked at when
 * this was fixed.
 */
class SingleQuery<Row> implements PromiseLike<{ data: Row | null; error: Error | null }> {
  constructor(private readonly query: Query<Row>) {}

  async run(): Promise<{ data: Row | null; error: Error | null }> {
    const { data, error } = await this.query.run();
    return { data: data?.[0] ?? null, error };
  }

  then<R1 = { data: Row | null; error: Error | null }, R2 = never>(
    onFulfilled?: ((v: { data: Row | null; error: Error | null }) => R1 | PromiseLike<R1>) | null,
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
   * Insert, not upsert.
   *
   * The two are different answers to "this row already exists": upsert
   * overwrites it, insert refuses. The admin's add-a-broker and add-a-pair
   * forms want the refusal — a duplicate there is a mistake, and silently
   * replacing the existing row would lose whatever it held.
   */
  async insert(values: Record<string, unknown>): Promise<{ error: Error | null }> {
    if (mode !== 'd1' || staysOnSupabase(this.name)) {
      const { error } = await supabase().from(this.name).insert(values);
      return { error: error as Error | null };
    }
    return this.hubWrite('insert', values, []);
  }

  /**
   * Synchronous, like the Supabase builder it stands in for.
   *
   * It returned a Promise<WriteChain> at first, which made every call site
   * write `(await update(x)).eq(...)` — and an awaited chain that has not been
   * given its `.eq()` yet is an UPDATE with no WHERE waiting to happen.
   */
  update(values: Record<string, unknown>): WriteChain {
    return new WriteChain(this.name, 'update', values);
  }

  /**
   * Also synchronous, and for a sharper version of the same reason.
   *
   * An awaited DELETE that has not been given its `.eq()` yet is
   * `DELETE FROM <table>` — the whole table, silently, reporting success. The
   * hub refuses an unfiltered delete outright, but the shape that cannot be
   * awaited early is what stops the attempt being made.
   */
  delete(): WriteChain {
    return new WriteChain(this.name, 'delete', {});
  }

  private async hubWrite(
    op: 'insert' | 'upsert' | 'update' | 'delete',
    values: Record<string, unknown>,
    where: Filter[],
  ): Promise<{ error: Error | null }> {
    try {
      const res = await fetch(`${hubUrl}/v1/${this.name}`, {
        method: 'POST',
        headers: hubHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ op, values: jsonOut(this.name, values), where }),
      });
      if (!res.ok) {
        await noteHubResponse(res);
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

/**
 * An UPDATE or a DELETE, waiting for the rows it applies to.
 *
 * One class for both because they differ in exactly one thing — whether there
 * are values — and everything that matters here is the part they share: a
 * filter chain that must not be empty when it runs.
 */
class WriteChain {
  private filters: Filter[] = [];
  constructor(
    private readonly table: string,
    private readonly op: 'update' | 'delete',
    private readonly values: Record<string, unknown>,
  ) {}

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }

  /**
   * Names the rows explicitly.
   *
   * An empty list means no rows — never every row. The hub agrees, turning it
   * into a `0 = 1` clause rather than dropping it, and both sides have to,
   * because "delete the ids in this empty array" is a no-op that a dropped
   * clause turns into "delete everything".
   */
  in(column: string, values: readonly unknown[]): this {
    this.filters.push({ column, values: [...values] });
    return this;
  }

  /**
   * Returns how many rows actually changed, as well as the error.
   *
   * `rows` is the half that lets a caller tell "nothing matched" from "it
   * worked". The Telegram review queue depends on it: an approve click filters
   * on `status = 'pending'` so a row already decided in another tab updates
   * nothing, and a filtered update matching nothing is not an error.
   *
   * `null` when the write went to Supabase, which does not report it without
   * asking for the rows back.
   */
  async run(): Promise<{ error: Error | null; rows: number | null }> {
    if (this.filters.length === 0) {
      // Refused here as well as at the hub. The hub's refusal protects the
      // database; this one gives the call site an error it can read without a
      // network round trip, and holds even in Supabase mode — where nothing
      // refuses it at all.
      const message = `${this.op} on '${this.table}' with no filter`;
      hubStats.errors++;
      hubStats.lastError = message;
      return { error: new Error(message), rows: null };
    }

    if (mode !== 'd1' || staysOnSupabase(this.table)) return this.viaSupabase();

    const res = await fetch(`${hubUrl}/v1/${this.table}`, {
      method: 'POST',
      headers: hubHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        op: this.op,
        values: jsonOut(this.table, this.values),
        where: this.filters.map((f) => (f.values
          ? { column: aliasOut(this.table, f.column), values: f.values.map(hubValue) }
          : { column: aliasOut(this.table, f.column), value: hubValue(f.value) })),
      }),
    });
    if (!res.ok) {
      await noteHubResponse(res);
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const message = `${res.status} ${body.error ?? ''}`.trim();
      hubStats.errors++;
      hubStats.lastError = `${this.table} ${this.op}: ${message}`;
      return { error: new Error(message), rows: null };
    }
    const body = (await res.json().catch(() => ({}))) as { rows?: number };
    return { error: null, rows: typeof body.rows === 'number' ? body.rows : null };
  }

  private async viaSupabase(): Promise<{ error: Error | null; rows: number | null }> {
    const base = supabase().from(this.table);
    let q = (this.op === 'delete' ? base.delete() : base.update(this.values)) as unknown as {
      eq: (c: string, v: unknown) => typeof q;
      in: (c: string, v: unknown[]) => typeof q;
    };
    for (const f of this.filters) {
      q = f.values ? q.in(f.column, f.values) : q.eq(f.column, f.value);
    }
    const { error } = await (q as unknown as Promise<{ error: Error | null }>);
    return { error, rows: null };
  }

  then<R1, R2 = never>(
    onFulfilled?: ((v: { error: Error | null; rows: number | null }) => R1 | PromiseLike<R1>) | null,
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

/**
 * Asks the hub whether the secret this browser holds is accepted.
 *
 * ── WHY THIS DOES NOT GO THROUGH `db()` ────────────────────────────────────
 *
 * Because `db()` honours the data mode, and in `supabase` mode it would not
 * touch the hub at all — the read would go to Postgres, where `repair_log` is
 * readable with the anon key, succeed, and report that ANY typed password was
 * correct. A gate that opens for every password in one of three modes is not a
 * gate.
 *
 * The credential belongs to the hub, so the question is asked of the hub
 * directly, in every mode. `hubUrl` is empty only when no hub is configured;
 * then there is nothing to verify against and sign-in fails closed.
 *
 * Returns the HTTP status so the caller can tell "wrong secret" (401/403) from
 * "the Worker is unreachable" — which must not be reported as a bad password,
 * or the admin goes looking for a credential that was never the problem.
 */
export async function hubAcceptsAdmin(): Promise<{ ok: boolean; status: number; detail: string }> {
  if (hubUrl === '') return { ok: false, status: 0, detail: 'no hub configured' };
  const secret = adminSecret();
  if (secret === null) return { ok: false, status: 0, detail: 'no secret held' };

  try {
    // Admin-only, one row, and nothing in it worth having. The point is the
    // status code, not the body.
    const res = await fetch(`${hubUrl}/v1/repair_log?cols=id&limit=1`, {
      headers: { 'x-admin-secret': secret },
    });
    if (res.ok) return { ok: true, status: res.status, detail: '' };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, detail: body.error ?? '' };
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The inverse of `ALIASES`, applied to rows coming BACK from D1.
 *
 * `vip_expiry` became `vip_expiry_ms` and `created_at` became `created_ms` in
 * the SQLite schema, and the write path has always translated. The read path
 * did not, so every caller asking a D1 `users` row for `vip_expiry` got
 * `undefined` — and `undefined` is not an error, it is "no expiry". A paid VIP
 * account read back as one with no expiry date on it at all.
 *
 * Driven by the same table the outgoing direction uses, so the two cannot
 * describe different sets of columns.
 *
 * A renamed column is the worst kind of change to leave untranslated: a
 * changed TYPE throws somewhere, a changed NAME just answers undefined.
 */
function timesBack(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const [iso, ms] of Object.entries(ALIASES[table] ?? {})) {
    if (!(ms in out)) continue;
    const value = out[ms];
    delete out[ms];
    // Back to the ISO string the app has always read, so nothing downstream
    // has to know which database answered.
    out[iso] = typeof value === 'number' && Number.isFinite(value)
      ? new Date(value).toISOString()
      : null;
  }
  return out;
}

/**
 * The recovery check the quota store runs after the reset.
 *
 * One row of `pairs`: public, tiny, and a real D1 read, which is the only
 * thing that can tell a lifted quota from one that is still in force.
 * `hubRead` already clears the state on success, so this only has to say
 * whether it got an answer.
 */
setQuotaProbe(async () => {
  if (hubUrl === '') return false;
  try {
    await hubRead('pairs', ['id'], [], null, 1, false, null);
    return true;
  } catch {
    return false;
  }
});

/** The entry point. `db().from('candles').select('*').eq('key', k)`. */
export function db(): { from: <Row = Record<string, unknown>>(table: string) => Table<Row> } {
  return { from: <Row,>(table: string) => new Table<Row>(table) };
}
