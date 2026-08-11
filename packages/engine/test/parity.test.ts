/**
 * THE MIGRATION GATE.
 *
 * Every indicator ported to TypeScript is checked against the value the live
 * Dart engine actually produced for the same candles. A mismatch fails the
 * build — that is the whole point of the "خط أحمر": identical output, no drift.
 *
 * Indicators that have not been ported yet are reported, not failed, so the
 * port can proceed one batch at a time without the suite going red for work
 * that simply has not started.
 *
 * Fixture: packages/engine/golden/engine-golden.json
 * Recorded by: tools/golden-dart/test/generate_golden_test.dart
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import golden from '../golden/engine-golden.json' with { type: 'json' };
import { computeIndicator, isRegistered, registeredNames } from '../src/registry.js';
import { makeRule, type Candle } from '../src/types.js';
import '../src/indicators/index.js';

/** Relative tolerance. Identical float64 ops should match exactly; this only
 *  absorbs last-bit noise from transcendental functions (pow/exp/ln), which
 *  are not bit-identical across the Dart VM and V8. Anything larger is a bug. */
const REL_TOLERANCE = 1e-12;

/**
 * Indicators that CANNOT be value-matched, with the reason.
 *
 * This list is deliberately tiny and every entry must be justified — it is the
 * one place where "identical output" is not provable, so it stays visible
 * instead of being silently skipped.
 *
 * `monte_carlo_risk_simulation` draws 200 pseudo-random samples per call
 * (signal_engine.dart:5809). Two runs of the SAME Dart engine on the SAME
 * candles already disagree, so no port could match it. It is still checked for
 * a structurally valid result.
 */
const NON_DETERMINISTIC: Record<string, { reason: string; allowed: readonly string[] }> = {
  monte_carlo_risk_simulation: {
    reason: '200 random samples per call — not reproducible in any runtime',
    allowed: ['bullish', 'bearish', 'neutral', 'none'],
  },
};

interface GoldenFixture {
  candleCount: number;
  indicatorCount: number;
  /** The engine's `_currentPrice` at the moment the fixture was recorded. */
  currentPrice: number;
  realCandlesMode: boolean;
  clock: { utcHour: number; weekday: number; recordedAt: string };
  candles: Array<{
    open: number; high: number; low: number; close: number; volume: number; time: string;
  }>;
  results: Record<string, number | string>;
  errors: Record<string, string>;
}

const fixture = golden as unknown as GoldenFixture;

const candles: Candle[] = fixture.candles.map((c) => ({
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: c.volume,
  time: Date.parse(c.time),
}));

/** Read from the fixture, never re-derived — see the note on the Dart side. */
const currentPrice = fixture.currentPrice;
const clock = fixture.clock;

function closeEnough(actual: number, expected: number): boolean {
  if (Object.is(actual, expected)) return true;
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1);
  return Math.abs(actual - expected) / scale <= REL_TOLERANCE;
}

/** Decodes the tagged non-JSON floats the Dart harness emitted. */
function decodeExpected(v: number | string): number | string {
  if (v === '__NaN__') return NaN;
  if (v === '__Infinity__') return Infinity;
  if (v === '__-Infinity__') return -Infinity;
  return v;
}

