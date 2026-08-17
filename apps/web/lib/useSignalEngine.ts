'use client';

/**
 * Signal engine binding — the runtime half of `SignalEngine`.
 *
 * The maths lives in `@euro/engine` and is proven identical to Dart by the
 * parity suite. This file reproduces the ORCHESTRATION the Flutter widget
 * owned, and in particular `requestNextSignal` (signal_engine.dart:2301),
 * which is what the button actually runs:
 *
 *   1. refuse if already analysing or a trade is open
 *   2. take over a watch already running (the press restarts the analysis)
 *   3. twelve analysis stages, 400 ms apart, printing live indicator values
 *   4. WAIT for the current candle to close, counting down
 *   5. market-closed checks (weekend forex, frozen price on non-OTC)
 *   6. generate the signal — with a fallback if scoring throws
 *
 * Step 6 answering "not this candle" is no longer the end of the press. The
 * two buttons were merged into one, so the same press keeps applying the same
 * strategy candle after candle until it fires — but the waiting itself belongs
 * to `useMonitoring`, and the join is made in app/app/page.tsx, which is the
 * only place that can see both halves.
 *
 * The one departure from Dart is `guaranteed_win`: there it only forced the
 * CLOSE onto the winning side, so a forced account could still be told "no
 * opportunity now" by the strategy. Here it forces the OPEN as well — a random
 * direction, no scoring, no gates — because an account that always wins is not
 * an account the strategy has anything to say about.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PROGRAM_ID,
  alignExpiry,
  confidenceFor,
  evaluateRules,
  programFor,
  guaranteedWinExit,
  outcomeFor,
  resolveExitPrice,
  ruleFromJson,
  scoreStandard,
  systemClock,
  type Candle,
  type Direction,
  type DynamicStrategy,
  type ProgramState,
  type StrategyProgram,
  type TradingSignal,
} from '@euro/engine';
import { fetchCandles } from './candles';
import { loadProgramState, saveProgramState } from './programState';
import {
  fetchRemoteHistory,
  loadHistory,
  mergeHistories,
  pushRemoteHistory,
  resolveOpenTrades,
  saveHistory,
} from './signalHistoryStore';
import { notify } from './signalNotify';
import {
  playCallSound,
  playLossSound,
  playNewSignalSound,
  playPutSound,
  playWinSound,
} from './sounds';
import {
  buildStages,
  isForexPair,
  isWeekend,
  STAGE_DELAY_MS,
  waitingText,
  WAIT_TICK_MS,
} from './analysis';
import { timeframeSeconds } from './useMonitoring';

/** Dart refreshes the real-candle buffer on this cadence. */
const CANDLE_POLL_MS = 15_000;

/**
 * How long after a candle boundary to read the candle that just closed.
 *
 * The same 200 ms the watch uses. The feed publishes the closed candle a moment
 * after the boundary; asking sooner gets the previous one back and the strategy
 * evaluates a bar the market has already moved past.
 */
const PROGRAM_SETTLE_MS = 200;

export interface EngineState {
  candles: Candle[];
  currentPrice: number;
  activeSignal: TradingSignal | null;
  secondsRemaining: number;
  history: TradingSignal[];
  /** 'strategy' | 'min_score' | '' — the "no opportunity now" banner. */
  waitNotice: string;
  analysing: boolean;
  /** Live text of the current analysis stage. */
  analysisStage: string;
  /**
   * Seconds until the CURRENT candle closes, ticked throughout the whole
   * analysis. The trade opens with the next candle, so this is the honest
   * answer to "when do I get my signal?" — shown from the first press rather
   * than only after the twelve stages finish.
   */
  candleSecondsLeft: number;
  /** Weekend forex, or a price that never moved during analysis. */
  marketClosed: boolean;
}

/**
 * What one press of the button came to.
 *
 * A bare `false` used to cover both "the strategy is not interested in this
 * candle" and "there is nothing I can do right now", and the caller has to
 * tell them apart: the first is what starts the watch, the second must not,
 * because monitoring a closed market just burns a counter in front of the user.
 */
