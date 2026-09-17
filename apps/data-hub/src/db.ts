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
  POLICY,
  type Caller,
} from './access.js';

/**
 * One filter: a column equals a value, or is one of a list.
 *
 * `values` exists for the admin's bulk operations — global VIP patches every
 * user row, and without it that is one HTTP request per user from a browser.
 * It is still an equality test, just several of them ORed, so nothing about
 * the scope guarantee changes: the list is ANDed with the scope clause like
 * any other filter, and a list naming other people's rows intersects to none.
 */
export interface Filter {
  column: string;
  /** Exactly one of these three is set. */
  value?: string;
  values?: readonly string[];
  /** A range bound: `>=` when `gte`, `<=` when `lte`. Both may be given. */
  gte?: string;
  lte?: string;
}

/**
 * How many values one IN list may carry.
 *
 * D1 caps bound parameters per statement, and the SET clause of an UPDATE
 * spends some of that allowance before the WHERE gets any. Eighty leaves room
 * for a wide row and still turns a thousand-user patch into thirteen requests
 * instead of a thousand.
 *
 * A longer list is refused rather than truncated. Truncating would update some
 * of the rows the caller named and report success for all of them.
 */
export const MAX_IN_VALUES = 80;

/** A parsed, not-yet-authorised read. Every field comes from the request. */
export interface Query {
  table: string;
  /** null means every declared column. */
  columns: readonly string[] | null;
  /** Equality and IN — enough for every read the app and the admin make. */
  where: ReadonlyArray<Filter>;
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

/**
 * The same cap for the service, which legitimately scans whole tables.
 *
 * The scraper reads every push subscription to send to it, and every enabled
 * symbol to know what to stream. Those are full reads by nature, and the cap
 * exists to stop a browser walking the candle table — not to stop the one
 * process that owns the rows.
 *
 * Five thousand rows is a twentieth of one percent of the five million daily
 * row reads, so the budget argument does not apply at this size.
 */
export const MAX_LIMIT_SERVICE = 5000;

/**
 * How many rows one write request may carry.
 *
 * The asset scan upserts the whole Pocket Option catalogue — hundreds of rows —
 * and one HTTP request per row is hundreds of round trips from a server in
 * Frankfurt to a Worker. They are sent as a batch instead: one request, one
 * prepared statement per row, applied together.
 *
 * Capped so a single request cannot be made arbitrarily large, and because
 * every row still counts against the daily write budget whether it arrives
 * alone or in company.
 */
export const MAX_ROWS_PER_WRITE = 250;

/** Quoted, so a column called `order` — which `pairs` has — is not a syntax error. */
const quote = (identifier: string): string => `"${identifier}"`;

/**
 * Turns the request's filters into clauses, or says why it will not.
 *
 * Shared by the read and the write path deliberately. They had the same loop
 * written twice, and a rule about what may be filtered on is exactly the kind
 * of thing that gets fixed in one copy.
 *
 * It appends — the caller has already pushed the scope clause, and appending
 * after it is what makes the scope un-widenable: two clauses on one column are
 * ANDed, so a filter naming another owner narrows to nothing rather than
 * replacing anything.
 */
function appendFilters(
  table: string,
  filters: ReadonlyArray<Filter>,
  clauses: string[],
  binds: unknown[],
): { ok: true } | { ok: false; status: number; reason: string } {
  for (const filter of filters) {
    const column = columnNamed(table, filter.column);
    if (column === null) {
      return { ok: false, status: 400, reason: `unknown filter column '${filter.column}'` };
    }

    // A range. Both bounds may appear on one filter, and both are bound
    // parameters like every other value — the operator is the only thing
    // chosen here, and it is chosen from two literals, never from the request.
    if (filter.gte !== undefined || filter.lte !== undefined) {
      if (filter.gte !== undefined) {
        clauses.push(`${quote(column)} >= ?`);
        binds.push(filter.gte);
      }
      if (filter.lte !== undefined) {
        clauses.push(`${quote(column)} <= ?`);
        binds.push(filter.lte);
      }
      continue;
    }

    if (filter.values !== undefined) {
      if (filter.values.length === 0) {
        // `IN ()` is a syntax error in SQLite, and the honest reading of an
        // empty list is "no rows" — so say that, rather than dropping the
        // clause and matching everything, which is the dangerous reading.
        clauses.push('0 = 1');
        continue;
      }
      if (filter.values.length > MAX_IN_VALUES) {
        return {
          ok: false,
          status: 400,
          reason: `'${filter.column}' names ${filter.values.length} values, over the ${MAX_IN_VALUES} allowed`,
        };
      }
      clauses.push(`${quote(column)} IN (${filter.values.map(() => '?').join(', ')})`);
      binds.push(...filter.values);
      continue;
    }

    clauses.push(`${quote(column)} = ?`);
    binds.push(filter.value);
  }
  return { ok: true };
}

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

