/**
 * The IN filter, and the guarantee it must not break.
 *
 * It exists for one caller: the admin's global-VIP switch, which patches every
 * user row. Without it that is one HTTP request per user from a browser, and
 * with a thousand users the operation is not finishable.
 *
 * The risk it introduces is that a filter is now a LIST, and a list is the kind
 * of thing that gets truncated, emptied, or trusted. Each of those has a wrong
 * answer that looks like success:
 *
 *   truncated  — updates some of the rows named and reports all of them done
 *   emptied    — `IN ()` dropped becomes "no filter", which is the whole table
 *   trusted    — `values: 'abc'` reaching the builder throws inside a .map
 *
 * So: over the cap is refused, an empty list means no rows, and anything that
 * is not one of the two filter shapes never reaches the builder at all.
 */

import { describe, expect, it } from 'vitest';
import { MAX_IN_VALUES, buildSelect, buildWrite, parseFilters, parseQuery } from '../src/db.js';
import type { Caller } from '../src/access.js';

const admin: Caller = { kind: 'admin' };
const service: Caller = { kind: 'service' };
const owner = (id: string): Caller => ({ kind: 'user', accountId: id });

const list = (n: number): string[] => Array.from({ length: n }, (_, i) => `id-${i}`);

describe('IN on a read', () => {
  it('binds every value rather than writing any of them into the SQL', () => {
    const built = buildSelect(
      { table: 'users', columns: ['id'], where: [{ column: 'id', values: ['a', 'b', 'c'] }],
        order: null, limit: 10, count: false },
      admin,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.statement.sql).toContain('"id" IN (?, ?, ?)');
    expect(built.statement.sql).not.toContain('a');
    expect(built.statement.binds).toEqual(['a', 'b', 'c', 10]);
  });

  it('refuses a list longer than the cap instead of trimming it', () => {
    // Trimming would read some of the rows asked for and look like all of them.
    const built = buildSelect(
      { table: 'users', columns: ['id'], where: [{ column: 'id', values: list(MAX_IN_VALUES + 1) }],
        order: null, limit: 10, count: false },
      admin,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.status).toBe(400);
    expect(built.reason).toContain(String(MAX_IN_VALUES));
  });

  it('accepts a list exactly at the cap', () => {
    const built = buildSelect(
      { table: 'users', columns: ['id'], where: [{ column: 'id', values: list(MAX_IN_VALUES) }],
        order: null, limit: 10, count: false },
      admin,
    );
    expect(built.ok).toBe(true);
  });

  it('reads an empty list as no rows, never as no filter', () => {
    const built = buildSelect(
      { table: 'users', columns: ['id'], where: [{ column: 'id', values: [] }],
        order: null, limit: 10, count: false },
      admin,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.statement.sql).toContain('0 = 1');
  });

  it('still refuses a column that is not on the table', () => {
    const built = buildSelect(
      { table: 'users', columns: ['id'], where: [{ column: 'nope', values: ['a'] }],
        order: null, limit: 10, count: false },
      admin,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.status).toBe(400);
  });
});

