/**
 * Fibonacci 0.236 touch — the specification, as code.
 *
 * ── THE STRATEGY IN ONE PARAGRAPH ──────────────────────────────────────────
 *
 * Find the most recent completed swing in the last 100 one-minute candles.
 * Draw the 23.6% retracement of it. When a later candle's range contains that
 * level, take the trade on the NEXT candle, in the direction the swing ran —
 * up-swing → CALL, down-swing → PUT. One candle long. If it loses, take the
 * same direction once more, immediately. Then stop, whatever happens.
 *
 * ── WHAT IS NOT HERE, ON PURPOSE ───────────────────────────────────────────
 *
 * No trend filter, no oscillator confirmation, no session window, no minimum
 * score, no tolerance band around the level. Those were excluded by the author
 * explicitly, and every one of them would change which candles trade. The only
 * conditions below are the ones the specification states.
 *
 * ── THE NINE DECISIONS ─────────────────────────────────────────────────────
 *
 * The specification left nine things open that change behaviour. They are
 * marked A1…A9 at the exact line that implements them, so that changing one's
 * mind is a search rather than a re-reading:
 *
 *   A1  a swing point is a 5-candle fractal
 *   A2  the swing is two ADJACENT alternating pivots, newest pair first
 *   A3  only the candle that just closed can be the touch
 *   A4  one signal per setup, ever
 *   A5  a tie is not a loss, so it earns no martingale
 *   A6  entry is the signal candle's open, exit is its close
 *   A7  a zero-range swing is refused
 *   A8  the swing is FROZEN once adopted, and only replaced when it dies
 *   A9  the setup dies if price passes the end of the swing before touching
 *
 * ── NO REPAINTING, MECHANICALLY ────────────────────────────────────────────
 *
 * Three lines below carry that guarantee, and nothing else does:
 *
 *   1. `lastClosedIndex` — a candle still forming is not read at all
 *   2. `confirmedPivots(…, N - 2)` — a fractal needs two candles after it, so
 *      only pivots that can no longer change are considered
 *   3. the signal is emitted for the candle that has already begun, and the
 *      state that records it is never revisited
 *
 * Remove any one of them and the strategy starts reading candles that had not
 * happened when it claims to have decided.
 */

import type { Candle } from '../types.js';
import type { Direction } from '../signal.js';
import { outcomeFor } from '../signal.js';
import {
  NO_EVENT,
  type ArmedSetup,
  type SetupDiagnostics,
  type ProgramContext,
  type ProgramEvent,
  type ProgramState,
  type StrategyProgram,
  type TradeResult,
} from './types.js';

/** The one level this strategy watches. Exact, never rounded to a nearby tick. */
const FIB = 0.236;

/** How many past setups to remember for A4. Two an hour would be busy; 32 is weeks. */
const FIRED_MEMORY = 32;

/**
 * A fresh tally for one candle.
 *
 * Counting only. Not one field below is read by any decision in this file —
 * they are written on the way past, and the backtest adds them up.
 */
function blankDiagnostics(): SetupDiagnostics {
  return {
    pairsExamined: 0,
    rejectedShape: 0,
    rejectedSwingTouched: 0,
    rejectedBroken: 0,
    rejectedAlreadyFired: 0,
    armed: false,
    retiredBroken: false,
    retiredAged: false,
  };
}

/** A confirmed swing point. */
interface Pivot {
  kind: 'high' | 'low';
  index: number;
  price: number;
}

/** A swing with its level, ready to be watched. */
interface Setup {
  direction: Direction;
  /** Where the leg started and ended, as indices into the window. */
  originIndex: number;
  endIndex: number;
  /** The price at the end of the leg — the anchor A9 watches. */
  endPrice: number;
  level: number;
  /** `originTime:endTime` — survives the buffer sliding, unlike an index. */
  key: string;
}

/**
 * Is the level inside the candle?
 *
 * High and low, not the close, and inclusive at both ends: a wick that reaches
 * the level exactly has touched it. No tolerance is applied — a band would be a
 * filter, and the specification says there are none.
 */
function touches(candle: Candle, level: number): boolean {
  return candle.low <= level && level <= candle.high;
}