describe('engine parity with the Dart implementation', () => {
  const names = Object.keys(fixture.results).sort();

  it('fixture is intact', () => {
    expect(fixture.candles).toHaveLength(fixture.candleCount);
    expect(names.length + Object.keys(fixture.errors).length).toBe(fixture.indicatorCount);
  });

  /**
   * Names the Dart engine has that this engine deliberately does NOT register.
   *
   * They were ported, verified against the fixture, and then disabled because
   * the data they need does not exist — 93 hardcoded placeholders, 20 that read
   * a volume the feed never carries, and kelly_criterion which needs a trade
   * history an indicator is never handed. The implementations are intact under
   * indicators/unavailable/; only the registrations moved.
   *
   * Full reasoning per name: docs/unavailable-indicators.md
   * Audit: scripts/audit-liveness.mts, 2026-08-11.
   */
  /**
   * The audit only ever reports on what is still registered, so it cannot be
   * the source of truth for what was removed — by the final round it lists
   * nothing at all. docs/unavailable-indicators.md is generated from the same
   * runs and does hold the full set, so the names are read back from there.
   */
  const DISABLED = new Set(
    [...readFileSync(new URL('../../../docs/unavailable-indicators.md', import.meta.url), 'utf8')
      .matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1]!),
  );

  /**
   * Registered here, absent from Dart — deliberate additions awaiting a port.
   *
   * Until they exist in Dart, a strategy using one of them scores 0.0 on the
   * old Flutter app, silently, exactly as any unknown name does. That is
   * acceptable only because the Flutter app is being retired; it is not a
   * licence to keep adding to this list.
   *
   * Added 2026-08-11 — the relative level family. The engine can only compare an
   * indicator against a constant, so an indicator answering with a raw price
   * cannot express "the price is at support". These answer with a percentage or
   * a label instead. Also on the list: the `tolerance` rule field they read, and
   * the cacheKey fix that put `value` and `tolerance` into the key.
   */
  const PENDING_DART_PORT = new Set([
    'fib_retracement', 'fib_extension', 'fib_level', 'fib_zone', 'fib_bounce', 'fib_distance',
    'sr_position', 'sr_bounce',
  ]);

  const ported = names.filter(isRegistered);
  const disabled = names.filter((n) => !isRegistered(n) && DISABLED.has(n));

  it('the new names are genuinely new, not resurrected Dart ones', () => {
    const clash = [...PENDING_DART_PORT].filter((n) => names.includes(n));
    expect(clash, `these already exist in Dart: ${clash.join(', ')}`).toEqual([]);
  });
  const pending = names.filter((n) => !isRegistered(n) && !DISABLED.has(n));

  it('every unregistered Dart indicator is deliberately disabled, not forgotten', () => {
    expect(pending, `not ported and not on the disabled list: ${pending.join(', ')}`).toEqual([]);
  });

  it(`reports migration progress`, () => {
    const pct = ((ported.length / names.length) * 100).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(
      `\n  ported ${ported.length}/${names.length} (${pct}%)  •  pending ${pending.length}` +
        (pending.length ? `\n  next up: ${pending.slice(0, 12).join(', ')}${pending.length > 12 ? ' …' : ''}` : ''),
    );
    // The registry must not drift from the Dart vocabulary by accident. Names
    // added on purpose go on the list below and nowhere else.
    for (const n of registeredNames()) {
      if (PENDING_DART_PORT.has(n)) continue;
      expect(names, `"${n}" is registered but absent from the Dart fixture`).toContain(n);
    }
  });

  describe.skipIf(ported.length === 0)('ported indicators match exactly', () => {
    for (const name of ported) {
      it(name, () => {
        const expected = decodeExpected(fixture.results[name]!);
        const actual = computeIndicator(candles, makeRule({
          indicator: name, condition: 'gt', signal: 'CALL', score: 1.0,
        }), currentPrice, clock);

        expect(actual, `${name}: not produced`).toBeDefined();

        const nd = NON_DETERMINISTIC[name];
        if (nd) {
          // Cannot assert the value — assert the shape instead, and assert that
          // the Dart side also produced one of the same valid labels.
          expect(nd.allowed, `${name} (${nd.reason})`).toContain(actual as string);
          expect(nd.allowed, `${name}: fixture value outside the valid set`).toContain(
            expected as string,
          );
          return;
        }

        if (typeof expected === 'number') {
          expect(typeof actual, `${name}: expected a number, got ${typeof actual}`).toBe('number');
          const got = actual as number;
          if (Number.isNaN(expected)) {
            expect(Number.isNaN(got)).toBe(true);
          } else {
            expect(
              closeEnough(got, expected),
              `${name}: expected ${expected}, got ${got} (Δ ${Math.abs(got - expected)})`,
            ).toBe(true);
          }
        } else {
          expect(actual, `${name}: label mismatch`).toBe(expected);
        }
      });
    }
  });
});
