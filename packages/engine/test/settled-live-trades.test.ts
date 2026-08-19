/**
 * Five real trades, settled by the engine, pinned as numbers.
 *
 * These came out of a report that listed the last five trades off the live
 * feed. The report was built by a throwaway script that decided the outcome
 * itself — `close > open` for a CALL, `close < open` for a PUT — instead of
 * asking `outcomeFor`. It had no draw band, so two of the five were labelled
 * with an outcome the engine never gave them:
 *
 *   Gold OTC       reported LOSS, engine says TIE  (moved 0.019, band 0.022)
 *   Solana OTC     reported WIN,  engine says TIE  (moved 0.00003, band 0.00043)
 *
 * That is the whole class of mistake this file exists to stop: any second
 * reading of a candle, anywhere, that skips the band. The numbers below are
 * the actual opens and closes from the feed on 2026-08-19, so a change to
 * `tieEpsilon` or to `outcomeFor` fails here with a real trade rather than a
 * constructed one.
 *
 * The martingale column is the other half. A draw refunds the stake, so it
 * owes no recovery trade ‹A5› — and the two draws below are exactly the rows
 * that would have opened a martingale under the report's arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { outcomeFor, tieEpsilon } from '../src/index.js';
import type { Direction } from '../src/signal.js';

interface LiveTrade {
  pair: string;
  direction: Direction;
  /** The entry candle's open — what the engine pays. ‹A6› */
  entry: number;
  /** The same candle's close — what the engine settles on. ‹A6› */
  exit: number;
  expected: 'WIN' | 'LOSS' | 'TIE';
  /** What the report claimed, where it differed. */
  reported?: 'WIN' | 'LOSS' | 'TIE';
}

/** Primary trades, in the order they fired. */
const PRIMARY: LiveTrade[] = [
  { pair: 'Gold OTC 10:40', direction: 'PUT', entry: 4402.657, exit: 4402.676, expected: 'TIE', reported: 'LOSS' },
  { pair: 'GBP/AUD OTC 10:42', direction: 'PUT', entry: 2.14283, exit: 2.14326, expected: 'LOSS' },
  { pair: 'CAD/JPY 10:43', direction: 'CALL', entry: 114.728, exit: 114.718, expected: 'LOSS' },
  { pair: 'Solana OTC 10:43', direction: 'PUT', entry: 85.00669, exit: 85.00666, expected: 'TIE', reported: 'WIN' },
  { pair: 'BHD/CNY OTC 10:44', direction: 'PUT', entry: 18.49578, exit: 18.49495, expected: 'WIN' },
];

/** The recovery trades the two losses above earned. */
const MARTINGALE: LiveTrade[] = [
  { pair: 'GBP/AUD OTC 10:43', direction: 'PUT', entry: 2.1433, exit: 2.14159, expected: 'WIN' },
  // open and close are the same number to the last digit the feed carries —
  // the exact-equality case, from the market rather than from a fixture.
  { pair: 'CAD/JPY 10:44', direction: 'CALL', entry: 114.717, exit: 114.717, expected: 'TIE' },
];

describe('the five trades the report got wrong', () => {
  it.each(PRIMARY)('$pair settles as $expected', ({ direction, entry, exit, expected }) => {
    expect(outcomeFor(direction, entry, exit)).toBe(expected);
  });

  it.each(MARTINGALE)('$pair settles as $expected', ({ direction, entry, exit, expected }) => {
    expect(outcomeFor(direction, entry, exit)).toBe(expected);
  });

  it('disagrees with sign-of-the-move on exactly the two draws', () => {
    // The arithmetic the report used, restated so the difference is visible
    // rather than asserted: it is `outcomeFor` with the band removed.
    const bandless = (d: Direction, entry: number, exit: number): 'WIN' | 'LOSS' =>
      d === 'CALL' ? (exit > entry ? 'WIN' : 'LOSS') : exit < entry ? 'WIN' : 'LOSS';

    const differ = PRIMARY.filter(
      (t) => bandless(t.direction, t.entry, t.exit) !== outcomeFor(t.direction, t.entry, t.exit),
    );
    expect(differ.map((t) => t.pair)).toEqual(['Gold OTC 10:40', 'Solana OTC 10:43']);
    for (const t of differ) expect(t.expected).toBe('TIE');
  });

  it('puts both draws inside the band and both decided trades outside it', () => {
    for (const t of [...PRIMARY, ...MARTINGALE]) {
      const inside = Math.abs(t.exit - t.entry) <= tieEpsilon(t.entry);
      expect(inside, `${t.pair} inside the band`).toBe(t.expected === 'TIE');
    }
  });

  it('owes a recovery trade on the losses and on nothing else', () => {
    // ‹A5› The rule that connects settlement to the martingale, applied to the
    // real rows. Under the report's arithmetic the two draws were a loss and a
    // win, so one of them would have opened a recovery trade that the engine
    // never opened.
    const owed = PRIMARY.filter((t) => outcomeFor(t.direction, t.entry, t.exit) === 'LOSS');
    expect(owed.map((t) => t.pair)).toEqual(['GBP/AUD OTC 10:42', 'CAD/JPY 10:43']);
    expect(owed).toHaveLength(MARTINGALE.length);
  });
});
