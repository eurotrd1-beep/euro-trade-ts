/**
 * What the percentage means, and what 100 promises.
 *
 * The number is on screen beside a market somebody is about to put money into,
 * so the two ends of the scale carry weight the middle does not:
 *
 *   100 — the trade enters on the next candle. Not "very likely": the strategy
 *         has committed, the cycle is open, and the entry is already decided.
 *   0   — nothing is happening on this pair at all.
 *
 * Everything between them is progress through the strategy's own gates, and
 * these tests exist mostly to guarantee the top: nothing that is merely close
 * may reach 100, whatever route it takes through the bands.
 */

import { describe, expect, it } from 'vitest';
import { setupProgress, type SetupDiagnostics } from '../src/index.js';

/** An up-swing 1.0900 → 1.1000, so the 0.236 level sits at 1.09764. */
const armed = { direction: 'CALL' as const, level: 1.09764, endPrice: 1.1, endTime: 0, key: 'a:b' };

const diag = (over: Partial<SetupDiagnostics> = {}): SetupDiagnostics => ({
  pairsExamined: 0,
  rejectedShape: 0,
  rejectedTooSmall: 0,
  rejectedSwingTouched: 0,
  rejectedBroken: 0,
  rejectedAlreadyFired: 0,
  armed: false,
  retiredBroken: false,
  retiredAged: false,
  ...over,
});

const cycle = { direction: 'CALL' as const, stage: 'primary' as const, entryTime: 1 };

describe('100 means the trade enters on the next candle', () => {
  it('is reached when — and only when — a cycle is open', () => {
    const out = setupProgress({ cycle, armed: null }, null, 1.1);
    expect(out.stage).toBe('fired');
    expect(out.percent).toBe(100);
  });

  it('is not reached by price sitting exactly on the level', () => {
    // The closest an un-committed setup can get. It is not the same claim: the
    // touch is judged on a CLOSED candle, and this one has not closed.
    const out = setupProgress({ cycle: null, armed }, null, armed.level);
    expect(out.stage).toBe('armed');
    expect(out.percent).toBeLessThan(100);
  });

  it('is not reached by price running past the level either', () => {
    const out = setupProgress({ cycle: null, armed }, null, armed.level - 0.005);
    expect(out.percent).toBeLessThan(100);
  });

  it('caps every armed reading below 100, at any price', () => {
    // Swept rather than spot-checked: the band is arithmetic, and arithmetic is
    // where an off-by-one puts 100 on a pair that has committed to nothing.
    for (let p = 1.08; p <= 1.12; p += 0.0005) {
      const out = setupProgress({ cycle: null, armed }, null, p);
      expect(out.percent, `price ${p.toFixed(4)} reached 100 without a cycle`).toBeLessThan(100);
      expect(out.percent).toBeGreaterThanOrEqual(0);
    }
  });

  it('caps every un-armed reading well below the armed band', () => {
    // A pair still searching must never outrank one with a setup.
    const searching = [
      setupProgress({ cycle: null, armed: null }, diag(), 1.1),
      setupProgress({ cycle: null, armed: null }, diag({ pairsExamined: 9 }), 1.1),
      setupProgress({ cycle: null, armed: null }, diag({ rejectedBroken: 9 }), 1.1),
      setupProgress({ cycle: null, armed: null }, diag({ rejectedAlreadyFired: 9 }), 1.1),
    ];
    const worstArmed = setupProgress({ cycle: null, armed }, null, 1.15).percent;
    for (const s of searching) {
      expect(s.percent).toBeLessThanOrEqual(worstArmed);
    }
  });
});

describe('the bands are ordered by how far the strategy actually got', () => {
  it('nothing at all is zero', () => {
    const out = setupProgress({ cycle: null, armed: null }, diag(), 1.1);
    expect(out.stage).toBe('idle');
    expect(out.percent).toBe(0);
  });

  it('pivots examined beats nothing', () => {
    const a = setupProgress({ cycle: null, armed: null }, diag(), 1.1);
    const b = setupProgress({ cycle: null, armed: null }, diag({ pairsExamined: 2 }), 1.1);
    expect(b.stage).toBe('pivots');
    expect(b.percent).toBeGreaterThan(a.percent);
  });

  it('a leg found and refused beats pivots that formed no leg', () => {
    // The structure is there and one of the strategy's own rules turned it
    // down — most of which stop applying as price moves.
    const a = setupProgress({ cycle: null, armed: null }, diag({ pairsExamined: 4 }), 1.1);
    const b = setupProgress({ cycle: null, armed: null }, diag({ rejectedBroken: 1 }), 1.1);
    expect(b.stage).toBe('rejected');
    expect(b.percent).toBeGreaterThan(a.percent);
  });

  it('an armed setup beats every stage before it', () => {
    const refused = setupProgress({ cycle: null, armed: null }, diag({ rejectedBroken: 9 }), 1.1);
    // Even at its furthest, an armed setup is past the refusals.
    const far = setupProgress({ cycle: null, armed }, null, 1.2);
    expect(far.stage).toBe('armed');
    expect(far.percent).toBeGreaterThanOrEqual(refused.percent);
  });

  it('rises as price closes on the level', () => {
    const far = setupProgress({ cycle: null, armed }, null, armed.level + 0.008).percent;
    const near = setupProgress({ cycle: null, armed }, null, armed.level + 0.001).percent;
    expect(near).toBeGreaterThan(far);
  });

  it('answers without diagnostics, since an armed setup does not need them', () => {
    // The generator has the state but not the last candle's counters.
    expect(setupProgress({ cycle: null, armed }, null, 1.098).stage).toBe('armed');
    expect(setupProgress({ cycle: null, armed: null }, null, 1.1).stage).toBe('idle');
  });
});