export type RequestOutcome = 'signal' | 'no_match' | 'unavailable';

/**
 * What one candle did to a running program.
 *
 * `cycle_end` is the one the caller must not miss: it is the only thing that
 * stops the watch. A program that has fired a signal is NOT finished — the
 * trade still has to settle, and a loss still owes a martingale — so the watch
 * keeps ticking through `signal` and stops only here.
 */
export type TickResult = 'none' | 'signal' | 'cycle_end';

export interface UseSignalEngineArgs {
  chartSymbol: string;
  timeframe: string;
  /** 'simulator' skips the real feed entirely, as `disableRealCandles` does. */
  priceSystem: string;
  role: string;
  /**
   * Admin-controlled, per user. Bypasses the strategy on the way in (random
   * direction, no gates) and forces the close onto the winning side on the way
   * out. Statistics exclude these — `signals.forced` in signal_stats.sql.
   */
  guaranteedWin: boolean;
  /**
   * The strategy PROGRAM this plan runs, by id.
   *
   * A program is a state machine over a sequence of candles rather than a
   * score on one — see `programs/types.ts` in the engine. When a plan names
   * one it takes over completely: the rules in `strategyJson`, if any, are not
   * consulted, because a strategy cannot be two different things at once.
   *
   * Null means fall back to the rule scorer.
   */
  programId: string | null;
  pair: string;
  /**
   * Which account's history to load and save. Null until the session resolves.
   *
   * The Dart engine keyed the stored list the same way; without it two accounts
   * on one device read each other's trades.
   */
  accountId: string | null;
  /** Called when the button takes over from a running monitoring session. */
  onTakeOverMonitoring?: () => void;
}