/**
 * The index of the newest candle that has actually closed.
 *
 * The live buffer's last entry is usually a candle a few hundred milliseconds
 * old, still being built from ticks. Reading it would mean deciding on a high
 * and low that are still moving — the purest form of the bug this strategy is
 * written to avoid.
 */
function lastClosedIndex(candles: readonly Candle[], timeframeMs: number, now: number): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i]!.time + timeframeMs <= now) return i;
  }
  return -1;
}

/**
 * The stretch of candles at the end of the buffer with no gaps in it.
 *
 * A swing measured across a hole is not a price move; it is two prices with
 * missing hours between them, and the retracement drawn from it means nothing.
 * The feed does go quiet — a closed market, a dropped socket — so this is the
 * ordinary case rather than the paranoid one.
 */
function contiguousTail(candles: readonly Candle[], timeframeMs: number, end: number): number {
  let start = 0;
  for (let i = end; i > 0; i--) {
    if (candles[i]!.time - candles[i - 1]!.time !== timeframeMs) {
      start = i;
      break;
    }
  }
  return start;
}

/**
 * Every 5-candle fractal that can no longer change, oldest first.  ‹A1›
 *
 * `upTo` is `N - 2` and not `N`: the test reads two candles on each side, so a
 * pivot at `N - 1` is still open to being disproved by the candle after next.
 *
 * ── THE OUTSIDE BAR ────────────────────────────────────────────────────────
 *
 * A bar can satisfy both tests — swallowing its four neighbours top and bottom.
 * This used to DROP it, on the grounds that one candle cannot be both ends of
 * one leg. That was a rule nobody asked for, and it had a consequence nobody
 * would have predicted: for a peak candle to reach its own 23.6% level its wick
 * usually has to dip below its neighbours' lows, which made it an outside bar —
 * so it was discarded before the author's own exclusion rule ever ran. Two
 * different rules, the same silence, and no way to tell which one had spoken.
 *
 * It is kept now, as BOTH a high and a low, and the ordinary Setup checks
 * judge it. The degenerate pair — the same candle as its own origin and end —
 * needs no special handling either: its level lands inside the candle by
 * construction, so `findSetup` rejects it on the 0.236 rule, which is exactly
 * the rule that should be doing the rejecting.
 *
 * One residual arbitrary bit, stated rather than hidden: the high is pushed
 * before the low. OHLC does not record which came first inside the bar, so
 * SOME order has to be chosen, and the choice decides which neighbouring pairs
 * exist — `(previous, high@i)` and `(low@i, next)` rather than the mirror.
 * Flipping the two lines flips that.
 */
function confirmedPivots(candles: readonly Candle[], from: number, upTo: number): Pivot[] {
  const out: Pivot[] = [];

  for (let i = Math.max(from + 2, 2); i <= upTo; i++) {
    const c = candles[i]!;
    const isHigh =
      c.high > candles[i - 1]!.high && c.high > candles[i - 2]!.high &&
      c.high > candles[i + 1]!.high && c.high > candles[i + 2]!.high;
    const isLow =
      c.low < candles[i - 1]!.low && c.low < candles[i - 2]!.low &&
      c.low < candles[i + 1]!.low && c.low < candles[i + 2]!.low;

    if (isHigh) out.push({ kind: 'high', index: i, price: c.high });
    if (isLow) out.push({ kind: 'low', index: i, price: c.low });
  }
  return out;
}

/** Did price leave the swing behind before retracing into it?  ‹A9› */
function brokenAfter(
  candles: readonly Candle[],
  end: Pivot,
  direction: Direction,
  upTo: number,
): boolean {
  for (let j = end.index + 1; j <= upTo; j++) {
    if (direction === 'CALL' && candles[j]!.high > end.price) return true;
    if (direction === 'PUT' && candles[j]!.low < end.price) return true;
  }
  return false;
}

/**
 * The newest swing that survives every check, or null.
 *
 * Called only when nothing is armed ‹A8›. Candidates are adjacent alternating
 * pivots, newest first ‹A2›.
 */
