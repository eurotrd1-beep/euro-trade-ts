/**
 * What the edge is allowed to cache, and for how long.
 *
 * ── WHY THIS IS WORTH A TEST ───────────────────────────────────────────────
 *
 * Two of the three cached paths feed a chart. The third feeds the STRATEGY, and
 * the failure modes are not the same shape at all.
 *
 * A chart served a stale window redraws sixty seconds behind and catches up on
 * the next poll — visible, harmless, self-correcting. The strategy served a
 * stale window does something else: `onCandleClose` reads the newest CLOSED
 * bar, so a window from before that bar existed makes it evaluate the previous
 * one a second time and never see the one in between. A skipped candle, with
 * nothing raised anywhere — in the one part of this project that is most
 * careful about exactly that.
 *
 * So `/api/otc/candles-bulk` is cached, because it was the last thing making
 * the origin grow with users, but it is never served stale and its TTL cannot
 * span a minute boundary twice. Those two facts are what this file pins; the
 * Worker is a deployed artefact and a number changed here changes what the
 * strategy sees.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  fileURLToPath(new URL('../../worker/src/index.ts', import.meta.url)),
  'utf8',
);

/** The TTL map, read out of the source so the two cannot drift. */
const ttls = (): Record<string, number> => {
  const body = SRC.match(/const CACHE_TTL: Record<string, number> = \{([\s\S]*?)\n\};/);
  if (body === null) throw new Error('CACHE_TTL is not shaped as expected');
  const out: Record<string, number> = {};
  for (const m of body[1]!.matchAll(/'([^']+)':\s*(\d+)/g)) out[m[1]!] = Number(m[2]);
  return out;
};

describe('what gets cached', () => {
  it('caches the bulk sweep — the last per-user cost at the origin', () => {
    // Everything else collapses onto one origin fetch however many people are
    // watching. This one was called once per candle close per user.
    expect(ttls()['/api/otc/candles-bulk']).toBeDefined();
  });

  it('still caches the chart paths', () => {
    expect(ttls()['/api/otc/candles']).toBe(15);
    expect(ttls()['/api/otc/status']).toBe(10);
  });

  it('caches nothing else by accident', () => {
    // `/health` and `/api/alert` must keep reaching the origin: one is a
    // liveness check and the other has side effects.
    expect(Object.keys(ttls()).sort()).toEqual(
      ['/api/otc/candles', '/api/otc/candles-bulk', '/api/otc/status'].sort(),
    );
  });
});

describe('the bulk TTL, which is the strategy input', () => {
  const bulk = () => ttls()['/api/otc/candles-bulk']!;

  it('cannot span a one-minute candle boundary twice', () => {
    // At 60 s a cached window could be two boundaries old and the bar between
    // them would never be seen. Anything under 30 leaves no room for that.
    expect(bulk()).toBeGreaterThan(0);
    expect(bulk()).toBeLessThan(30);
  });

  it('is not longer than the chart paths', () => {
    // The chart can afford to be behind. The strategy cannot, so if these ever
    // diverge the strategy must be the fresher one.
    expect(bulk()).toBeLessThanOrEqual(ttls()['/api/otc/candles']!);
  });
});

describe('staleness', () => {
  it('is never served for the bulk sweep', () => {
    expect(SRC).toMatch(/STALE_TTL: Record<string, number> = \{[\s\S]*'\/api\/otc\/candles-bulk':\s*0/);
  });

  it('is still served for the chart paths', () => {
    expect(SRC).toContain('const STALE_TTL_DEFAULT = 60;');
  });

  it('is checked before a stale copy goes out', () => {
    // Without the `stale > 0` guard a zero window still passes `age < ttl + 0`
    // for the whole TTL and the bulk path would serve stale after all.
    expect(SRC).toContain('if (stale > 0 && age < (ttl + stale) * 1000)');
  });

  it('still falls back to a stale copy when the origin is down', () => {
    // An expired window beats an error page, for every path. This is the one
    // place stale bulk is the right answer — the alternative is nothing at all.
    expect(SRC).toContain("if (hit) return serve(hit, 'STALE');");
  });
});

describe('WebSockets stay out of it', () => {
  it('passes upgrades straight through', () => {
    // A cached WebSocket upgrade is not a thing, and the price hub's traffic
    // must never touch this path.
    expect(SRC).toContain("=== 'websocket'");
    expect(SRC).toContain('return fetch(target, request);');
  });
});