/** Builds a DynamicStrategy from a raw config row, or null when unusable. */
function parseStrategy(json: Record<string, unknown> | null): DynamicStrategy | null {
  if (!json) return null;
  const rawRules = json['rules'];
  if (!Array.isArray(rawRules)) return null;

  const rules = rawRules
    // The master reference file interleaves `_section` markers with no
    // indicator; Dart's fromJson would throw on them.
    .filter(
      (r): r is Record<string, unknown> =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as Record<string, unknown>)['indicator'] === 'string',
    )
    .map(ruleFromJson);

  if (rules.length === 0) return null;
  const num = (k: string, d: number): number => (json[k] == null ? d : Number(json[k]));

  return {
    name: typeof json['name'] === 'string' ? json['name'] : 'Custom',
    minScore: num('min_score', 0),
    maxScore: num('max_score', 0),
    confidenceBase: num('confidence_base', 92.5),
    confidenceMax: num('confidence_max', 98.9),
    // A `pyramid` block in the file is ignored rather than rejected: the
    // layer that read it is gone, and refusing to load a strategy over a key
    // nothing consults would take the app down over dead JSON.
    rules,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether two lists differ in identity or outcome — cheap, order-sensitive. */
function differs(a: readonly TradingSignal[], b: readonly TradingSignal[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((s, i) => s.entryTime !== b[i]!.entryTime || s.status !== b[i]!.status);
}


/**
 * Every signal, whatever fired it, makes a sound and drops a line in the
 * notification shade. The Dart engine already used a different tone per path
 * (a rising two-oscillator chime for the button, the CALL/PUT alerts for
 * monitoring); the notification is the same for both.
 */
function announceSignal(signal: TradingSignal): void {
  if (signal.origin === 'monitoring') {
    if (signal.direction === 'CALL') playCallSound();
    else playPutSound();
  } else {
    playNewSignalSound();
  }

  const arrow = signal.direction === 'CALL' ? '🟢 صعود CALL' : '🔴 هبوط PUT';
  const pair = signal.pair.replaceAll(' (OTC)', '');

  // A martingale is entered at a doubled stake off the back of a loss. It is
  // the only trade the app opens that costs more than the last one, so it says
  // so in the notification rather than arriving as another green arrow.
  if (signal.stage === 'martingale') {
    notify(
      `مضاعفة — ${pair}`,
      `${arrow} · تعويض الصفقة الخاسرة · ${signal.durationMinutes} دقيقة · مرة واحدة فقط`,
    );
    return;
  }

  notify(
    `إشارة جديدة — ${pair}`,
    `${arrow} · الثقة ${signal.confidence.toFixed(1)}% · ${signal.durationMinutes} دقيقة`,
  );
}

export function useSignalEngine(args: UseSignalEngineArgs) {
  const [state, setState] = useState<EngineState>({
    candles: [],
    currentPrice: 0,
    activeSignal: null,
    secondsRemaining: 0,
    history: [],
    waitNotice: '',
    analysing: false,
    analysisStage: '',
    candleSecondsLeft: 0,
    marketClosed: false,
  });

  const livePriceRef = useRef<(() => number) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const argsRef = useRef(args);
  argsRef.current = args;

  // ── History, restored ─────────────────────────────────────────────────────
  // Held only in React state before, so every refresh emptied it and every
  // statistic drawn from it read zero. Loaded on the account, rewritten on each
  // settled trade — the same lifecycle the Dart engine had.
  //
  // Two copies, in this order and for different reasons. The cache is
  // synchronous, so the list is on screen in the first paint. The server copy
  // arrives a moment later and is MERGED in, never substituted: it is what makes
  // the log survive a cleared WebView, a reinstall, or a second device — which
  // is exactly what a device-local store could not do, and what a user signing
  // back into the same account reported losing.
  useEffect(() => {
    const id = args.accountId;
    if (!id) return;

    const cached = loadHistory(id);
    if (cached.length > 0) {
      setState((s) => ({ ...s, history: resolveOpenTrades(cached, args.pair, s.activeSignal) }));
    }

    let cancelled = false;
    void (async () => {
      const remote = await fetchRemoteHistory(id);
      // null means the server could not be asked. Unknown is not empty, so the
      // cache is left exactly as it is.
      if (cancelled || remote === null) return;

      // Merged against the CURRENT list rather than against `cached`: a trade
      // can settle while this request is in flight, and it must not be dropped.
      const merged = resolveOpenTrades(
        mergeHistories(stateRef.current.history, remote),
        argsRef.current.pair,
        stateRef.current.activeSignal,
      );
      saveHistory(id, merged);
      setState((s) => ({ ...s, history: merged }));

      // Only write back when this device is actually carrying something the
      // server has not seen, or when an abandoned trade was just marked. Left
      // unguarded, opening the app would be a write.
      if (merged.length !== remote.length || differs(merged, remote)) {
        void pushRemoteHistory(id, merged);
      }
    })();

    return () => { cancelled = true; };
  }, [args.accountId, args.pair]);

  // ── Resume a trade that was still running ─────────────────────────────────
  // The stored list can carry an ACTIVE trade whose expiry has NOT passed —
  // the app was closed, or reloaded, mid-trade. Putting it back into
  // `activeSignal` hands it to the countdown effect below, which settles it
  // against the live price exactly as if it had never been interrupted.
  //
  // Only for the pair it was opened on: settlement reads the live price of
  // whatever chart is showing, so restoring a EUR/USD trade onto a GBP/JPY
  // chart would judge it against the wrong market.
  useEffect(() => {
    if (state.activeSignal !== null || state.history.length === 0) return;
    const resumable = state.history.find(
      (s) => s.status === 'ACTIVE' && s.pair === args.pair && s.expiryTime > Date.now(),
    );
    if (resumable === undefined) return;
    setState((s) => ({
      ...s,
      activeSignal: resumable,
      secondsRemaining: Math.max(1, Math.ceil((resumable.expiryTime - Date.now()) / 1000)),
    }));
  }, [state.history, state.activeSignal, args.pair]);
  /** Guards re-entry, as Dart's `_isAnalyzing` does. */
  const analysingRef = useRef(false);

  // ── The strategy program ──────────────────────────────────────────────────
  //
  // Resolved from the plan's id. `guaranteedWin` deliberately does NOT run it:
  // a forced account is not being measured, so putting it through a strategy
  // that can decline to trade would hand a "nothing today" to the one user who
  // is supposed to win every time. That account keeps the old random path.
  const program: StrategyProgram | null = useMemo(
    () => (args.guaranteedWin ? null : programFor(args.programId ?? DEFAULT_PROGRAM_ID)),
    [args.programId, args.guaranteedWin],
  );
  const programRef = useRef<StrategyProgram | null>(program);
  programRef.current = program;

  const programStateRef = useRef<ProgramState | null>(null);

  // The state is per account, pair and timeframe, and it is read back from
  // storage rather than rebuilt: an open cycle has to survive a reload or the
  // martingale it earned is lost silently. See lib/programState.ts.
  useEffect(() => {
    if (program === null || args.accountId === null) {
      programStateRef.current = null;
      return;
    }
    programStateRef.current = loadProgramState(
      program,
      args.accountId,
      args.chartSymbol,
      args.timeframe,
    );
  }, [program, args.accountId, args.chartSymbol, args.timeframe]);

  /**
   * Writes a settled trade everywhere it has to appear, at once.
   *
   * Shared by the two settlement paths — the program's, which reads the
   * trade's own candle, and the live-price one that guaranteed-win accounts
   * still use — because the sounds, the card and the two copies of the history
   * must not drift apart depending on which one ran.
   */
  const settleTo = useCallback(
    (
      signal: TradingSignal,
      result: 'WIN' | 'LOSS' | 'TIE',
      entryPrice: number,
      exitPrice: number,
    ) => {
      const settled: TradingSignal = {
        ...signal,
        status: result,
        entryPrice,
        exitPrice,
        currentPrice: exitPrice,
        candlesSnapshot: stateRef.current.candles.slice(),
      };

      if (result === 'WIN') playWinSound();
      else if (result === 'LOSS') playLossSound();

      const history = mergeHistories([settled], stateRef.current.history);
      const accountId = argsRef.current.accountId;
      if (accountId) {
        saveHistory(accountId, history);
        void pushRemoteHistory(accountId, history);
      }
      setState((s) => ({ ...s, activeSignal: settled, secondsRemaining: 0, history }));
    },
    [],
  );

  const setLivePriceGetter = useCallback((getter: () => number) => {
    livePriceRef.current = getter;
  }, []);

  /**
   * Records a trade the instant it opens, before it has an outcome.
   *
   * Nothing used to be written until settlement, so a trade was invisible for
   * its whole life: close the app during it and it had never happened — not in
   * the log, not in the statistics, nowhere. It is stored as ACTIVE and the
   * settlement above replaces it in place, so the cost of a normal trade is one
   * extra write and the benefit is that no placed trade can vanish.
   */
  const recordOpen = useCallback((signal: TradingSignal) => {
    const history = mergeHistories([signal], stateRef.current.history);
    setState((s) => ({ ...s, history }));
    const id = argsRef.current.accountId;
    if (id) {
      saveHistory(id, history);
      void pushRemoteHistory(id, history);
    }
  }, []);

  /**
   * One closed candle through the program — the whole of the strategy's
   * runtime, called once per candle by the watch and once by the button.
   *
   * It fetches the candles itself rather than reading the buffer. The buffer is
   * polled every fifteen seconds, so at the moment a candle closes it is very
   * likely to be missing the candle that just closed — and the whole strategy
   * turns on reading exactly that one. Missing it would not error; it would
   * quietly evaluate the wrong bar.
   */
  const tickProgram = useCallback(async (): Promise<TickResult> => {
    const prog = programRef.current;
    const progState = programStateRef.current;
    const a = argsRef.current;
    if (prog === null || progState === null) return 'none';

    const fresh = await fetchCandles(a.chartSymbol, a.timeframe);
    const candles = fresh ?? stateRef.current.candles;
    if (candles.length === 0) return 'none';
    if (fresh !== null) {
      setState((st) => ({ ...st, candles, currentPrice: candles[candles.length - 1]!.close }));
    }

    const event = prog.onCandleClose(
      {
        candles,
        timeframeMs: timeframeSeconds(a.timeframe) * 1000,
        now: Date.now(),
      },
      progState,
    );

    if (a.accountId) {
      saveProgramState(prog, a.accountId, a.chartSymbol, a.timeframe, progState);
    }

    // Settled first, opened second: a losing trade and the martingale it earns
    // arrive on the same candle, and showing the new trade before the old one
    // has a result would put two open trades on screen at once.
    if (event.settled !== null) {
      const open = stateRef.current.activeSignal;
      if (open !== null && open.status === 'ACTIVE') {
        settleTo(open, event.settled.result, event.settled.entryPrice, event.settled.exitPrice);
      }
    }

    if (event.signal !== null) {
      const signal: TradingSignal = {
        pair: a.pair,
        direction: event.signal.direction,
        durationMinutes: prog.durationMinutes,
        // Provisional: the entry candle has only just opened, so its official
        // open is not in the buffer yet. The program overwrites both prices
        // with the candle's own when it settles, so the finished card shows the
        // numbers the result was actually computed from.
        entryPrice: livePriceRef.current?.() || stateRef.current.currentPrice,
        currentPrice: livePriceRef.current?.() || stateRef.current.currentPrice,
        // A touch either happened or it did not — there is no score behind it
        // and therefore no honest per-trade confidence. The program publishes
        // a constant so the card keeps its shape; varying it would be
        // inventing a measurement.
        confidence: prog.confidence,
        entryTime: event.signal.entryTime,
        expiryTime: event.signal.entryTime + prog.durationMinutes * 60_000,
        status: 'ACTIVE',
        exitPrice: null,
        candlesSnapshot: null,
        marketCondition: '',
        recommendation: '',
        origin: event.signal.stage === 'martingale' ? 'monitoring' : 'instant',
        stage: event.signal.stage,
      };

      announceSignal(signal);
      recordOpen(signal);
      setState((st) => ({
        ...st,
        activeSignal: signal,
        secondsRemaining: Math.max(1, Math.ceil((signal.expiryTime - Date.now()) / 1000)),
        waitNotice: '',
      }));
    }

    if (event.cycleEnd !== null) return 'cycle_end';
    return event.signal !== null ? 'signal' : 'none';
  }, [recordOpen, settleTo]);

  // ── Candle feed ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (args.priceSystem === 'simulator') return;
    let cancelled = false;

    async function sync(): Promise<void> {
      const candles = await fetchCandles(args.chartSymbol, args.timeframe);
      // null means "keep the current buffer" — never wipe it on a failed fetch.
      if (cancelled || candles === null) return;
      setState((s) => ({
        ...s,
        candles,
        currentPrice: candles[candles.length - 1]!.close,
      }));
    }

    void sync();
    const id = setInterval(() => void sync(), CANDLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [args.chartSymbol, args.timeframe, args.priceSystem]);

  // ── Countdown + settlement ────────────────────────────────────────────────
  useEffect(() => {
    const signal = state.activeSignal;
    if (!signal || signal.status !== 'ACTIVE') return;

    const id = setInterval(() => {
      const left = Math.ceil((signal.expiryTime - Date.now()) / 1000);
      if (left > 0) {
        setState((s) => ({ ...s, secondsRemaining: left }));
        return;
      }

      clearInterval(id);

      // A program settles its own trades, from the candle the trade ran on —
      // see `tickProgram`. Settling here as well would judge the same trade a
      // second time against a live tick, and the two answers differ often
      // enough on a one-minute binary to show a WIN card beside a martingale.
      // The countdown above still runs; only the verdict is left alone.
      if (programRef.current !== null) {
        setState((s) => ({ ...s, secondsRemaining: 0 }));
        return;
      }

      const live = livePriceRef.current?.() ?? null;
      const gw = argsRef.current.guaranteedWin;
      const exit = gw
        ? guaranteedWinExit(signal.direction, signal.entryPrice, live)
        : resolveExitPrice(signal.entryPrice, live);
      const result = gw ? 'WIN' : outcomeFor(signal.direction, signal.entryPrice, exit);

      const settled: TradingSignal = {
        ...signal,
        status: result,
        exitPrice: exit,
        currentPrice: exit,
        candlesSnapshot: stateRef.current.candles.slice(),
      };

      // Dart plays an outcome tone here; a tie is silent.
      if (result === 'WIN') playWinSound();
      else if (result === 'LOSS') playLossSound();

      // Merged, not prepended: the trade is already in the list as ACTIVE from
      // the moment it opened, so prepending would show it twice — once running
      // and once settled. `mergeHistories` matches them by identity and keeps
      // the settled one.
      const history = mergeHistories([settled], stateRef.current.history);
      const accountId = argsRef.current.accountId;
      if (accountId) {
        saveHistory(accountId, history);
        // Fire and forget: the cache already has the trade, so a failed write
        // costs the durable copy one trade until the next settlement, and
        // costs the user nothing right now.
        void pushRemoteHistory(accountId, history);
      }
      setState((s) => ({ ...s, activeSignal: settled, secondsRemaining: 0, history }));
    }, 250);

    return () => clearInterval(id);
  }, [state.activeSignal]);

  /**
   * The forced signal, for accounts the admin has set to always win.
   *
   * This is all that is left of `_generateNextSignal`. Everything else it used
   * to do — parse a rule file, score it, apply `min_score` — is gone with the
   * rule strategies themselves; the app runs programs now, and a program that
   * declines a candle simply says nothing.
   *
   * A forced account never reaches a program at all. Scoring it would be
   * pointless and actively harmful: a strategy that answers "not this candle"
   * would hand a wait to the one user who is supposed to win every trade. So
   * the direction is a coin flip, and the settlement forces the WIN.
   *
   * The randomness stays here rather than in `@euro/engine` on purpose: the
   * engine is vendored into the proxy generator, whose whole job is writing
   * signals that statistics are computed from. A forced signal must never be
   * reachable from there.
   */
  const forcedSignal = useCallback(
    (selectedMinutes: number, forMonitoring = false): TradingSignal => {
      const { currentPrice } = stateRef.current;
      const a = argsRef.current;
      const aligned = alignExpiry(Date.now(), selectedMinutes);
      const live = livePriceRef.current?.() ?? 0;
      const entry = live > 0 ? live : currentPrice;

      return {
        pair: a.pair,
        direction: (Math.random() < 0.5 ? 'CALL' : 'PUT') as Direction,
        durationMinutes: selectedMinutes,
        entryPrice: entry,
        currentPrice: entry,
        // The band a scored signal used to land in, so the card is
        // indistinguishable from a real one.
        confidence: 92.5 + Math.random() * (98.9 - 92.5),
        entryTime: aligned.entryTime,
        expiryTime: aligned.expiryTime,
        status: 'ACTIVE',
        exitPrice: null,
        candlesSnapshot: null,
        marketCondition: '',
        recommendation: '',
        origin: forMonitoring ? 'monitoring' : 'instant',
      };
    },
    [],
  );

  /**
   * The button. Runs the full sequence and says what it came to.
   *
   * It answers on the first candle only. When that candle does not match the
   * strategy it returns `no_match` and stops there — carrying on to the next
   * candle is the caller's job, because the counter and the watching panel
   * belong to `useMonitoring`, not here.
   */
  const requestSignal = useCallback(
    async (selectedMinutes: number): Promise<RequestOutcome> => {
      const current = stateRef.current;

      // Dart: refuse while analysing or while a trade is open.
      if (analysingRef.current) return 'unavailable';
      if (current.activeSignal?.status === 'ACTIVE') return 'unavailable';
      if (current.candles.length === 0) return 'unavailable';

      // Pressing it again restarts the analysis, so a watch already running is
      // taken over rather than left ticking underneath a second one.
      argsRef.current.onTakeOverMonitoring?.();

      analysingRef.current = true;
      setState((s) => ({
        ...s,
        analysing: true,
        marketClosed: false,
        waitNotice: '',
        activeSignal: null,
        secondsRemaining: 0,
      }));

      // Track live price across every stage to spot a frozen market.
      const samples = new Set<number>();
      const sample = () => {
        const p = livePriceRef.current?.();
        if (p && p > 0) samples.add(p);
      };
      sample();

      // The candle boundary is fixed the moment the button is pressed, so the
      // countdown shown during the stages is the same one the wait phase uses —
      // the user sees one number that only goes down.
      const cs = timeframeSeconds(argsRef.current.timeframe);
      const startSec = Math.floor(Date.now() / 1000);
      const currentCandleEnd = (Math.floor(startSec / cs) + 1) * cs;
      const secondsLeft = () => Math.max(0, currentCandleEnd - Math.floor(Date.now() / 1000));

      // Tick it every second for the whole analysis, not just the wait phase,
      // so "when do I get my signal?" is answered from the first press.
      setState((s) => ({ ...s, candleSecondsLeft: secondsLeft() }));
      const countdownTimer = setInterval(() => {
        setState((s) => ({ ...s, candleSecondsLeft: secondsLeft() }));
      }, 1000);

      // ── 12 analysis stages ────────────────────────────────────────────────
      const stages = buildStages({
        candles: current.candles,
        currentPrice: current.currentPrice,
        pair: argsRef.current.pair,
      });

      for (const text of stages) {
        setState((s) => ({ ...s, analysisStage: text }));
        await sleep(STAGE_DELAY_MS);
        sample();
      }

      // ── Wait for the current candle to close ──────────────────────────────
      // The trade opens with the NEXT candle. Display formula matches the
      // chart.js badge exactly: currentCandleEnd - now.
      {
        let lastRem = -1;
        for (;;) {
          const rem = currentCandleEnd - Math.floor(Date.now() / 1000);
          if (rem <= 0) break;
          if (rem !== lastRem) {
            lastRem = rem;
            setState((s) => ({ ...s, analysisStage: waitingText(rem) }));
            sample();
          }
          await sleep(WAIT_TICK_MS);
        }
      }

      const finish = (patch: Partial<EngineState>) => {
        clearInterval(countdownTimer);
        analysingRef.current = false;
        setState((s) => ({
          ...s,
          analysing: false,
          analysisStage: '',
          candleSecondsLeft: 0,
          ...patch,
        }));
      };

      // ── Market closed: weekend, forex only ────────────────────────────────
      if (isForexPair(argsRef.current.pair) && isWeekend()) {
        finish({ activeSignal: null, secondsRemaining: 0, marketClosed: true });
        return 'unavailable';
      }

      // ── Frozen price on a non-OTC pair ────────────────────────────────────
      // Skipped for OTC (24/7): a quiet second there is not a closed market.
      const isOtc = !isForexPair(argsRef.current.pair);
      if (!isOtc && livePriceRef.current !== null && samples.size <= 1 && samples.size > 0) {
        finish({ activeSignal: null, secondsRemaining: 0, marketClosed: true });
        return 'unavailable';
      }

      // ── The program's turn ────────────────────────────────────────────────
      // The candle has just closed. The feed needs a moment to publish it —
      // the same 200 ms the watch waits — and then the program reads it.
      if (programRef.current !== null) {
        await sleep(PROGRAM_SETTLE_MS);
        const result = await tickProgram();
        clearInterval(countdownTimer);
        analysingRef.current = false;
        setState((s) => ({ ...s, analysing: false, analysisStage: '', candleSecondsLeft: 0 }));
        return result === 'none' ? 'no_match' : 'signal';
      }

      // ── Generate ──────────────────────────────────────────────────────────
      // Only a forced account reaches this: everything else returned above,
      // out of the program.
      let signal: TradingSignal | null = null;
      try {
        signal = forcedSignal(selectedMinutes);
      } catch {
        // Scoring threw — fall back to a direction from the last two candles,
        // exactly as Dart does rather than leaving the user with nothing.
        const c = stateRef.current.candles;
        const isCall = c.length >= 2 ? c[c.length - 1]!.close >= c[c.length - 2]!.close : true;
        const aligned = alignExpiry(Date.now(), selectedMinutes);
        const entry = livePriceRef.current?.() || stateRef.current.currentPrice;

        signal = {
          pair: argsRef.current.pair,
          direction: (isCall ? 'CALL' : 'PUT') as Direction,
          durationMinutes: selectedMinutes,
          entryPrice: entry,
          currentPrice: entry,
          confidence: 75.0,
          entryTime: aligned.entryTime,
          expiryTime: aligned.expiryTime,
          status: 'ACTIVE',
          exitPrice: null,
          candlesSnapshot: null,
          marketCondition: 'تحليل مباشر',
          recommendation: isCall ? 'CALL ✅' : 'PUT ✅',
          origin: 'instant',
        };
      }

      if (!signal) {
        // A gate blocked it; `generate` already set the wait notice, which the
        // watching panel then shows as the reason it is still looking.
        finish({});
        return 'no_match';
      }

      const secs = Math.max(1, Math.ceil((signal.expiryTime - Date.now()) / 1000));
      announceSignal(signal);
      recordOpen(signal);
      finish({ activeSignal: signal, secondsRemaining: secs, waitNotice: '' });
      return 'signal';
    },
    [forcedSignal, recordOpen, tickProgram],
  );

  /**
   * The watch's tick — one closed candle, once per candle.
   *
   * With a program running this is the whole engine: it finds setups, opens
   * trades, settles them and decides on the martingale. Without one it falls
   * back to scoring the fresh candle with the rules, which is what the Dart
   * `_fireMonitoringSignal` did.
   *
   * Note it does NOT refuse while a trade is open, which the old version did:
   * an open trade is exactly when the program has work to do — the trade has
   * to be settled and may owe a martingale. The program's own state machine is
   * what prevents a second setup being taken meanwhile.
   */
  const fireMonitoringSignal = useCallback(
    async (selectedMinutes: number): Promise<TickResult> => {
      if (analysingRef.current) return 'none';

      if (programRef.current !== null) return tickProgram();

      if (stateRef.current.activeSignal?.status === 'ACTIVE') return 'none';
      if (stateRef.current.candles.length === 0) return 'none';

      const signal = forcedSignal(selectedMinutes, true);

      const secs = Math.max(1, Math.ceil((signal.expiryTime - Date.now()) / 1000));
      announceSignal(signal);
      recordOpen(signal);
      setState((s) => ({
        ...s,
        activeSignal: signal,
        secondsRemaining: secs,
        waitNotice: '',
      }));
      return 'signal';
    },
    [forcedSignal, recordOpen, tickProgram],
  );

  const clearSignal = useCallback(() => {
    setState((s) => ({ ...s, activeSignal: null, secondsRemaining: 0, waitNotice: '' }));
  }, []);

  const clearMarketClosed = useCallback(() => {
    setState((s) => ({ ...s, marketClosed: false }));
  }, []);

  return {
    ...state,
    /** The program driving this session, or null when the rules are. */
    program,
    requestSignal,
    fireMonitoringSignal,
    clearSignal,
    clearMarketClosed,
    setLivePriceGetter,
  };
}