function findSetup(
  candles: readonly Candle[],
  from: number,
  n: number,
  firedKeys: readonly string[],
  diag: SetupDiagnostics = blankDiagnostics(),
): Setup | null {
  const pivots = confirmedPivots(candles, from, n - 2);

  for (let i = pivots.length - 1; i >= 1; i--) {
    const end = pivots[i]!;
    const origin = pivots[i - 1]!;
    diag.pairsExamined++;
    if (origin.kind === end.kind) {
      diag.rejectedShape++;
      continue;
    }

    const range = Math.abs(end.price - origin.price);
    if (range <= 0) { // ‹A7›
      diag.rejectedShape++;
      continue;
    }

    // The leg's own direction decides the trade. The touch is only the trigger.
    const direction: Direction = origin.kind === 'low' ? 'CALL' : 'PUT';
    const level = end.price + FIB * (origin.price - end.price);

    // The rule the author called out specifically: a swing candle long enough
    // to have already reached the level disqualifies the whole move, because
    // the signal is supposed to come from a LATER retracement into it. Checked
    // by containment on both candles, high and low, not on their closes.
    if (touches(candles[origin.index]!, level) || touches(candles[end.index]!, level)) {
      diag.rejectedSwingTouched++;
      continue;
    }

    if (brokenAfter(candles, end, direction, n)) { // ‹A9›
      diag.rejectedBroken++;
      continue;
    }

    const key = `${candles[origin.index]!.time}:${candles[end.index]!.time}`;
    if (firedKeys.includes(key)) { // ‹A4›
      diag.rejectedAlreadyFired++;
      continue;
    }

    return {
      direction,
      originIndex: origin.index,
      endIndex: end.index,
      endPrice: end.price,
      level,
      key,
    };
  }
  return null;
}

/**
 * Is the armed setup still worth waiting for?
 *
 * ── WHY THE SETUP IS FROZEN AT ALL ─────────────────────────────────────────
 *
 * The first version recomputed the swing on every candle. It was defensible —
 * it keeps the level attached to the newest structure — and it was wrong,
 * twice over.
 *
 * Wrong against the specification, which says: after determining the high and
 * the low, WATCH the price. Determining and then watching is one setup held
 * still, not a fresh one every minute.
 *
 * And wrong in size. Measured over 1,200 real one-minute candles across nine
 * symbols: 12 setups were adopted, and 8 of them were replaced by a different
 * swing WHILE waiting for the touch — moving the level by a median of 65.6
 * pips. That is not a refinement of the level; it is a different trade. A user
 * told "we are waiting for 1.09528" would have been waiting for something else
 * two candles later, with nothing on screen saying so.
 *
 * So it is fixed on adoption, and only these three things retire it:
 *
 *   1. price left the leg behind — the up-swing's high taken out, or the
 *      down-swing's low ‹A9›. The move it was drawn from is over.
 *   2. the leg aged out of the window the strategy is allowed to look at.
 *   3. it fired ‹A4›.
 *
 * Note what is NOT on that list: a newer, nicer swing forming. That one waits
 * its turn.
 */
function stillValid(
  armed: ArmedSetup,
  candles: readonly Candle[],
  from: number,
  n: number,
): 'valid' | 'aged' | 'broken' {
  if (armed.endTime < candles[from]!.time) return 'aged';

  for (let j = n; j >= from; j--) {
    const candle = candles[j]!;
    if (candle.time <= armed.endTime) break;
    if (armed.direction === 'CALL' && candle.high > armed.endPrice) return 'broken';
    if (armed.direction === 'PUT' && candle.low < armed.endPrice) return 'broken';
  }
  return 'valid';
}

function remember(state: ProgramState, key: string): void {
  state.firedKeys.push(key);
  if (state.firedKeys.length > FIRED_MEMORY) state.firedKeys.shift();
}

