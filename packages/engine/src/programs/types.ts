/**
 * Strategy PROGRAMS — the second kind of strategy this engine runs.
 *
 * ── WHY THIS EXISTS BESIDE `DynamicStrategy` ───────────────────────────────
 *
 * A `DynamicStrategy` is a list of rules scored independently on one candle:
 * every enabled rule is measured, the true ones add their score to a side, and
 * the net decides. That shape can express "the price is in the golden zone" and
 * cannot express any of the following, which are all one strategy:
 *
 *   • wait for a swing to FORM, then watch later candles for a touch
 *   • refuse the setup because of something a candle did earlier
 *   • fire on the candle AFTER the trigger, never on the trigger itself
 *   • fire once per setup, not once per candle that satisfies it
 *   • follow a loss with exactly one more trade in the same direction
 *
 * None of that is a score. It is a state machine that reads a sequence, and
 * bolting it onto the rule scorer would mean rules that secretly remember
 * things — the worst of both.
 *
 * So a program is the other option, not a replacement: it owns its own state,
 * is handed the candles at each close, and answers what to DO. The registry in
 * `index.ts` is what lets a plan point at one by name, and what lets the next
 * program be added without the app learning anything new about it.
 *
 * ── THE CONTRACT THAT MATTERS ──────────────────────────────────────────────
 *
 * `onCandleClose` must be a pure function of (candles, state, now). Same inputs
 * → same event, every time. That is not a style preference: it is the only way
 * "no repainting" can be verified rather than asserted, and the only way a
 * backtest and the live app can be shown to agree.
 */

import type { Candle } from '../types.js';
import type { Direction } from '../signal.js';

/** Which trade of a cycle this is. A cycle has at most two. */
export type ProgramStage = 'primary' | 'martingale';

/** How one trade came out. */
export type TradeResult = 'WIN' | 'LOSS' | 'TIE';

/**
 * How a whole cycle came out.
 *
 * `RECOVERED` is a martingale that won — the pair of trades is net positive at
 * a doubled stake, which is the entire point of the martingale and is worth
 * separating from a plain WIN in the statistics. `ABORTED` is the cycle whose
 * candle never arrived; it is not a loss and must never be counted as one.
 */
export type CycleResult = 'WIN' | 'TIE' | 'RECOVERED' | 'RECOVERED_TIE' | 'FINAL_LOSS' | 'ABORTED';

/**
 * A swing that has been adopted, with its level worked out.
 *
 * Prices and TIMES, deliberately no indices: the candle buffer drops its oldest
 * bar every minute, so an index saved now points at a different candle in ten.
 */
export interface ArmedSetup {
  direction: Direction;
  level: number;
  /** The end of the leg — the high of an up-swing, the low of a down one. */
  endPrice: number;
  /** Start time of the candle that made that end. */
  endTime: number;
  /** `originTime:endTime`, the identity used for "already traded". */
  key: string;
}

/** An open trade, and which half of the cycle it is. */
export interface ProgramCycle {
  direction: Direction;
  stage: ProgramStage;
  /** Start time of the candle the trade opens on. Time, not index: the buffer
   *  slides by one every minute and an index would point somewhere else. */
  entryTime: number;
}

/**
 * Everything the program remembers between candles.
 *
 * Deliberately plain JSON. A cycle spans at least two candles and the user may
 * close the tab between them; if this cannot be written to storage and read
 * back, a losing trade loses its martingale silently — which is the one
 * failure the strategy's author would never see in testing.
 */
export interface ProgramState {
  cycle: ProgramCycle | null;
  /**
   * The setup being waited on, held fixed until it fires or dies.
   *
   * Stored rather than recomputed because a level that moves while the user is
   * waiting for it is not the level they were told about. See `armedSetup` in
   * fib236.ts for what keeps it and what kills it.
   */
  armed: ArmedSetup | null;
  /** Setups already used, as `originTime:endTime`. Bounded; oldest dropped. */
  firedKeys: string[];
  /** Start time of the last candle processed, so one candle is never read twice. */
  lastCandleTime: number;
}

