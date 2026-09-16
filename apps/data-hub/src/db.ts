/**
 * The only place a SQL statement is built.
 *
 * ── WHAT THIS FILE IS DEFENDING ────────────────────────────────────────────
 *
 * Two things, and they fail in opposite ways.
 *
 * INJECTION fails loudly, eventually. A value spliced into a statement is the
 * oldest hole there is, and the fix is the oldest one too: values are bound,
 * never interpolated. Nothing in here puts a request's value into SQL text.
 *
 * SCOPE fails silently, immediately, and that is the one worth the care. If a
 * per-account query goes out without its `WHERE account_id = ?`, nothing
 * throws. The response is bigger than it should be, the caller renders the
 * first row, and everything looks right — while every account's rows are
 * being handed to whoever asked. Postgres could not make that mistake because
 * RLS added the clause underneath the query. Here, this file is the clause.
 *
 * So the scope is not an argument a caller may pass. It comes back from
 * `decide()` and is ANDed into every statement before any filter the request
 * asked for, and a filter naming the same column cannot widen it — two
 * equality clauses on one column intersect, they do not replace.
 *
 * ── AND WHY IT RETURNS A STATEMENT INSTEAD OF RUNNING ONE ──────────────────
 *
 * Because then the rules can be tested without a database, without an edge,
 * and without a request — the tests read the SQL that would have been sent.
 * A rule about what a query must contain is best checked by looking at it.
 */

import {
  columnNamed,
  columnsFor,
  decide,
  tableNamed,
  type Caller,
} from './access.js';

/** A parsed, not-yet-authorised read. Every field comes from the request. */
export interface Query {
  table: string;
  /** null means every declared column. */
  columns: readonly string[] | null;
  /** Equality filters only — enough for every read the app makes today. */
  where: ReadonlyArray<{ column: string; value: string }>;
  order: { column: string; desc: boolean } | null;
  limit: number;
  /** Ask for the row count instead of the rows. */
  count: boolean;
}

export interface Statement {
  sql: string;
  binds: unknown[];
}

export type Built =
  | { ok: true; statement: Statement; columns: string[] }
  | { ok: false; status: number; reason: string };

/**
 * Row caps.
 *
 * D1's free plan allows five million row READS a day, and one unbounded
 * `SELECT * FROM candles` is a meaningful fraction of that in a single
 * request. The cap is not politeness: going over the limit does not slow
 * anything down, it blocks every query on the database until 00:00 UTC.
 */
export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 100;

/** Quoted, so a column called `order` — which `pairs` has — is not a syntax error. */
const quote = (identifier: string): string => `"${identifier}"`;

/**
 * Builds the SELECT, or refuses.
 *
 * Refusals carry a status because the two kinds are not the same thing to the
 * caller: 403 is "you may not", 400 is "that is not a column". Collapsing them
 * would make a typo look like a permissions problem and send somebody looking
 * for a credential they already have.
 */
export function buildSelect(query: Query, caller: Caller): Built {
  // ── 1. The table must be one we named ───────────────────────────────────
  const table = tableNamed(query.table);
  if (table === null) {
    return { ok: false, status: 404, reason: `no such table '${query.table}'` };
  }

  // ── 2. The gate, before anything else is even resolved ──────────────────
  const decision = decide(table, 'read', caller);
  if (!decision.allowed) {
    return { ok: false, status: 403, reason: decision.reason };
  }

  // ── 3. Columns, resolved to the strings in access.ts ────────────────────
  const columns = columnsFor(table, query.columns);
  if (columns === null) {
    return { ok: false, status: 400, reason: `unknown column in select on '${table}'` };
  }

  // ── 4. The WHERE, scope first ───────────────────────────────────────────
  //
  // The scope clause is appended before the request's own filters and is not
  // optional, not overridable, and not visible to the caller as a parameter.
  // A request that also filters on the owner column ends up with both clauses
  // ANDed — asking for somebody else's rows returns nothing, which is the
  // correct answer rather than an error, because "no rows for you" and "no
  // such row" are the same fact from where the caller stands.
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (decision.scope) {
    clauses.push(`${quote(decision.scope.column)} = ?`);
    binds.push(decision.scope.value);
  }

  for (const filter of query.where) {
    const column = columnNamed(table, filter.column);
    if (column === null) {
      return { ok: false, status: 400, reason: `unknown filter column '${filter.column}'` };
    }
    clauses.push(`${quote(column)} = ?`);
    binds.push(filter.value);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';

  // ── 5. Counting takes the same WHERE, which is the point ────────────────
  if (query.count) {
    return {
      ok: true,
      columns: ['count'],
      statement: { sql: `SELECT COUNT(*) AS "count" FROM ${quote(table)}${where}`, binds },
    };
  }

  // ── 6. Order ────────────────────────────────────────────────────────────
  let order = '';
  if (query.order !== null) {
    const column = columnNamed(table, query.order.column);
    if (column === null) {
      return { ok: false, status: 400, reason: `unknown order column '${query.order.column}'` };
    }
    // ASC/DESC is a keyword, not a value: chosen from two literals here rather
    // than taken from the request in any form.
    order = ` ORDER BY ${quote(column)} ${query.order.desc ? 'DESC' : 'ASC'}`;
  }

  // ── 7. Limit, clamped rather than rejected ──────────────────────────────
  //
  // A request asking for more than the cap gets the cap, not a 400. The cap is
  // there to protect the daily row budget, and a refusal would not save a
  // single row read — it would just leave the caller with nothing.
  const limit = Number.isFinite(query.limit) && query.limit > 0
    ? Math.min(Math.floor(query.limit), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const select = columns.map(quote).join(', ');
  return {
    ok: true,
    columns,
    statement: {
      sql: `SELECT ${select} FROM ${quote(table)}${where}${order} LIMIT ?`,
      binds: [...binds, limit],
    },
  };
}

// ── Parsing a request into a Query ──────────────────────────────────────────

/**
 * Reads a query out of a URL.
 *
 * Deliberately small. It accepts what the app actually asks for today — some
 * columns, some equality filters, an order, a limit, a count — and nothing
 * else. A query language wide enough to express anything is a query language
 * wide enough to express `OR 1=1`, and there is no read in this codebase that
 * needs one.
 *
 *   ?cols=id,role          columns; omitted or `*` means every declared one
 *   ?eq=role:vip&eq=…      equality filters, repeatable
 *   ?order=created_ms.desc
 *   ?limit=50
 *   ?count=1               the count instead of the rows
 */
export function parseQuery(table: string, params: URLSearchParams): Query {
  const cols = params.get('cols');
  const where: Array<{ column: string; value: string }> = [];
  for (const raw of params.getAll('eq')) {
    // Split once: a value may legitimately contain a colon (an ISO time, a
    // URL), and splitting on every one would silently truncate it.
    const at = raw.indexOf(':');
    if (at <= 0) continue;
    where.push({ column: raw.slice(0, at), value: raw.slice(at + 1) });
  }

  const rawOrder = params.get('order');
  let order: Query['order'] = null;
  if (rawOrder !== null && rawOrder.length > 0) {
    const desc = rawOrder.endsWith('.desc');
    const column = rawOrder.replace(/\.(asc|desc)$/, '');
    order = { column, desc };
  }

  return {
    table,
    columns: cols === null || cols.length === 0 ? null : cols.split(','),
    where,
    order,
    limit: Number(params.get('limit') ?? DEFAULT_LIMIT),
    count: params.get('count') === '1',
  };
}