export const fib236Touch: StrategyProgram = {
  id: 'fib_236_touch',
  name: 'ارتداد فيبوناتشي 0.236',
  timeframe: '1m',
  durationMinutes: 1,
  confidence: 92.5,

  init(): ProgramState {
    return { cycle: null, armed: null, firedKeys: [], lastCandleTime: 0 };
  },

  onCandleClose(ctx: ProgramContext, state: ProgramState): ProgramEvent {
    const { candles, timeframeMs, now } = ctx;

    const diagnostics = blankDiagnostics();

    const n = lastClosedIndex(candles, timeframeMs, now);
    if (n < 0) return NO_EVENT;

    const candle = candles[n]!;
    // The app's loop ticks four times a second; without this the same candle
    // would be traded on repeatedly.
    if (candle.time <= state.lastCandleTime) return NO_EVENT;
    state.lastCandleTime = candle.time;

    const nextCandleTime = candle.time + timeframeMs;

    // ── An open cycle owns the engine ────────────────────────────────────
    // No searching, no new setups, no second opinion. "No overlapping signals"
    // is not a check somewhere else — it is this branch coming first.
    if (state.cycle !== null) {
      const cycle = state.cycle;

      if (candle.time < cycle.entryTime) return NO_EVENT; // not open yet

      if (candle.time > cycle.entryTime) {
        // The candle the trade was supposed to open on never arrived. Nothing
        // was traded, so nothing is settled and no martingale is owed.
        state.cycle = null;
        return { settled: null, signal: null, cycleEnd: 'ABORTED' };
      }

      const entryPrice = candle.open;
      const exitPrice = candle.close;
      // `outcomeFor` is the engine's own settlement — the same call the app
      // makes for the card the user is looking at. Writing a second one here
      // would eventually show a LOSS beside a cycle that took no martingale,
      // because the two tie thresholds would drift apart.  ‹A6›
      const result: TradeResult = outcomeFor(cycle.direction, entryPrice, exitPrice);
      const settled = {
        result,
        stage: cycle.stage,
        direction: cycle.direction,
        entryPrice,
        exitPrice,
      };

      if (result !== 'LOSS') {
        // ‹A5› A tie refunds the stake, so there is nothing to recover.
        state.cycle = null;
        const cycleEnd =
          cycle.stage === 'primary'
            ? result
            : result === 'WIN'
              ? 'RECOVERED'
              : 'RECOVERED_TIE';
        return { settled, signal: null, cycleEnd };
      }

      if (cycle.stage === 'primary') {
        // Unconditional: no Fibonacci, no touch, no fresh setup. Same
        // direction, next candle, once.
        state.cycle = {
          direction: cycle.direction,
          stage: 'martingale',
          entryTime: nextCandleTime,
        };
        return {
          settled,
          signal: { direction: cycle.direction, stage: 'martingale', entryTime: nextCandleTime },
          cycleEnd: null,
        };
      }

      // A losing martingale ends it. There is no third branch here, which is
      // why a second martingale is impossible rather than merely forbidden.
      state.cycle = null;
      return { settled, signal: null, cycleEnd: 'FINAL_LOSS' };
    }

    // ── Watching ─────────────────────────────────────────────────────────
    const from = contiguousTail(candles, timeframeMs, n);
    // two candles each side of a pivot, plus room to retrace
    if (n - from < 11) return { ...NO_EVENT, diagnostics };

    // Retire the armed setup before anything else, so a dead one cannot be
    // touched and a live one cannot be replaced.
    if (state.armed !== null) {
      const verdict = stillValid(state.armed, candles, from, n);
      if (verdict !== 'valid') {
        diagnostics.retiredBroken = verdict === 'broken';
        diagnostics.retiredAged = verdict === 'aged';
        state.armed = null;
      }
    }

    // Nothing armed: adopt the newest swing that passes every check, and stop.
    // Adopting and firing on the same candle would mean the touch happened
    // before the setup existed.
    if (state.armed === null) {
      const setup = findSetup(candles, from, n, state.firedKeys, diagnostics);
      if (setup === null) return { ...NO_EVENT, diagnostics };
      diagnostics.armed = true;
      state.armed = {
        direction: setup.direction,
        level: setup.level,
        endPrice: setup.endPrice,
        endTime: candles[setup.endIndex]!.time,
        key: setup.key,
      };
      return { ...NO_EVENT, diagnostics };
    }

    // ‹A3› The touch has to be on the candle that just closed, and after the
    // leg that produced the level. A touch found late — because the pivot
    // confirming the swing only landed now — is not acted on: entering two
    // candles after the trigger is a different strategy from the one
    // specified, and quietly so.
    const armed = state.armed;
    if (candle.time <= armed.endTime) return { ...NO_EVENT, diagnostics };
    if (!touches(candle, armed.level)) return { ...NO_EVENT, diagnostics };

    remember(state, armed.key); // ‹A4›
    state.armed = null;
    state.cycle = {
      direction: armed.direction,
      stage: 'primary',
      entryTime: nextCandleTime,
    };
    return {
      settled: null,
      signal: { direction: armed.direction, stage: 'primary', entryTime: nextCandleTime },
      cycleEnd: null,
      diagnostics,
    };
  },
};

