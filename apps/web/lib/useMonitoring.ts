'use client';

/**
 * Smart monitoring — ported from `startMonitoring` / `stopMonitoring`
 * (signal_engine.dart:713).
 *
 * A loop that waits for each candle to CLOSE, evaluates the monitoring
 * strategy on the freshly opened one, and fires only when the conditions
 * actually hold. Unlike the manual button it never forces a signal — a failed
 * check just waits for the next candle.
 *
 * The Dart version is a `while (_monitoring)` loop with `await Future.delayed`.
 * That shape does not survive React re-renders, so it is expressed here as a
 * phase machine driven by one interval. The sequence, the timings and the
 * conditions are identical:
 *
 *   waiting → (candle closes) → +200ms settle → evaluate
 *     ├─ conditions met  → fire → trade → wait for the user to clear it → waiting
 *     └─ not met         → flag "conditions not met" → waiting
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { playActivateSound } from './sounds';

/** Dart polls the countdown at this rate. */
const TICK_MS = 250;

/**
 * Delay after a candle boundary before evaluating, so the chart can roll and
 * seed the freshly-opened candle. Copied exactly — evaluating sooner reads a
 * candle that does not exist yet.
 */
const SETTLE_MS = 200;

export type MonitoringPhase = 'idle' | 'waiting' | 'trade';

export interface MonitoringState {
  active: boolean;
  phase: MonitoringPhase;
  /** Seconds until the current candle closes. */
  countdown: number;
  /** True when the last evaluated candle did not meet the conditions. */
  lastCheckFailed: boolean;
  checksDone: number;
  signalsFired: number;
  elapsedSeconds: number;
}

const IDLE: MonitoringState = {
  active: false,
  phase: 'idle',
  countdown: 0,
  lastCheckFailed: false,
  checksDone: 0,
  signalsFired: 0,
  elapsedSeconds: 0,
};

export interface UseMonitoringArgs {
  /** Seconds per candle for the active timeframe. */
  timeframeSeconds: number;
  /** Blocks the loop, as `_marketClosed` does in Dart. */
  marketClosed: boolean;
  /**
   * Evaluates the monitoring strategy on the current candle.
   * Returns true when a signal was fired.
   */
  evaluate: () => boolean;
  /** True while a fired trade is still open or awaiting acknowledgement. */
  signalPending: boolean;
}

export function useMonitoring(args: UseMonitoringArgs) {
  const [state, setState] = useState<MonitoringState>(IDLE);

  const activeRef = useRef(false);
  const startedAtRef = useRef(0);
  const nextBoundaryRef = useRef(0);
  const evaluateAtRef = useRef(0);
  const argsRef = useRef(args);
  argsRef.current = args;

  /** Aligns to the next candle boundary, exactly as Dart computes it. */
  const scheduleNextBoundary = useCallback(() => {
    const cs = argsRef.current.timeframeSeconds;
    const nowSec = Math.floor(Date.now() / 1000);
    nextBoundaryRef.current = (Math.floor(nowSec / cs) + 1) * cs;
    evaluateAtRef.current = 0;
  }, []);

  const start = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;
    startedAtRef.current = Date.now();
    scheduleNextBoundary();
    // Dart's `startMonitoring` opens with the soft two-note confirmation.
    playActivateSound();
    setState({ ...IDLE, active: true, phase: 'waiting' });
  }, [scheduleNextBoundary]);

  const stop = useCallback(() => {
    activeRef.current = false;
    setState(IDLE);
  }, []);

  useEffect(() => {
    if (!state.active) return;

    const id = setInterval(() => {
      if (!activeRef.current) return;

      const { marketClosed, evaluate, signalPending } = argsRef.current;

      // A closed market ends the session, as `if (_marketClosed) break;` does.
      if (marketClosed) {
        activeRef.current = false;
        setState(IDLE);
        return;
      }

      const now = Date.now();
      const elapsedSeconds = Math.floor((now - startedAtRef.current) / 1000);

      // Phase: a trade is open, or its result has not been acknowledged yet.
      // Dart waits here so a new signal never fires over an open review dialog.
      if (signalPending) {
        setState((s) => ({ ...s, phase: 'trade', countdown: 0, elapsedSeconds }));
        return;
      }

      // The trade just cleared — resume without needing a button press.
      if (state.phase === 'trade') {
        scheduleNextBoundary();
        setState((s) => ({ ...s, phase: 'waiting', lastCheckFailed: false, elapsedSeconds }));
        return;
      }

      const nowSec = Math.floor(now / 1000);
      const remaining = nextBoundaryRef.current - nowSec;

      if (remaining > 0) {
        setState((s) => ({ ...s, phase: 'waiting', countdown: remaining, elapsedSeconds }));
        return;
      }

      // Boundary crossed — let the candle settle before evaluating.
      if (evaluateAtRef.current === 0) {
        evaluateAtRef.current = now + SETTLE_MS;
        setState((s) => ({ ...s, countdown: 0, elapsedSeconds }));
        return;
      }
      if (now < evaluateAtRef.current) return;

      const fired = evaluate();
      scheduleNextBoundary();

      setState((s) => ({
        ...s,
        checksDone: s.checksDone + 1,
        signalsFired: s.signalsFired + (fired ? 1 : 0),
        // Dart clears the flag on a fire and sets it when conditions fail.
        lastCheckFailed: !fired,
        phase: fired ? 'trade' : 'waiting',
        countdown: 0,
        elapsedSeconds,
      }));
    }, TICK_MS);

    return () => clearInterval(id);
  }, [state.active, state.phase, scheduleNextBoundary]);

  return { ...state, start, stop };
}

/** Seconds per candle. Mirrors Dart's `timeframeSeconds`. */
export function timeframeSeconds(timeframe: string): number {
  switch (timeframe) {
    case '1m': return 60;
    case '5m': return 300;
    case '15m': return 900;
    case '30m': return 1800;
    case '1h': return 3600;
    default: return 60;
  }
}

/** HH:MM:SS, matching `formattedMonitoringElapsed`. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
