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
  const DISABLED = new Set(
    (JSON.parse(readFileSync(new URL('../../../docs/liveness.json', import.meta.url), 'utf8')) as {
      verdicts: Array<{ name: string; grade: string }>;
    }).verdicts
      .filter((v) => v.grade === 'A')
      .map((v) => v.name)
      // Two grade-A names were kept on purpose; see meta.ts.
      .filter((n) => n !== 'vwap' && n !== 'price_vs_vwap'),
  );

  const ported = names.filter(isRegistered);
  const disabled = names.filter((n) => !isRegistered(n) && DISABLED.has(n));
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
    // Registry must not contain names the Dart engine never had.
    for (const n of registeredNames()) {
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