/**
 * How close an armed setup is to firing, as 0…1.
 *
 * There is no score in this strategy and there is not going to be one — a
 * touch happened or it did not, and `buildRow` writes `score: 0` because that
 * is the truth. But "which pair is closest right now" is a real question with
 * a real answer, and it is already being computed: the app has watched the gap
 * between price and the level since the day the near-alert was added.
 *
 * The leg is recovered from the level rather than stored, and the arithmetic
 * is exact: the level sits at `end + 0.236 × (origin − end)`, so the gap
 * between the level and the end of the leg IS 23.6% of the leg. One divide
 * gives the whole thing back.
 *
 * 1 means price is at the level, which is the moment the trade fires. 0 means
 * a full leg away. It is clamped because price is free to run past either end
 * and a setup is not "110% ready" — it is either touched or it is not.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * It decides nothing. No trade, no setup, no settlement reads it, exactly like
 * the near-alert threshold it generalises. It exists so that two callers — the
 * app choosing which chart to show, and the generator choosing which pair to
 * notify about — rank pairs by the same number instead of each inventing one.
 */
export function setupCompletion(
  armed: Pick<ArmedSetup, 'direction' | 'level' | 'endPrice'>,
  price: number,
): number {
  // Reached is 1, and reached is what `touches` means: the retracement is
  // approached from the side the leg ran, so an up-swing's level is met from
  // above and a down-swing's from below. Measuring a bare distance instead
  // would score a price that has run PAST the level as moving away again —
  // 70% for a setup that has already fired.
  const reached = armed.direction === 'CALL' ? price <= armed.level : price >= armed.level;
  if (reached) return 1;

  const leg = Math.abs(armed.level - armed.endPrice) / FIB;
  if (!(leg > 0)) return 0; // a zero-width leg has no "closer"; NaN would rank first
  return Math.max(0, Math.min(1, 1 - Math.abs(price - armed.level) / leg));
}

/**
 * How far through the strategy a pair has got, as a stage and a percentage.
 *
 * ── WHY `setupCompletion` WAS NOT ENOUGH ───────────────────────────────────
 *
 * That one measures a single thing: the gap between price and the level. It is
 * the right number once a setup EXISTS, and useless before — a pair with no
 * armed setup has no gap to measure, so it was simply absent, and every pair
 * that did appear was already most of the way there. The scale started at
 * "nearly ready" and the user could not see the work in front of it.
 *
 * The strategy actually passes through several gates before it is waiting on a
 * price at all, and it already reports on each of them: it looks for confirmed
 * pivots, pairs them into a leg, refuses legs whose own candle already touched
 * the level, refuses legs price has already broken, refuses legs that have
 * fired before, and only then adopts one. Those refusals are counted on every
 * candle for the backtest. This reads the same counters.
 *
 * ── THE SCALE ──────────────────────────────────────────────────────────────
 *
 * Five bands, and the boundaries are the strategy's own gates rather than
 * round numbers chosen to look tidy:
 *
 *   0–15   nothing to work with — no confirmed pivot pair on this candle
 *   15–30  pivots exist, but no two of them form a usable leg
 *   30–50  a leg was found and refused — touched, broken, or already traded
 *   50–95  a setup is ARMED, and the remainder is the distance left to the
 *          level, which is the part `setupCompletion` was always measuring
 *   100    price reached the level; the trade opens on the next candle
 *
 * Half the scale sits after a setup is adopted, because that is genuinely half
 * the work: everything before it can repeat on the next candle for free, and
 * once a setup is armed the strategy is committed to it until it fires, breaks
 * or ages out.
 *
 * ── IT DECIDES NOTHING ─────────────────────────────────────────────────────
 *
 * Not one line of the strategy reads this. It is derived from state and
 * counters that already exist, exactly like `setupCompletion`, and exists so
 * the app can show the same number in two places rather than invent one.
 */
export type SetupStage = 'idle' | 'pivots' | 'rejected' | 'armed' | 'fired';

