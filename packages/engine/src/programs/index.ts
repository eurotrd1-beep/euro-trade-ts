/**
 * The program registry — how a plan points at a strategy by name.
 *
 * The app never imports a program directly. A plan stores an id, this looks it
 * up, and the button drives whatever comes back through the `StrategyProgram`
 * interface. That indirection is the whole point: adding the next strategy is
 * one file plus one line here, and nothing in the app, the panel or the
 * monitoring loop learns its name.
 *
 * `DEFAULT_PROGRAM_ID` is what both plans resolve to when they say nothing.
 * Today free and paid run the same program — the difference between the plans
 * is not yet expressed here, and pretending otherwise with two ids pointing at
 * one implementation would be a lie the code tells about itself.
 */

import { fib236Touch } from './fib236.js';
import type { StrategyProgram } from './types.js';

export * from './types.js';
export { fib236Touch } from './fib236.js';

const PROGRAMS: readonly StrategyProgram[] = [fib236Touch];

export const DEFAULT_PROGRAM_ID = fib236Touch.id;

/** The two plans the app sells. */
export type Plan = 'free' | 'paid';

/**
 * Which program a plan runs.
 *
 * One entry per plan, and today both point at the same program — which is the
 * honest state of things rather than an oversight. The map exists so that
 * giving the paid plan a different strategy later is a line here, and so that
 * everything which has to know "what does this plan actually run" — the app,
 * the backtest, the admin screen — asks the same question in the same place
 * instead of each keeping its own answer.
 */
const BY_PLAN: Record<Plan, StrategyProgram> = {
  free: fib236Touch,
  paid: fib236Touch,
};

/**
 * The timeframes a program may be run on, and the trade length on each.
 *
 * One candle is one trade — that is the shape of the strategy, not a setting:
 * it enters on the open of the candle after the touch and leaves on that same
 * candle's close. So the trade length is not a separate choice, it IS the
 * timeframe, and this map is the only place the two are tied together.
 *
 * `fib236Touch` itself never reads either value. Every decision in it comes
 * from `ctx.timeframeMs`, which the caller supplies, so the strategy is the
 * same strategy on 5m as on 1m — a swing between two confirmed pivots and a
 * touch of the 0.236 retracement, measured on whatever candles it is handed.
 * What changes is only how long a candle is.
 */
export const TIMEFRAME_MINUTES: Readonly<Record<string, number>> = {
  '1m': 1,
  '5m': 5,
};

/** The timeframes a user may pick, in the order they should be shown. */
export const SUPPORTED_TIMEFRAMES: readonly string[] = ['1m', '5m'];

/**
 * The same program, declared on a different timeframe.
 *
 * A copy rather than a mutation: two pairs can be watched on two timeframes at
 * once and neither may see the other's value. Safe to spread because nothing
 * in a program's methods reads `this` — they are pure functions of the context
 * and the state they are given, which is what makes this possible at all.
 *
 * An unknown timeframe returns the program unchanged rather than inventing a
 * trade length for it. Guessing "probably a minute" would place real trades on
 * a duration nobody chose.
 */
export function programOnTimeframe(
  program: StrategyProgram,
  timeframe: string,
): StrategyProgram {
  const minutes = TIMEFRAME_MINUTES[timeframe];
  if (minutes === undefined || timeframe === program.timeframe) return program;
  return { ...program, timeframe, durationMinutes: minutes };
}

/**
 * Which program a plan runs, on the timeframe it is being run on.
 *
 * The timeframe is optional so every existing caller — the proxy generator,
 * the admin screen — keeps the program's own declared value.
 */
export function programForPlan(plan: Plan, timeframe?: string): StrategyProgram {
  const program = BY_PLAN[plan];
  return timeframe === undefined ? program : programOnTimeframe(program, timeframe);
}

/** Every program, for an admin screen that has to list them. */
export function registeredPrograms(): readonly StrategyProgram[] {
  return PROGRAMS;
}

/**
 * The program with this id, or null.
 *
 * Null rather than a throw, and null rather than silently falling back to the
 * default: a plan naming a program that does not exist is a configuration
 * fault, and the caller has to be able to say so instead of trading with
 * something the operator did not choose.
 */
export function programFor(id: string | null | undefined): StrategyProgram | null {
  if (!id) return null;
  return PROGRAMS.find((p) => p.id === id) ?? null;
}
