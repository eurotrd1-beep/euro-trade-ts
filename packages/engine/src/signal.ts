/**
 * Signal lifecycle — confidence, expiry alignment and the WIN/LOSS/TIE call.
 *
 * Ported from `_generateNextSignal` and `_evaluateSignalResult` in
 * signal_engine.dart. These are the numbers the user sees on every trade, so
 * they are kept as pure functions: easy to test, no hidden engine state.
 */

import type { Candle } from './types.js';

export type Direction = 'CALL' | 'PUT';
/**
 * A trade's state. `UNRESOLVED` is the fourth outcome, not a kind of tie.
 *
 * It means the candle the trade ran on never reached the app, so there is no
 * price to judge it by. Recording that as a TIE would quietly inflate ties and
 * nobody would ever find out why — the same reason the proxy generator and the
 * settlement SQL both keep it separate. It is excluded from win rates, exactly
 * as a tie is, but it is not the same event and does not read as one.
 */
export type SignalStatus = 'ACTIVE' | 'PENDING' | 'WIN' | 'LOSS' | 'TIE' | 'UNRESOLVED';

export interface TradingSignal {
  pair: string;
  direction: Direction;
  durationMinutes: number;
  entryPrice: number;
  currentPrice: number;
  confidence: number;
  /** Epoch ms. */
  entryTime: number;
  /** Epoch ms. */
  expiryTime: number;
  status: SignalStatus;
  exitPrice: number | null;
  candlesSnapshot: Candle[] | null;
  marketCondition: string;
  recommendation: string;
  origin: 'instant' | 'monitoring';
  /**
   * Which trade of a strategy cycle this is.
   *
   * Absent on everything a rule-based strategy produced, and on every trade
   * recorded before programs existed — hence optional rather than defaulted.
   * A `martingale` trade is the one the user must be told about explicitly:
   * it is entered at a doubled stake on the back of a loss, and a card that
   * looked like any other would be the app hiding the only decision that
   * costs real money.
   */
  stage?: 'primary' | 'martingale';
}

/**
 * The score at which the confidence curve reaches `confidenceMax`.
 *
 * It was an unnamed 45.0 sitting inside the formula, and the number matters
 * more than its anonymity suggested: it is an ABSOLUTE score on a scale every
 * strategy sets for itself. A strategy whose rules can only ever total 20 tops
 * out around the midpoint of its own confidence range and can never present a
 * high-confidence signal, however unanimous its evidence — and nothing anywhere
 * said so. Named here so that ceiling is visible at the call site instead of
 * being discovered by wondering why confidence never moves.
 *
 * The value is inherited from the original engine and is deliberately NOT
 * derived from the strategy: changing it changes the confidence shown on every
 * signal, which is a product decision, not a refactor.
 */
export const CONFIDENCE_SATURATION_SCORE = 45.0;

/**
 * signal_engine.dart — the confidence curve for non-VIP signals:
 * `base + (|score| / SATURATION) × (max − base)`, clamped to [base, max].
 */
export function confidenceFor(absScore: number, base: number, max: number): number {
  const c = base + (absScore / CONFIDENCE_SATURATION_SCORE) * (max - base);
  return c < base ? base : c > max ? max : c;
}

export interface AlignedExpiry {
  /** Epoch ms of the candle open the trade is anchored to. */
  entryTime: number;
  /** Epoch ms the trade expires. */
  expiryTime: number;
  /** Seconds remaining from `nowMs` to expiry. */
  durationSeconds: number;
}

/**
 * signal_engine.dart — expiry alignment.
 *
 * The duration is REAL minutes regardless of the chart timeframe; the trade is
 * snapped back to the start of the current 1-minute candle so it always ends on
 * a clean close. (A previous version multiplied by the chart frame, which made
 * a "5 min" trade run 75 minutes on a 15m chart.)
 */
export function alignExpiry(nowMs: number, selectedMinutes: number): AlignedExpiry {
  const nowSec = Math.trunc(nowMs / 1000);
  const cs = 60;
  const cStartSec = Math.trunc(nowSec / cs) * cs;
  const expirySec = cStartSec + selectedMinutes * cs;

  const raw = expirySec - nowSec;
  const lo = 1;
  const hi = selectedMinutes * cs + cs;
  const durationSeconds = raw < lo ? lo : raw > hi ? hi : raw;

  return {
    entryTime: cStartSec * 1000,
    expiryTime: expirySec * 1000,
    durationSeconds,
  };
}

/**
 * signal_engine.dart — the tie tolerance.
 * A flat close counts as TIE (stake refunded) rather than a loss. Judged at
 * real price precision — about half a tick — not exact float equality.
 */
export function tieEpsilon(entryPrice: number): number {
  return Math.abs(entryPrice) * 5e-6 + 1e-12;
}

/**
 * signal_engine.dart — `_evaluateSignalResult`, the non-guaranteed path.
 * Returns WIN, LOSS or TIE for a completed trade.
 */
export function outcomeFor(
  direction: Direction,
  entryPrice: number,
  exitPrice: number,
): 'WIN' | 'LOSS' | 'TIE' {
  const diff = exitPrice - entryPrice;
  if (Math.abs(diff) <= tieEpsilon(entryPrice)) return 'TIE';
  if (direction === 'CALL') return diff > 0 ? 'WIN' : 'LOSS';
  return diff < 0 ? 'WIN' : 'LOSS';
}

/**
 * signal_engine.dart — the exit price the review dialog shows.
 *
 * The live chart price is only trusted when it is within 1% of entry. That
 * guard exists because a stale or null price getter returns a value on a
 * completely different scale, which used to make the dialog show an entry and a
 * close from two different worlds.
 */
export function resolveExitPrice(entryPrice: number, livePrice: number | null): number {
  const live = livePrice ?? 0;
  const sane = live > 0 && Math.abs(live - entryPrice) / entryPrice < 0.01;
  return sane ? live : entryPrice;
}

/**
 * signal_engine.dart — the admin-controlled guaranteed-win exit.
 *
 * If the live price already wins on the same scale it is kept, so the number
 * still matches the chart; otherwise the close is snapped to a small margin on
 * the winning side.
 *
 * `rng` is injectable because the margin is randomised in the original — that
 * randomness is why this path cannot be value-matched against a fixture.
 */
export function guaranteedWinExit(
  direction: Direction,
  entryPrice: number,
  livePrice: number | null,
  rng: () => number = Math.random,
): number {
  const live = livePrice ?? 0;
  const sane = live > 0 && Math.abs(live - entryPrice) / entryPrice < 0.01;
  const winning =
    sane && (direction === 'CALL' ? live > entryPrice : live < entryPrice);
  if (winning) return live;

  const margin = entryPrice * 0.00008 * (0.6 + rng() * 0.8);
  return direction === 'CALL' ? entryPrice + margin : entryPrice - margin;
}