  const filtered = appendFilters(table, query.where, clauses, binds);
  if (!filtered.ok) return filtered;

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
  const cap = caller.kind === 'service' ? MAX_LIMIT_SERVICE : MAX_LIMIT;
  const limit = Number.isFinite(query.limit) && query.limit > 0
    ? Math.min(Math.floor(query.limit), cap)
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

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * A write, as asked for. Every field comes from the request.
 *
 * Four operations and no more. There is no "run this statement" and no
 * expression language, because every write the app and the scraper make is one
 * of these four, and anything wider is a second way in.
 */
export interface Write {
  table: string;
  op: 'insert' | 'upsert' | 'update' | 'delete';
  /** Column → value, for insert, upsert and update. */
  values: Readonly<Record<string, unknown>>;
  /** Which rows, for update and delete. */
  where: ReadonlyArray<Filter>;
}

/**
 * Builds the write, or refuses.
 *
 * ── THE RULE THAT MATTERS MOST ─────────────────────────────────────────────
 *
 * An owner may not write outside themselves, and there are three separate ways
 * to try:
 *
 *   1. UPDATE or DELETE without the scope — every account's rows at once. The
 *      scope clause is ANDed in, exactly as for a read.
 *   2. INSERT a row owned by somebody else — the owner column is OVERWRITTEN
 *      with the caller's own id, whatever the body said. Not refused,
 *      overwritten: refusing would break an honest client that sends its own
 *      id anyway, and overwriting is the same answer for both.
 *   3. UPDATE the owner column, moving a row to another account. Refused
 *      outright, because there is no honest version of that request.
 *
 * Only the first has an analogue in the read path. The other two are why this
 * is a separate function rather than a flag on the last one.
 */
export function buildWrite(write: Write, caller: Caller): Built {
  const table = tableNamed(write.table);
  if (table === null) {
    return { ok: false, status: 404, reason: `no such table '${write.table}'` };
  }

  const decision = decide(table, 'write', caller);
  if (!decision.allowed) {
    return { ok: false, status: 403, reason: decision.reason };
  }

  const policy = POLICY[table]!;
  const owner = decision.scope;

  // ── The values, resolved to declared columns ────────────────────────────
  const sets: Array<{ column: string; value: unknown }> = [];
  for (const [rawColumn, value] of Object.entries(write.values)) {
    const column = columnNamed(table, rawColumn);
    if (column === null) {
      return { ok: false, status: 400, reason: `unknown column '${rawColumn}' on '${table}'` };
    }
    // (3) Moving a row to another owner. No honest client does this.
    if (owner && column === owner.column && write.op === 'update') {
      return { ok: false, status: 403, reason: `'${column}' cannot be changed` };
    }
    sets.push({ column, value });
  }

  // (2) The owner column is set from the credential, never from the body.
  if (owner && (write.op === 'insert' || write.op === 'upsert')) {
    const existing = sets.findIndex((s) => s.column === owner.column);
    if (existing >= 0) sets.splice(existing, 1);
    sets.unshift({ column: owner.column, value: owner.value });
  }

  if (write.op !== 'delete' && sets.length === 0) {
    return { ok: false, status: 400, reason: 'nothing to write' };
  }

  // ── The WHERE, for update and delete ────────────────────────────────────
  const clauses: string[] = [];
  const whereBinds: unknown[] = [];
  if (owner) {
    // (1) Same clause as the read path, same reason: without it the statement
    // is valid, succeeds, and changes everybody's rows.
    clauses.push(`${quote(owner.column)} = ?`);
    whereBinds.push(owner.value);
  }
  const filtered = appendFilters(table, write.where, clauses, whereBinds);
  if (!filtered.ok) return filtered;

  if ((write.op === 'update' || write.op === 'delete') && clauses.length === 0) {
    // An UPDATE or DELETE with no WHERE is the whole table. It is a legal
    // statement, it reports success, and there is no undo. A service caller
    // has to name the rows.
    return { ok: false, status: 400, reason: `${write.op} needs at least one filter` };
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';

  const columns = sets.map((s) => s.column);
  const valueBinds = sets.map((s) => s.value);

  switch (write.op) {
    case 'delete':
      return {
        ok: true, columns: [],
        statement: { sql: `DELETE FROM ${quote(table)}${where}`, binds: whereBinds },
      };

    case 'update': {
      const assign = columns.map((c) => `${quote(c)} = ?`).join(', ');
      return {
        ok: true, columns,
        statement: {
          sql: `UPDATE ${quote(table)} SET ${assign}${where}`,
          binds: [...valueBinds, ...whereBinds],
        },
      };
    }

    case 'insert': {
      const placeholders = columns.map(() => '?').join(', ');
      return {
        ok: true, columns,
        statement: {
          sql: `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')})` +
            ` VALUES (${placeholders})`,
          binds: valueBinds,
        },
      };
    }

    case 'upsert': {
      // The conflict target is the declared primary key, never anything from
      // the request. A wrong target does not fail — it stops matching, and
      // every upsert silently becomes an insert.
      const conflict = policy.conflictTarget ?? policy.primaryKey.map(quote).join(', ');
      // A key column is not updated on conflict: it is what was matched on,
      // and assigning it to itself is noise at best.
      const updatable = columns.filter((c) => !policy.primaryKey.includes(c));
      if (updatable.length === 0) {
        return { ok: false, status: 400, reason: 'an upsert needs a column that is not the key' };
      }
      const assign = updatable.map((c) => `${quote(c)} = excluded.${quote(c)}`).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      return {
        ok: true, columns,
        statement: {
          sql: `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')})` +
            ` VALUES (${placeholders}) ON CONFLICT (${conflict}) DO UPDATE SET ${assign}`,
          binds: valueBinds,
        },
      };
    }
  }
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
/**
 * Filters out of a request BODY, reduced to the two shapes that exist.
 *
 * The POST handler used to pass `body.where` through untouched whenever it was
 * an array, which meant the shape of a filter was whatever the caller sent.
 * `{ column: 'id', values: 'not-an-array' }` would reach the builder and throw
 * on `.map`, answering a malformed request with a 500. Everything that is not
 * one of the two shapes is dropped here instead.
 *
 * Dropping is safe in the direction that matters: a filter that disappears
 * makes an UPDATE or DELETE match MORE rows, but the builder refuses one with
 * no filters at all, so the worst case is a refusal rather than a wide write.
 */
export function parseFilters(raw: unknown): Filter[] {
  if (!Array.isArray(raw)) return [];
  const out: Filter[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const f = item as { column?: unknown; value?: unknown; values?: unknown };
    if (typeof f.column !== 'string' || f.column.length === 0) continue;

    if (Array.isArray(f.values)) {
      out.push({ column: f.column, values: f.values.map((v) => String(v)) });
      continue;
    }

    const range = f as { gte?: unknown; lte?: unknown };
    if (range.gte !== undefined || range.lte !== undefined) {
      const bounds: Filter = { column: f.column };
      if (range.gte !== undefined && range.gte !== null) bounds.gte = String(range.gte);
      if (range.lte !== undefined && range.lte !== null) bounds.lte = String(range.lte);
      // A range whose only bounds were null carries no clause at all, and a
      // filter with no clause would make an UPDATE wider. Dropped instead.
      if (bounds.gte !== undefined || bounds.lte !== undefined) out.push(bounds);
      continue;
    }
    if (f.value !== undefined && f.value !== null) {
      out.push({ column: f.column, value: String(f.value) });
    }
  }
  return out;
}

export function parseQuery(table: string, params: URLSearchParams): Query {
  const cols = params.get('cols');
  const where: Filter[] = [];
  for (const raw of params.getAll('eq')) {
    // Split once: a value may legitimately contain a colon (an ISO time, a
    // URL), and splitting on every one would silently truncate it.
    const at = raw.indexOf(':');
    if (at <= 0) continue;
    where.push({ column: raw.slice(0, at), value: raw.slice(at + 1) });
  }

  // `gte=col:value` and `lte=col:value`, one clause each.
  for (const [param, key] of [['gte', 'gte'], ['lte', 'lte']] as const) {
    for (const raw of params.getAll(param)) {
      const at = raw.indexOf(':');
      if (at <= 0) continue;
      where.push({ column: raw.slice(0, at), [key]: raw.slice(at + 1) });
    }
  }

  // `in=col:a,b,c`. Comma-separated, so a value containing a comma cannot be
  // expressed this way — no read makes one today, and the write path takes its
  // lists as JSON where the question does not arise.
  for (const raw of params.getAll('in')) {
    const at = raw.indexOf(':');
    if (at <= 0) continue;
    const list = raw.slice(at + 1);
    where.push({
      column: raw.slice(0, at),
      // An explicitly empty list stays empty rather than becoming ['']: the
      // builder turns it into `0 = 1`, which is what "one of nothing" means.
      values: list.length === 0 ? [] : list.split(','),
    });
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