export interface ProgramContext {
  candles: readonly Candle[];
  /** Milliseconds per candle. The program refuses to guess it from the data. */
  timeframeMs: number;
  /** Wall clock. Anything not yet closed at this instant is invisible. */
  now: number;
}

/**
 * What the search did on one candle, for counting — never for deciding.
 *
 * Every number here reports a decision that was already made by the rules
 * above it. Nothing reads it back, and removing it would not change a single
 * signal. It exists because the alternative was a backtest that re-implements
 * the rejection rules in order to count them, and two copies of a rule are two
 * rules that will eventually disagree.
 */
export interface SetupDiagnostics {
  /** Candidate pairs the search looked at on this candle. */
  pairsExamined: number;
  /** Refused: the two points were the same kind, or the leg had no range. */
  rejectedShape: number;
  /**
   * Refused: the leg was narrower than the minimum. ‹A7›
   *
   * Counted apart from `rejectedShape` on purpose. The two refusals look alike
   * in a total and mean opposite things: a same-kind pair is the search walking
   * past a shape that was never a leg, while this one is a real leg being
   * turned down for being too small — the only number that says how much the
   * minimum is actually costing.
   */
  rejectedTooSmall: number;
  /** Refused: a swing candle already contained the 23.6% level. */
  rejectedSwingTouched: number;
  /** Refused: price had already left the end of the leg behind. */
  rejectedBroken: number;
  /** Refused: that swing has already produced its one signal. */
  rejectedAlreadyFired: number;
  /** A setup was adopted on this candle. */
  armed: boolean;
  /** The armed setup was retired because price broke the end of its leg. */
  retiredBroken: boolean;
  /** The armed setup was retired because its leg aged out of the window. */
  retiredAged: boolean;
}

/**
 * What happened on one candle. All three fields can be filled at once: a losing
 * primary trade settles AND opens the martingale on the same close.
 */
export interface ProgramEvent {
  settled: {
    result: TradeResult;
    stage: ProgramStage;
    direction: Direction;
    entryPrice: number;
    exitPrice: number;
  } | null;
  signal: {
    direction: Direction;
    stage: ProgramStage;
    /** Start time of the candle it opens on — always the one that just began. */
    entryTime: number;
  } | null;
  cycleEnd: CycleResult | null;
  /**
   * Counters, when the program keeps them. Optional so a future program is not
   * forced to invent numbers it has no meaning for.
   */
  diagnostics?: SetupDiagnostics;
}

/** Nothing happened. Returned far more often than anything else. */
export const NO_EVENT: ProgramEvent = { settled: null, signal: null, cycleEnd: null };

export interface StrategyProgram {
  /** Stable id. What a plan stores and what the registry is keyed by. */
  id: string;
  /** Shown to the user. */
  name: string;
  /**
   * The timeframe the program is defined on, and the trade length in minutes.
   *
   * Both are the program's, not the user's. A strategy whose rules are written
   * around one-minute candles does not have a meaningful answer on 15m, and
   * offering the choice would only produce signals nobody can explain.
   */
  timeframe: string;
  durationMinutes: number;
  /**
   * The number shown on the trade card as "confidence".
   *
   * A constant, and honestly so. A touch either happened or it did not — there
   * is no score behind it and therefore nothing to vary per trade. It lives on
   * the program because the alternative was reading it out of a `configs` row
   * that nothing else in the app still reads.
   */
  confidence: number;
  /** Fresh state. Must be JSON-serialisable. */
  init(): ProgramState;
  /**
   * Called once per closed candle. Mutates `state` and returns what happened.
   * Calling it twice for the same candle is safe and returns nothing the second
   * time — the app's loop ticks four times a second and will do exactly that.
   */
  onCandleClose(ctx: ProgramContext, state: ProgramState): ProgramEvent;
}
