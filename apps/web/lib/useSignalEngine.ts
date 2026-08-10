'use client';

/**
 * Signal engine binding — the runtime half of `SignalEngine` that lived in the
 * Dart class alongside the maths.
 *
 * The maths itself is `@euro/engine`, already proven identical to Dart. What
 * lives here is only the orchestration the Flutter widget used to own: holding
 * the candle buffer, deciding when to score, counting a trade down, and
 * settling it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  alignExpiry,
  confidenceFor,
  evaluateRules,
  evaluateStrategyPro,
  outcomeFor,
  resolveExitPrice,
  guaranteedWinExit,
  ruleFromJson,
  pyramidFromJson,
  scoreStandard,
  systemClock,
  type Candle,
  type Direction,
  type DynamicStrategy,
  type TradingSignal,
} from '@euro/engine';
import { fetchCandles } from './candles';

/** Dart refreshes the real-candle buffer on this cadence. */
const CANDLE_POLL_MS = 15_000;

export interface EngineState {
  candles: Candle[];
  currentPrice: number;
  activeSignal: TradingSignal | null;
  secondsRemaining: number;
  history: TradingSignal[];
  /** Set when a request produced no valid setup; shown as a banner. */
  waitNotice: string;
  analysing: boolean;
}

export interface UseSignalEngineArgs {
  chartSymbol: string;
  timeframe: string;
  /** 'simulator' skips the real feed entirely, as `disableRealCandles` does. */
  priceSystem: string | null;
  role: string;
  guaranteedWin: boolean;
  /** Raw `configs` rows; null means fall back to the parametric V2 scorer. */
  strategyJson: Record<string, unknown> | null;
  pair: string;
}

/** Builds a DynamicStrategy from a raw config row, or null when unusable. */
function parseStrategy(json: Record<string, unknown> | null): DynamicStrategy | null {
  if (!json) return null;
  const rawRules = json['rules'];
  if (!Array.isArray(rawRules)) return null;

  const rules = rawRules
    // The master reference file interleaves `_section` markers that carry no
    // indicator; Dart's fromJson would throw on them.
    .filter((r): r is Record<string, unknown> =>
      typeof r === 'object' && r !== null && typeof (r as Record<string, unknown>)['indicator'] === 'string',
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

export function useSignalEngine(args: UseSignalEngineArgs) {
  const [state, setState] = useState<EngineState>({
    candles: [],
    currentPrice: 0,
    activeSignal: null,
    secondsRemaining: 0,
    history: [],
    waitNotice: '',
    analysing: false,
  });

  const livePriceRef = useRef<(() => number) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** Lets the chart supply the live price, as `_livePriceGetter` did in Dart. */
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
      const exit = args.guaranteedWin
        ? guaranteedWinExit(signal.direction, signal.entryPrice, live)
        : resolveExitPrice(signal.entryPrice, live);
      const result = args.guaranteedWin
        ? 'WIN'
        : outcomeFor(signal.direction, signal.entryPrice, exit);

      const settled: TradingSignal = {
        ...signal,
        status: result,
        exitPrice: exit,
        currentPrice: exit,
        candlesSnapshot: stateRef.current.candles.slice(),
      };

      setState((s) => ({
        ...s,
        activeSignal: settled,
        secondsRemaining: 0,
        // Newest first, capped at 50 like the Dart history.
        history: [settled, ...s.history].slice(0, 50),
      }));
    }, 250);

    return () => clearInterval(id);
  }, [state.activeSignal, args.guaranteedWin]);

  // ── Request a signal ──────────────────────────────────────────────────────
  /** Returns true when a signal actually fired — monitoring needs to know. */
  const requestSignal = useCallback(
    (selectedMinutes: number): boolean => {
      const { candles, currentPrice } = stateRef.current;
      if (candles.length === 0) return false;

      setState((s) => ({ ...s, analysing: true, waitNotice: '' }));

      const strategy = parseStrategy(args.strategyJson);
      const ctx = { candles, currentPrice, clock: systemClock() };

      // Mirrors `_generateNextSignal`: the pyramid's rejection blocks outright,
      // and min_score gates the rest. Neither forces a signal.
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

      if (blocked || absScore < minScore) {
        setState((s) => ({
          ...s,
          analysing: false,
          activeSignal: null,
          secondsRemaining: 0,
          waitNotice: blocked ? 'strategy' : 'min_score',
        }));
        return false;
      }

      const isCall = netScore >= 0;
      const base = strategy?.confidenceBase ?? 92.5;
      const max = strategy?.confidenceMax ?? 98.9;
      const confidence = confidenceFor(absScore, base, max);

      const aligned = alignExpiry(Date.now(), selectedMinutes);
      const live = livePriceRef.current?.() ?? 0;
      const entryPrice = live > 0 ? live : currentPrice;

      const signal: TradingSignal = {
        pair: args.pair,
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
        origin: 'instant',
      };

      setState((s) => ({
        ...s,
        analysing: false,
        activeSignal: signal,
        secondsRemaining: aligned.durationSeconds,
        waitNotice: '',
      }));

      return true;
    },
    [args.strategyJson, args.pair],
  );

  const clearSignal = useCallback(() => {
    setState((s) => ({ ...s, activeSignal: null, secondsRemaining: 0, waitNotice: '' }));
  }, []);

  return { ...state, requestSignal, clearSignal, setLivePriceGetter };
}
