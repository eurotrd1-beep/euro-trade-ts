/**
 * Reads tables out of the pg_dump taken before the move.
 *
 * ── WHY THE PARITY TEST READS A FILE NOW ───────────────────────────────────
 *
 * It used to read live Postgres, and live Postgres is going away. The dump in
 * `backup/data.sql` is the same data — every signal and every aggregate as
 * Postgres held them — and as a regression fixture it is BETTER than the live
 * database was: it does not move. A comparison against a table that keeps
 * receiving rows can change its answer between two runs of unchanged code.
 *
 * ── THE FORMAT ─────────────────────────────────────────────────────────────
 *
 * pg_dump's COPY text format, one block per table:
 *
 *     COPY public.signals (id, created_at, …) FROM stdin;
 *     12029\t2026-08-18 17:13:46.471614+00\t…
 *     \.
 *
 * Columns are tab-separated in the order the header names. `\N` is NULL.
 * Backslash escapes (`\\`, `\t`, `\n`, `\r`) are decoded, because a JSON
 * column with a tab or newline in it would otherwise split into extra fields
 * and shift every column after it by one — a silent misalignment, not a crash.
 */

import { readFileSync } from 'node:fs';

export type Row = Record<string, string | null>;

function unescape(field: string): string | null {
  if (field === '\\N') return null;
  if (!field.includes('\\')) return field;
  return field.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case 't': return '\t';
      case 'n': return '\n';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      default: return c; // `\\` → `\`, and anything else is literal
    }
  });
}

/** Every row of one table, as strings — typing is the caller's decision. */
export function readTable(dumpPath: string, table: string): Row[] {
  const text = readFileSync(dumpPath, 'utf8');
  const header = new RegExp(`^COPY public\\.${table} \\(([^)]*)\\) FROM stdin;\\r?$`, 'm');
  const m = header.exec(text);
  if (m === null) throw new Error(`no COPY block for ${table} in ${dumpPath}`);

  const columns = m[1]!.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const start = m.index + m[0].length + 1;
  const end = text.indexOf('\n\\.', start - 1);
  if (end < 0) throw new Error(`COPY block for ${table} is not terminated`);

  const rows: Row[] = [];
  for (const raw of text.slice(start, end).split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    const fields = line.split('\t');
    if (fields.length !== columns.length) {
      // Refused rather than padded or trimmed: a row with the wrong number of
      // fields means the columns after the break are misaligned, and a parity
      // test fed misaligned data can pass or fail for reasons that have
      // nothing to do with the port.
      throw new Error(`${table}: ${fields.length} fields where ${columns.length} were declared`);
    }
    const row: Row = {};
    columns.forEach((c, i) => { row[c] = unescape(fields[i]!); });
    rows.push(row);
  }
  return rows;
}

/**
 * A pg timestamptz as COPY prints it, to milliseconds.
 *
 * `2026-08-18 17:13:46.471614+00` is not a format `Date.parse` promises to
 * accept — the space, the six fractional digits and the bare `+00` are each
 * outside ISO 8601 as JavaScript reads it. Normalised first, and refused if it
 * still does not parse, because a NaN timestamp would land every signal on no
 * day at all.
 */
export function pgTime(value: string | null): number | null {
  if (value === null) return null;
  const iso = value
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')        // micro- to milliseconds
    .replace(/([+-]\d{2})$/, '$1:00');    // +00 → +00:00
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`unparseable timestamp: ${value}`);
  return ms;
}

export const pgNumber = (v: string | null): number | null => (v === null ? null : Number(v));
export const pgBool = (v: string | null): boolean => v === 't';