describe('IN cannot widen an owner scope', () => {
  it('ANDs the scope clause in front of the list', () => {
    // A user asking for a hundred ids gets their own rows among them and
    // nothing else, because the two clauses intersect.
    const built = buildSelect(
      { table: 'signal_history', columns: null,
        where: [{ column: 'updated_ms', values: ['100', '200'] }],
        order: null, limit: 10, count: false },
      owner('acct-1'),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const where = built.statement.sql.slice(built.statement.sql.indexOf('WHERE'));
    expect(where.indexOf('account_id')).toBeLessThan(where.indexOf('IN ('));
    expect(built.statement.binds[0]).toBe('acct-1');
  });

  it('cannot be used to name other accounts', () => {
    const built = buildSelect(
      { table: 'signal_history', columns: null,
        where: [{ column: 'account_id', values: ['acct-2', 'acct-3'] }],
        order: null, limit: 10, count: false },
      owner('acct-1'),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Both clauses survive, so the result is the intersection: nothing.
    expect(built.statement.sql).toContain('"account_id" = ?');
    expect(built.statement.sql).toContain('"account_id" IN (?, ?)');
    expect(built.statement.binds).toEqual(['acct-1', 'acct-2', 'acct-3', 10]);
  });
});

describe('IN on a write', () => {
  it('updates the rows it names', () => {
    const built = buildWrite(
      { table: 'users', op: 'update', values: { role: 'vip' },
        where: [{ column: 'id', values: ['a', 'b'] }] },
      admin,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.statement.sql).toMatch(/^UPDATE/);
    expect(built.statement.sql).toContain('"id" IN (?, ?)');
    expect(built.statement.binds).toEqual(['vip', 'a', 'b']);
  });

  it('counts an empty list as a filter, so the write is not refused — and matches nothing', () => {
    // The distinction matters: "update the rows in this empty set" is a valid
    // no-op, while "update with no WHERE" is the whole table. The first must
    // not be turned into the second by dropping the clause.
    const built = buildWrite(
      { table: 'users', op: 'update', values: { role: 'vip' },
        where: [{ column: 'id', values: [] }] },
      admin,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.statement.sql).toContain('0 = 1');
    expect(built.statement.sql).not.toMatch(/UPDATE "users" SET "role" = \?$/);
  });

  it('refuses an over-long list on a delete as well', () => {
    const built = buildWrite(
      { table: 'pairs', op: 'delete', values: {},
        where: [{ column: 'id', values: list(MAX_IN_VALUES + 1) }] },
      admin,
    );
    expect(built.ok).toBe(false);
  });

  it('keeps an owner-scoped write scoped', () => {
    const built = buildWrite(
      { table: 'signal_history', op: 'update', values: { signals: '[]' },
        where: [{ column: 'updated_ms', values: ['100', '200'] }] },
      owner('acct-1'),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.statement.sql).toContain('"account_id" = ?');
    expect(built.statement.binds).toContain('acct-1');
  });
});

describe('parseFilters, on the body of a POST', () => {
  it('takes both shapes', () => {
    expect(parseFilters([{ column: 'id', value: 'a' }, { column: 'role', values: ['x', 'y'] }]))
      .toEqual([{ column: 'id', value: 'a' }, { column: 'role', values: ['x', 'y'] }]);
  });

  it('drops anything that is not a filter', () => {
    expect(parseFilters([
      null,
      'id=1',
      42,
      {},
      { column: '' },
      { column: 'id' },                 // neither value nor values
      { column: 'id', value: null },
      { column: 'id', values: 'a,b' },  // a string, not a list — the 500 case
    ])).toEqual([]);
  });

  it('is not an array in, is nothing out', () => {
    for (const raw of [undefined, null, 'id:1', 7, { column: 'id', value: 'a' }]) {
      expect(parseFilters(raw)).toEqual([]);
    }
  });

  it('stringifies values so a number filter still binds', () => {
    expect(parseFilters([{ column: 'order', value: 3 }])).toEqual([{ column: 'order', value: '3' }]);
    expect(parseFilters([{ column: 'order', values: [1, 2] }]))
      .toEqual([{ column: 'order', values: ['1', '2'] }]);
  });

  it('leaves a malformed body unable to produce an unfiltered write', () => {
    // Everything was dropped, so the builder sees no filters — and refuses.
    const built = buildWrite(
      { table: 'users', op: 'delete', values: {}, where: parseFilters([{ bad: true }]) },
      service,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toContain('at least one filter');
  });
});

describe('in= on the query string', () => {
  it('splits on commas', () => {
    const q = parseQuery('users', new URLSearchParams('in=id:a,b,c'));
    expect(q.where).toEqual([{ column: 'id', values: ['a', 'b', 'c'] }]);
  });

  it('reads an empty list as empty, not as one blank value', () => {
    const q = parseQuery('users', new URLSearchParams('in=id:'));
    expect(q.where).toEqual([{ column: 'id', values: [] }]);
  });

  it('coexists with eq', () => {
    const q = parseQuery('users', new URLSearchParams('eq=role:vip&in=id:a,b'));
    expect(q.where).toEqual([
      { column: 'role', value: 'vip' },
      { column: 'id', values: ['a', 'b'] },
    ]);
  });

  it('ignores a parameter with no column', () => {
    expect(parseQuery('users', new URLSearchParams('in=:a,b')).where).toEqual([]);
  });
});

describe('range filters', () => {
  it('binds both bounds and picks the operators itself', () => {
    const built = buildSelect(
      { table: 'signals', columns: ['id'],
        where: [{ column: 'created_ms', gte: '100', lte: '200' }],
        order: null, limit: 10, count: false },
      admin,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.statement.sql).toContain('"created_ms" >= ?');
    expect(built.statement.sql).toContain('"created_ms" <= ?');
    expect(built.statement.binds).toEqual(['100', '200', 10]);
  });

  it('takes one bound on its own', () => {
    const built = buildSelect(
      { table: 'signals', columns: ['id'], where: [{ column: 'created_ms', gte: '100' }],
        order: null, limit: 10, count: false },
      admin,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.statement.sql).toContain('>= ?');
    expect(built.statement.sql).not.toContain('<= ?');
  });

  it('still refuses an unknown column', () => {
    const built = buildSelect(
      { table: 'signals', columns: ['id'], where: [{ column: 'nope', gte: '1' }],
        order: null, limit: 10, count: false },
      admin,
    );
    expect(built.ok).toBe(false);
  });

  it('cannot widen an owner scope', () => {
    const built = buildSelect(
      { table: 'signal_history', columns: null, where: [{ column: 'updated_ms', gte: '1' }],
        order: null, limit: 10, count: false },
      owner('acct-1'),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.statement.sql).toContain('"account_id" = ?');
    expect(built.statement.binds[0]).toBe('acct-1');
  });

  it('parses gte= and lte= off the query string', () => {
    const q = parseQuery('signals', new URLSearchParams('gte=created_ms:100&lte=created_ms:200'));
    expect(q.where).toEqual([
      { column: 'created_ms', gte: '100' },
      { column: 'created_ms', lte: '200' },
    ]);
  });

  it('drops a range whose bounds are all null, rather than leaving a filter with no clause', () => {
    // A filter that produces no clause would let `buildWrite` believe the
    // caller named some rows when it named none — and an UPDATE that believes
    // that is an UPDATE over the whole table.
    expect(parseFilters([{ column: 'created_ms', gte: null, lte: null }])).toEqual([]);
    const built = buildWrite(
      { table: 'signals', op: 'delete', values: {},
        where: parseFilters([{ column: 'created_ms', gte: null }]) },
      service,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toContain('at least one filter');
  });

  it('keeps a range on a write scoped to the rows it names', () => {
    const built = buildWrite(
      { table: 'signals', op: 'delete', values: {},
        where: parseFilters([{ column: 'created_ms', lte: 5 }]) },
      service,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.statement.sql).toContain('"created_ms" <= ?');
    expect(built.statement.binds).toEqual(['5']);
  });
});
