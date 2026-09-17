/**
 * Where a signal waits when D1 cannot take it.
 *
 * ── THE GAP THIS CLOSES, AND IT IS A NARROW ONE ────────────────────────────
 *
 * The generator already survives a short outage by itself: a failed write puts
 * the batch back in memory and the next flush tries again. What it cannot
 * survive is the PROCESS going away during the outage — a Render restart, a
 * redeploy, a crash — because memory goes with it. The signals it was holding
 * were generated, were never recorded, and cannot be regenerated: the candles
 * that produced them have moved on.
 *
 * So the hub takes ownership instead. When D1 refuses a record call, the rows
 * go into this object's own storage and the call returns success. From that
 * moment the generator has nothing to hold, a restart costs nothing, and the
 * rows are replayed into D1 once it answers again.
 *
 * ── WHY A DURABLE OBJECT, AND NOT SUPABASE OR A FILE ───────────────────────
 *
 * Its storage is its own SQLite database, separate from D1 — a D1 outage does
 * not take it down. It is durable across restarts, unlike Render's disk. And
 * it is never idle-paused, unlike a free Supabase project, which would pause
 * after a week of the inactivity that a buffer used only during outages has by
 * definition.
 *
 * ── ONE OWNER AT A TIME ────────────────────────────────────────────────────
 *
 * The reason the call returns SUCCESS when it spools. If it returned an error,
 * the generator would keep the rows in memory as well, and both would replay
 * them. Every signal the running strategy writes has `strategy_version_id =
 * NULL`, and NULLs are distinct in a unique index, so `ON CONFLICT DO NOTHING`
 * never fires — a double replay is a duplicate row, which is exactly how 38
 * of them appeared this morning.
 *
 * So ownership moves in one step: D1 has the rows, or the spool has them, or
 * (if the spool itself fails) the generator still has them. Never two.
 *
 * ── AND WHY THE REPLAY CHECKS BEFORE IT INSERTS ────────────────────────────
 *
 * Because "one owner" is true of the handover and not of the replay. A replay
 * inserts a row and then deletes it from here; if the insert lands and the
 * delete does not, the next replay would insert it again, and the unique index
 * would not stop it. The check uses `IS` for the version, which treats NULL as
 * equal to NULL — the comparison the index itself cannot make.
 */

import { VERSION_SENTINEL, type IncomingSignal } from './pipeline.js';

/** A spooled batch, exactly as the generator sent it, plus when it arrived. */
export interface SpooledRow {
  id: number;
  /** When the record call was made — the time the row WOULD have been written. */
  at_ms: number;
  row: IncomingSignal;
}

/** How many rows one drain moves. Keeps a single cron run bounded. */
export const DRAIN_BATCH = 200;

/**
 * Does D1 already hold this signal?
 *
 * The identity the data actually has: version, symbol, timeframe, bar and slot
 * — the same five the unique index is built on, written as the same expression
 * so the planner can use it. A COALESCE on one side and a bare column on the
 * other would not match the index, and every check would scan the table.
 *
 * It was `strategy_version_id IS ?` while the index was the old four-column
 * one. That worked because `IS` compares NULL to NULL, which the index could
 * not; now the index does the substituting instead, and the query has to say
 * it the same way.
 *
 * Still needed even though ON CONFLICT now catches duplicates: a replay
 * inserts and then acknowledges, and an insert that lands whose acknowledgement
 * is lost would otherwise be retried. ON CONFLICT would refuse it silently,
 * which is correct — but the check makes the drain's own count honest about
 * what it moved.
 */
export const EXISTS_SQL =
  'SELECT 1 FROM "signals"' +
  ` WHERE COALESCE("strategy_version_id", '${VERSION_SENTINEL}') = COALESCE(?, '${VERSION_SENTINEL}')` +
  ' AND "symbol" = ? AND "timeframe" = ? AND "bar_ms" = ? AND "slot" = ? LIMIT 1';

export const existsBinds = (r: IncomingSignal): unknown[] => [
  r.strategy_version_id ?? null, r.symbol, r.timeframe, r.bar_ms, r.slot,
];

/**
 * The object itself. One named instance holds every spooled row.
 *
 * Its whole interface is four calls, all made by the hub Worker and never by a
 * browser — the binding is not reachable from the internet, only from code
 * running in this Worker.
 */
export class SignalSpool implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(private readonly state: DurableObjectState) {
    this.sql = state.storage.sql;
    // `parked_ms` is set on a row D1 rejected for its CONTENT during a replay.
    // It is kept, not deleted — a signal is never discarded silently — but it
    // is skipped, so one bad row cannot stop every row behind it from ever
    // being written.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS spool (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms      INTEGER NOT NULL,
      row        TEXT NOT NULL,
      parked_ms  INTEGER,
      error      TEXT
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/put' && request.method === 'POST') {
      const body = (await request.json()) as { rows?: unknown; at_ms?: unknown };
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const at = typeof body.at_ms === 'number' ? body.at_ms : Date.now();
      // One transaction: a batch is spooled whole or not at all, for the same
      // reason `record_signals` refuses a batch whole rather than writing half.
      this.state.storage.transactionSync(() => {
        for (const row of rows) {
          this.sql.exec('INSERT INTO spool (at_ms, row) VALUES (?, ?)', at, JSON.stringify(row));
        }
      });
      return Response.json({ spooled: rows.length, depth: this.depth() });
    }

    if (url.pathname === '/take' && request.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || DRAIN_BATCH, DRAIN_BATCH);
      const rows = this.sql
        .exec<{ id: number; at_ms: number; row: string }>(
          'SELECT id, at_ms, row FROM spool WHERE parked_ms IS NULL ORDER BY id LIMIT ?', limit)
        .toArray()
        .map((r): SpooledRow => ({ id: r.id, at_ms: r.at_ms, row: JSON.parse(r.row) as IncomingSignal }));
      return Response.json({ rows, depth: this.depth() });
    }

    if (url.pathname === '/ack' && request.method === 'POST') {
      const body = (await request.json()) as { ids?: unknown };
      const ids = (Array.isArray(body.ids) ? body.ids : [])
        .map(Number).filter((n) => Number.isInteger(n));
      this.state.storage.transactionSync(() => {
        for (const id of ids) this.sql.exec('DELETE FROM spool WHERE id = ?', id);
      });
      return Response.json({ acked: ids.length, depth: this.depth() });
    }

    if (url.pathname === '/park' && request.method === 'POST') {
      const body = (await request.json()) as { id?: unknown; error?: unknown };
      const id = Number(body.id);
      if (Number.isInteger(id)) {
        this.sql.exec('UPDATE spool SET parked_ms = ?, error = ? WHERE id = ?',
          Date.now(), String(body.error ?? '').slice(0, 500), id);
      }
      return Response.json({ depth: this.depth() });
    }

    if (url.pathname === '/depth') {
      const oldest = this.sql
        .exec<{ at_ms: number | null }>('SELECT MIN(at_ms) AS at_ms FROM spool WHERE parked_ms IS NULL')
        .one().at_ms;
      const parked = this.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM spool WHERE parked_ms IS NOT NULL')
        .one().n;
      return Response.json({ depth: this.depth(), oldest_ms: oldest, parked });
    }

    return new Response('not found', { status: 404 });
  }

  /** Rows still waiting — parked ones are not waiting, they are set aside. */
  private depth(): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM spool WHERE parked_ms IS NULL').one().n;
  }
}
