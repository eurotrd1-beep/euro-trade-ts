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

export function programForPlan(plan: Plan): StrategyProgram {
  return BY_PLAN[plan];
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
