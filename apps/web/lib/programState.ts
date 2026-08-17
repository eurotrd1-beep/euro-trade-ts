'use client';

/**
 * Where a strategy program's memory lives between candles.
 *
 * A cycle spans at least two candles — a trade, and possibly the martingale
 * that follows it. Two minutes is long enough for a phone to lock, a browser to
 * discard the tab, or a user to reload. If the program's state died with the
 * page, a losing trade would lose the martingale it earned and nothing would
 * report it: the app would simply go quiet and start looking for a new setup.
 *
 * Keyed by account, pair and timeframe together. A cycle belongs to one market
 * on one clock, and letting EUR/USD's open trade be settled by GBP/USD's
 * candles is the kind of bug that looks like a losing streak.
 *
 * `localStorage` on purpose, not the database: the state is worthless to
 * anyone else, it is rewritten every minute, and a network round trip inside a
 * candle boundary is exactly what this must not depend on. The trade history —
 * the part a user actually cares about — is stored remotely and separately by
 * `signalHistoryStore`.
 */

import type { ProgramState, StrategyProgram } from '@euro/engine';

const PREFIX = 'program_state';

function keyFor(programId: string, accountId: string, symbol: string, timeframe: string): string {
  return `${PREFIX}:${programId}:${accountId}:${symbol}:${timeframe}`;
}

/**
 * The stored state, or a fresh one.
 *
 * Anything unreadable is treated as absent rather than repaired. A half-parsed
 * cycle is worse than no cycle: it would settle a trade that may never have
 * been shown, at a price nobody can check.
 */
export function loadProgramState(
  program: StrategyProgram,
  accountId: string,
  symbol: string,
  timeframe: string,
): ProgramState {
  if (typeof localStorage === 'undefined') return program.init();

  try {
    const raw = localStorage.getItem(keyFor(program.id, accountId, symbol, timeframe));
    if (!raw) return program.init();

    const parsed = JSON.parse(raw) as Partial<ProgramState>;
    if (typeof parsed !== 'object' || parsed === null) return program.init();

    return {
      cycle: parsed.cycle ?? null,
      armed: parsed.armed ?? null,
      firedKeys: Array.isArray(parsed.firedKeys) ? parsed.firedKeys.filter((k) => typeof k === 'string') : [],
      lastCandleTime: typeof parsed.lastCandleTime === 'number' ? parsed.lastCandleTime : 0,
    };
  } catch {
    return program.init();
  }
}

/** Writes it back. Silent on failure — a full quota must not break the tick. */
export function saveProgramState(
  program: StrategyProgram,
  accountId: string,
  symbol: string,
  timeframe: string,
  state: ProgramState,
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(keyFor(program.id, accountId, symbol, timeframe), JSON.stringify(state));
  } catch {
    /* storage full or blocked — the in-memory state keeps the session going */
  }
}
