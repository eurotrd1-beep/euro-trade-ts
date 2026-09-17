/**
 * The pg_dump reader the parity test now depends on.
 *
 * Its failure mode is quiet: a field containing a tab, read naively, splits in
 * two and shifts every column after it by one. The parity test would then
 * compare misaligned data and pass or fail for reasons unrelated to the port.
 * So the reader decodes escapes, and refuses a row whose field count is wrong.
 *
 * The fixtures are built from parts rather than written as one literal, so the
 * backslashes pg_dump uses cannot be quietly collapsed on the way into this
 * file — which is exactly what happened to the first version of it.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pgBool, pgNumber, pgTime, readTable } from '../parity/backup.js';

const BS = String.fromCharCode(92);          // one backslash
const TAB = '\t';
const NL = '\n';
const END = BS + '.';                         // pg_dump's end-of-data marker
const NULL = BS + 'N';                        // pg_dump's NULL

const block = (table: string, cols: string, ...rows: string[]): string =>
  `COPY public.${table} (${cols}) FROM stdin;${NL}${rows.join(NL)}${NL}${END}${NL}`;

const dump = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dump-'));
  const path = join(dir, 'data.sql');
  writeFileSync(path, body);
  return path;
};

describe('readTable', () => {
  it('reads the columns in the order the header declares', () => {
    const p = dump(block('t', 'b, a', `2${TAB}1`));
    expect(readTable(p, 't')).toEqual([{ b: '2', a: '1' }]);
  });

  it('reads the NULL marker as null, not as text', () => {
    const p = dump(block('t', 'a, b', `${NULL}${TAB}x`));
    expect(readTable(p, 't')).toEqual([{ a: null, b: 'x' }]);
  });

  it('decodes an escaped tab instead of splitting on it', () => {
    // The case that would shift every later column by one.
    const p = dump(block('t', 'json, after', `{"k":"a${BS}tb"}${TAB}last`));
    expect(readTable(p, 't')).toEqual([{ json: '{"k":"a\tb"}', after: 'last' }]);
  });

  it('decodes newlines and backslashes', () => {
    const p = dump(block('t', 'a', `line1${BS}nline2 ${BS}${BS} end`));
    expect(readTable(p, 't')[0]!['a']).toBe(`line1\nline2 ${BS} end`);
  });

  it('refuses a row with the wrong number of fields', () => {
    const p = dump(block('t', 'a, b, c', `1${TAB}2`));
    expect(() => readTable(p, 't')).toThrow(/2 fields where 3 were declared/);
  });

  it('does not confuse two tables whose names share a prefix', () => {
    const p = dump(block('signals_x', 'a', 'wrong') + block('signals', 'a', 'right'));
    expect(readTable(p, 'signals')).toEqual([{ a: 'right' }]);
  });

  it('says so when the table is not in the dump', () => {
    const p = dump(block('other', 'a', '1'));
    expect(() => readTable(p, 'signals')).toThrow(/no COPY block for signals/);
  });

  it('copes with CRLF line endings', () => {
    const p = dump(block('t', 'a, b', `1${TAB}2`).replace(/\n/g, '\r\n'));
    expect(readTable(p, 't')).toEqual([{ a: '1', b: '2' }]);
  });

  it('reads an empty table as no rows', () => {
    const p = dump(`COPY public.t (a) FROM stdin;${NL}${END}${NL}`);
    expect(readTable(p, 't')).toEqual([]);
  });
});

describe('the value parsers', () => {
  it('reads a pg timestamptz exactly, microseconds included', () => {
    expect(pgTime('2026-08-18 17:13:46.471614+00')).toBe(Date.UTC(2026, 7, 18, 17, 13, 46, 471));
    expect(pgTime('2026-08-18 17:12:00+00')).toBe(Date.UTC(2026, 7, 18, 17, 12, 0));
  });

  it('honours a non-UTC offset', () => {
    expect(pgTime('2026-08-18 20:12:00+03')).toBe(Date.UTC(2026, 7, 18, 17, 12, 0));
  });

  it('refuses a timestamp it cannot read rather than returning NaN', () => {
    // NaN would put a signal on no day, and the aggregate would silently lose it.
    expect(() => pgTime('not a time')).toThrow(/unparseable/);
  });

  it('passes NULL through', () => {
    expect(pgTime(null)).toBeNull();
    expect(pgNumber(null)).toBeNull();
  });

  it('reads numbers and booleans the way pg prints them', () => {
    expect(pgNumber('92.5')).toBe(92.5);
    expect(pgBool('t')).toBe(true);
    expect(pgBool('f')).toBe(false);
    expect(pgBool(null)).toBe(false);
  });
});
