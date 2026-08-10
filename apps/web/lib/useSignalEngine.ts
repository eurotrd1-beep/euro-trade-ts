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
 *   2. stop monitoring if it was running (the button takes over)
 *   3. twelve analysis stages, 400 ms apart, printing live indicator values
 *   4. WAIT for the current candle to close, counting down
 *   5. market-closed checks (weekend forex, frozen price on non-OTC)
 *   6. generate the signal — with a fallback if scoring throws
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  alignExpiry,
  confidenceFor,
  evaluateRules,
  evaluateStrategyPro,
  guaranteedWinExit,
  outcomeFor,
  pyramidFromJson,
  resolveExitPrice,
  ruleFromJson,
  scoreStandard,
  systemClock,
  type Candle,
  type Direction,
  type DynamicStrategy,
  type TradingSignal,
} from '@euro/engine';
import { fetchCandles } from './candles';
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

export interface UseSignalEngineArgs {
  chartSymbol: string;
  timeframe: string;
  /** 'simulator' skips the real feed entirely, as `disableRealCandles` does. */
  priceSystem: string;
  role: string;
  guaranteedWin: boolean;
  /** Raw `configs` row; null means fall back to the parametric V2 scorer. */
  strategyJson: Record<string, unknown> | null;
  /**
   * `monitoring_standard` / `monitoring_vip`. Monitoring runs its OWN strategy
   * in the Dart engine (`_activeMonitoringDynamic`), not the instant one — the
   * format and the scorer are identical, only the trigger differs.
   */
  monitoringStandardJson: Record<string, unknown> | null;
  monitoringVipJson: Record<string, unknown> | null;
  pair: string;
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
    pyramid: json['pyramid'] ? pyramidFromJson(json['pyramid'] as Record<string, unknown>) : null,
    rules,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  notify(
    `إشارة جديدة — ${signal.pair.replaceAll(' (OTC)', '')}`,
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
  /** Guards re-entry, as Dart's `_isAnalyzing` does. */
  const analysingRef = useRef(false);

  const setLivePriceGetter = useCallback((getter: () => number) => {
    livePriceRef.current = getter;
  }, []);

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

      setState((s) => ({
        ...s,
        activeSignal: settled,
        secondsRemaining: 0,
        history: [settled, ...s.history].slice(0, 50),
      }));
    }, 250);

    return () => clearInterval(id);
  }, [state.activeSignal]);

  /**
   * Produces the signal itself — Dart's `_generateNextSignal`. Returns null
   * when a gate blocked it, with the reason already written into state.
   */
  const generate = useCallback(
    (selectedMinutes: number, forMonitoring = false): TradingSignal | null => {
    const { candles, currentPrice } = stateRef.current;
    const a = argsRef.current;

    // Dart `_activeDynamic` / `_activeMonitoringDynamic`. Monitoring falls back
    // through the other role's monitoring strategy and finally to the instant
    // one, so a signal can still fire when the admin uploaded only one file.
    const instant = parseStrategy(a.strategyJson);
    const monStd = parseStrategy(a.monitoringStandardJson);
    const monVip = parseStrategy(a.monitoringVipJson);
    const strategy = forMonitoring
      ? ((a.role === 'vip' ? monVip : monStd) ?? monStd ?? monVip ?? instant)
      : instant;

    const ctx = { candles, currentPrice, clock: systemClock() };

    let netScore: number;
    let blocked = false;

    if (strategy?.pyramid) {
      const pro = evaluateStrategyPro(strategy, ctx);
      blocked = pro.result !== 'SIGNAL';
      netScore = blocked ? 0 : pro.finalScore.CALL - pro.finalScore.PUT;
    } else if (strategy) {
      netScore = evaluateRules(strategy, ctx);
    } else {
      netScore = scoreStandard(ctx, null);
    }

    const absScore = Math.abs(netScore);
    const minScore = strategy?.minScore ?? 0;

    // Dart respects the strategy's gates and does NOT force a signal.
    if (blocked || absScore < minScore) {
      setState((s) => ({
        ...s,
        activeSignal: null,
        secondsRemaining: 0,
        waitNotice: blocked ? 'strategy' : 'min_score',
      }));
      return null;
    }

    const isCall = netScore >= 0;
    const confidence = confidenceFor(
      absScore,
      strategy?.confidenceBase ?? 92.5,
      strategy?.confidenceMax ?? 98.9,
    );
    const aligned = alignExpiry(Date.now(), selectedMinutes);
    const live = livePriceRef.current?.() ?? 0;
    const entryPrice = live > 0 ? live : currentPrice;

    return {
      pair: argsRef.current.pair,
      direction: (isCall ? 'CALL' : 'PUT') as Direction,
      durationMinutes: selectedMinutes,
      entryPrice,
      currentPrice: entryPrice,
      confidence,
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
   * The button. Runs the full Dart sequence and resolves to true when a signal
   * was opened.
   */
  const requestSignal = useCallback(
    async (selectedMinutes: number): Promise<boolean> => {
      const current = stateRef.current;

      // Dart: refuse while analysing or while a trade is open.
      if (analysingRef.current) return false;
      if (current.activeSignal?.status === 'ACTIVE') return false;
      if (current.candles.length === 0) return false;

      // The instant button takes over from monitoring if it was running.
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
        return false;
      }

      // ── Frozen price on a non-OTC pair ────────────────────────────────────
      // Skipped for OTC (24/7): a quiet second there is not a closed market.
      const isOtc = !isForexPair(argsRef.current.pair);
      if (!isOtc && livePriceRef.current !== null && samples.size <= 1 && samples.size > 0) {
        finish({ activeSignal: null, secondsRemaining: 0, marketClosed: true });
        return false;
      }

      // ── Generate ──────────────────────────────────────────────────────────
      let signal: TradingSignal | null = null;
      try {
        signal = generate(selectedMinutes);
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
        // A gate blocked it; `generate` already set the wait notice.
        finish({});
        return false;
      }

      const secs = Math.max(1, Math.ceil((signal.expiryTime - Date.now()) / 1000));
      announceSignal(signal);
      finish({ activeSignal: signal, secondsRemaining: secs, waitNotice: '' });
      return true;
    },
    [generate],
  );

  /**
   * Monitoring's own fire path — Dart's `_fireMonitoringSignal`. No analysis
   * theatre and no candle wait: monitoring already waited for the close, so it
   * scores the freshly opened candle immediately.
   */
  const fireMonitoringSignal = useCallback(
    (selectedMinutes: number): boolean => {
      if (analysingRef.current) return false;
      if (stateRef.current.activeSignal?.status === 'ACTIVE') return false;
      if (stateRef.current.candles.length === 0) return false;

      const signal = generate(selectedMinutes, true);
      if (!signal) return false;

      const secs = Math.max(1, Math.ceil((signal.expiryTime - Date.now()) / 1000));
      announceSignal(signal);
      setState((s) => ({
        ...s,
        activeSignal: signal,
        secondsRemaining: secs,
        waitNotice: '',
      }));
      return true;
    },
    [generate],
  );

  const clearSignal = useCallback(() => {
    setState((s) => ({ ...s, activeSignal: null, secondsRemaining: 0, waitNotice: '' }));
  }, []);

  const clearMarketClosed = useCallback(() => {
    setState((s) => ({ ...s, marketClosed: false }));
  }, []);

  return {
    ...state,
    requestSignal,
    fireMonitoringSignal,
    clearSignal,
    clearMarketClosed,
    setLivePriceGetter,
  };
}