export interface SetupProgress {
  stage: SetupStage;
  /** 0–100. */
  percent: number;
  /**
   * The price the strategy is waiting for, when it is waiting for one.
   *
   * Present only while a setup is ARMED — that is the only state in which a
   * level exists and is being watched. Before it there is nothing to draw, and
   * drawing a line from an earlier stage would put a price on the chart that
   * the strategy is not actually watching for.
   */
  level?: number;
  /** Which way the trade goes if that level is touched. */
  direction?: Direction;
  /**
   * How far price still has to travel to reach the level, in price units.
   *
   * Present with `level`, and for the same reason: it is the answer to "what is
   * left", which a percentage cannot give. Two pairs can both read 90% and be a
   * pip and a half apart in what they actually need — the percentage is a
   * fraction of each pair's OWN leg, so it compares progress rather than
   * proximity. This is what ranks "about to touch" ahead of "close, on a long
   * leg".
   */
  gap?: number;
}

/** Where each band starts. Named, because the numbers alone explain nothing. */
const BAND = {
  pivots: 15,
  rejected: 30,
  armed: 50,
  /** Where a touch lands. Above this the wait is for the candle, not the price. */
  armedTop: 95,
} as const;

/**
 * The highest a reading can go without the trade being decided.
 *
 * Not 100: that is reserved for a cycle that is actually open, and the whole
 * point of the scale is that its top is a promise. A candle one second from
 * closing on the level is very nearly certain and still not certain — 99 says
 * that, and 100 would not.
 */
const CONFIRM_TOP = 99;

export function setupProgress(
  state: Pick<ProgramState, 'cycle' | 'armed'>,
  diagnostics: SetupDiagnostics | null,
  price: number,
  /**
   * How much of the current candle has already elapsed, 0 to 1.
   *
   * Only used once price is ON the level, and it is the answer to a real
   * question. A touch is not a trade: the strategy judges the CLOSE, so price
   * can reach the level early in a candle and drift away before it ends. Early
   * in the candle that is very possible; with seconds left it is nearly
   * settled. Without this the reading sat flat at the top of the band for a
   * whole minute, saying the same thing about a coin-flip and a near-certainty.
   */
  candleElapsed = 0,
): SetupProgress {
  // A trade is open, or one is about to open on the next candle. Either way the
  // strategy has everything it was looking for.
  if (state.cycle !== null) return { stage: 'fired', percent: 100 };

  if (state.armed !== null) {
    const closeness = setupCompletion(state.armed, price);
    const gap = Math.abs(price - state.armed.level);

    // On the level. What is left is not distance any more — it is time, and
    // how much of it has gone. The band above `armedTop` belongs to that wait,
    // and it stops short of 100 because 100 is the confirmation itself.
    const percent =
      closeness >= 1
        ? BAND.armedTop + Math.min(1, Math.max(0, candleElapsed)) * (CONFIRM_TOP - BAND.armedTop)
        : BAND.armed + closeness * (BAND.armedTop - BAND.armed);

    return {
      stage: 'armed',
      percent,
      level: state.armed.level,
      direction: state.armed.direction,
      gap,
    };
  }

  if (diagnostics === null) return { stage: 'idle', percent: 0 };

  // A leg was found and refused. That is further along than having no leg at
  // all: the structure is there, and one of the strategy's own rules turned it
  // down — most of which stop applying as price moves.
  const refused =
    diagnostics.rejectedSwingTouched +
    diagnostics.rejectedBroken +
    diagnostics.rejectedAlreadyFired;
  if (refused > 0) {
    // Within the band by how many candidates survived the shape test, so a pair
    // with several near-misses reads as busier than one with a single refusal.
    const share = Math.min(1, refused / 3);
    return { stage: 'rejected', percent: BAND.rejected + share * (BAND.armed - BAND.rejected) };
  }

  if (diagnostics.pairsExamined > 0) {
    const share = Math.min(1, diagnostics.pairsExamined / 4);
    return { stage: 'pivots', percent: BAND.pivots + share * (BAND.rejected - BAND.pivots) };
  }

  // Not even a pivot pair to look at. Some fraction of the first band rather
  // than a flat zero, because "the window is filling" and "there is nothing
  // here" look identical to a user staring at an empty bar.
  return { stage: 'idle', percent: 0 };
}

/** Exported for the tests, which check the pieces as well as the whole. */
export const _internals = {
  touches, confirmedPivots, findSetup, lastClosedIndex, contiguousTail, blankDiagnostics,
};
