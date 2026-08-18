'use client';

/**
 * The watch — ported from `startMonitoring` / `stopMonitoring`
 * (signal_engine.dart:713).
 *
 * A loop that waits for each candle to CLOSE, evaluates the strategy on the
 * freshly opened one, and fires only when the conditions actually hold. It
 * never forces a signal — a failed check just waits for the next candle.
 *
 * It is no longer something the user starts. There is one button now, and this
 * is the second half of it: the press analyses the current candle, and when
 * that candle does not match, this keeps the same strategy running against
 * every candle after it until one does.
 *
 * Which is why it now STOPS on a fire rather than looping back to waiting. It
 * was a standing watch you switched on and off; it is now the tail of a single
 * request, and that request is answered the moment a signal exists. Pressing
 * the button again starts a new one.
 *
 * The Dart version is a `while (_monitoring)` loop with `await Future.delayed`.
 * That shape does not survive React re-renders, so it is expressed here as a
 * phase machine driven by one interval. The sequence and the timings are
 * unchanged:
 *
 *   waiting → (candle closes) → +200ms settle → evaluate
 *     ├─ cycle finished  → stop, the result is on screen
 *     ├─ signal fired    → keep waiting: the trade still has to settle, and a
 *     │                    loss still owes its martingale
 *     └─ nothing yet     → flag "conditions not met" → waiting
 *
 * Firing is deliberately NOT what stops it. A strategy program can open a
 * trade, settle it and open a second one across three candles, and all three
 * need this loop alive; the program says when it is done by answering
 * `cycle_end`.
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

/**
 * There is no 'trade' phase any more.
 *
 * It existed because the watch outlived the signals it produced: it fired,
 * paused while the user looked at the trade, then went back to waiting. A
 * watch now ends on its first fire, so the phase it used to pause in is a
 * state it can no longer be in.
 */
export type MonitoringPhase = 'idle' | 'waiting';

export interface MonitoringState {
  active: boolean;
  phase: MonitoringPhase;
  /** Seconds until the current candle closes. */
  countdown: number;
  /** True when the last evaluated candle did not meet the conditions. */
  lastCheckFailed: boolean;
  checksDone: number;
  elapsedSeconds: number;
}

const IDLE: MonitoringState = {
  active: false,
  phase: 'idle',
  countdown: 0,
  lastCheckFailed: false,
  checksDone: 0,
  elapsedSeconds: 0,
};

export interface UseMonitoringArgs {
  /** Seconds per candle for the active timeframe. */
  timeframeSeconds: number;
  /** Blocks the loop, as `_marketClosed` does in Dart. */
  marketClosed: boolean;
  /**
   * Evaluates the strategy on the candle that just closed.
   *
   * Async because it refetches the candles first: the buffer is polled every
   * fifteen seconds and the candle that just closed is usually not in it yet.
   * Returns `cycle_end` when the strategy is finished, which ends the watch.
   */
  evaluate: () => Promise<'none' | 'signal' | 'cycle_end'>;
}

export function useMonitoring(args: UseMonitoringArgs) {
  const [state, setState] = useState<MonitoringState>(IDLE);

  const activeRef = useRef(false);
  /** One evaluation at a time — it awaits a fetch and the loop ticks 4×/s. */
  const runningRef = useRef(false);
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

      const { marketClosed, evaluate } = argsRef.current;

      // A closed market ends the session, as `if (_marketClosed) break;` does.
      if (marketClosed) {
        activeRef.current = false;
        setState(IDLE);
        return;
      }

      const now = Date.now();
      const elapsedSeconds = Math.floor((now - startedAtRef.current) / 1000);

      // No guard here for a trade already being open: `fireMonitoringSignal`
      // refuses while one is ACTIVE, and a watch that fires stops, so the two
      // cannot overlap.
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
      if (runningRef.current) return;

      runningRef.current = true;
      void evaluate()
        .then((result) => {
          scheduleNextBoundary();

          // A finished cycle is no longer the end of the watch.
          //
          // It used to stop here, on the reasoning that carrying on would open
          // a trade the user had not asked for. That was true when one press
          // meant one pass over one pair. It is not what the watch is any more:
          // the user chose a set of pairs and asked to be watched on them, and
          // a cycle ending is one opportunity finishing, not the end of the
          // watching. Stopping there meant pressing the button again after
          // every single trade.
          //
          // It stops when the user stops it, which is what the cancel button
          // has always been for.

          setState((s) => ({
            ...s,
            checksDone: s.checksDone + 1,
            // A candle that fired is not a candle that failed.
            lastCheckFailed: result === 'none',
            phase: 'waiting',
            countdown: 0,
            elapsedSeconds,
          }));
        })
        .finally(() => {
          runningRef.current = false;
        });
    }, TICK_MS);

    return () => clearInterval(id);
  }, [state.active, scheduleNextBoundary]);

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
