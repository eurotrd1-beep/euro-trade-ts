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
  setupProgress,
  type SetupProgress,
  resolveExitPrice,
  ruleFromJson,
  scoreStandard,
  systemClock,
  type Candle,
  type Direction,
  type DynamicStrategy,
  type ProgramState,
  type SetupDiagnostics,
  type StrategyProgram,
  type TradingSignal,
} from '@euro/engine';
import { fetchCandles, fetchCandlesBulk, fetchOtcStatus } from './candles';
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
import { acquireWatchLease, type WatchLease } from './watchLease';
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

/**
 * How long past expiry to keep waiting for the trade's candle before giving up.
 *
 * The candle poll runs every 15s and the scraper is a few seconds behind the
 * close, so a minute is several chances to see it. Past that it is not late,
 * it is missing, and a card that waits for ever is worse than one that says so.
 */
const STRANDED_AFTER_MS = 60_000;

/**
 * How often the live price of every pair is read while the watch runs.
 *
 * One request for all of them — the proxy publishes the whole map. Four
 * seconds is fast enough to catch a level being reached inside a
 * sixty-second candle and slow enough to be nothing.
 */
const PRICE_POLL_MS = 4000;

/**
 * How close to the level counts as "nearly there", as a fraction of the leg.
 *
 * A DISPLAY threshold, and nothing else: no trade, no setup and no settlement
 * reads it. It decides when a phone buzzes, and moving it changes when the
 * user is told — never what the strategy does.
 */
const NEAR_FRACTION = 0.2;

export interface EngineState {
  candles: Candle[];
  currentPrice: number;
  /**
   * The trade on the pair currently on the chart, or null.
   *
   * Derived from `openTrades` rather than stored: there is one of these per
   * pair now, and a single field could only ever describe one of them.
   */
  activeSignal: TradingSignal | null;
  /**
   * Every running trade, by symbol.
   *
   * ── WHY THIS IS NO LONGER ONE ──────────────────────────────────────────
   *
   * The watch covers several pairs at once, and they do not take turns: two of
   * them can reach their level on the same candle. Holding one trade for the
   * whole app meant the second was suppressed — evaluated on a discarded copy
   * of its state and recorded as an event to read about afterwards, which is a
   * missed trade described politely.
   *
   * Each pair now runs its own cycle to its own end, martingale included, and
   * switching to a pair shows that pair's trade. What is on screen is still
   * exactly one market's worth of information; there are simply more of them
   * behind it.
   */
  openTrades: Readonly<Record<string, TradingSignal>>;
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
  /**
   * False when another tab of this account is the one running the strategy.
   *
   * Only one may: the program's state lives in `localStorage` and each tab
   * keeps its own copy in memory, so two of them ticking the same pair on the
   * same candle open two trades for one setup and then overwrite each other's
   * cycle — which, between a loss and its martingale, is a recovery trade that
   * never happens and nothing reporting it. The UI stays fully readable in the
   * tabs that are not watching; they simply do not drive the engine.
   */
  watchOwner: boolean;
  /**
   * How many candles the strategy has actually read since the watch started.
   *
   * Every pair, every sweep. The watch used to count SWEEPS — one per pass,
   * whatever it covered — so a user watching five pairs saw "1" after the
   * strategy had read five candles, and "12" after sixty. The number was
   * describing the loop rather than the work, and the work is what the user is
   * waiting on.
   *
   * Pairs evaluated during an open trade count too. They are genuinely being
   * read: that is the whole point of the shadow tick, and leaving them out
   * would make the counter stall for a minute at a time for no visible reason.
   */
  candlesAnalysed: number;
  /**
   * How close every watched pair is to firing, as a percentage.
   *
   * ── ONE SOURCE, AND WHY THAT MATTERS MORE THAN IT SOUNDS ────────────────
   *
   * The bar above the chart and the bars in the card read this same map, in the
   * same render. Two sources — even two correct ones on slightly different
   * clocks — would show 67% in one place and 59% in the other at the same
   * moment, and a user comparing them has no way to tell which is the pair's
   * actual state. So there is one map, written once per sweep.
   *
   * There is also no separate timer, and there must not be. The number moves
   * with the PRICE, which arrives every few seconds; the candle only decides
   * where the level is. A second interval for the card would be a second clock
   * with nothing to gain — the smoothness comes from a CSS transition over the
   * gap between updates, not from updating more often.
   *
   * Every WATCHED pair is in here, including ones with no setup yet. That is
   * the change from the first version, which measured only the gap between
   * price and the level and so could only describe a pair that already had one:
   * everything else was absent, and everything present was already nearly
   * ready. The scale started at "almost" and never showed the work in front of
   * it. `setupProgress` spreads it across the strategy's own gates instead.
   */
  completions: Readonly<Record<string, SetupProgress>>;

  /**
   * True once the user has picked a pair by hand.
   *
   * Following stops there and stays stopped until they say otherwise. A chart
   * that moves out from under somebody who is reading it is the fastest way to
   * lose their trust in everything else on the screen — and picking a pair is
   * about as clear a statement of "I want to look at this one" as exists.
   */
  followPaused: boolean;
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
  /**
   * Every pair the watch scans, as chart symbols.
   *
   * The strategy does not care which chart is on screen: a setup on GBP/JPY is
   * as good as one on the pair the user happens to be looking at, and watching
   * only the visible one throws away 88 of the 89 chances a minute offers. The
   * chart follows the signal rather than the other way round.
   */
  watchSymbols: readonly string[];
  /** True while the watch is running — gates the between-candle price polling. */
  watching: boolean;
  /** Called when a signal lands on a pair other than the one on screen. */
  onPairSwitch?: (chartSymbol: string) => void;
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
/**
 * A chart symbol turned into something a person reads.
 *
 * `EURUSD_otc` → `EUR/USD`. The pair matters more than it used to: the watch
 * scans every pair, so a notification arriving on a phone has to say which
 * market it is about before it says anything else.
 */
function displayNameFor(chartSymbol: string): string {
  const base = chartSymbol.replace(/_otc$/i, '').replace(/^#/, '');
  return /^[A-Za-z]{6}$/.test(base) ? `${base.slice(0, 3)}/${base.slice(3)}`.toUpperCase() : base;
}

/** The same name the pair list and the history use, so one trade reads alike everywhere. */
function pairNameFor(chartSymbol: string): string {
  const name = displayNameFor(chartSymbol);
  return /_otc$/i.test(chartSymbol) ? `${name} OTC` : name;
}

/**
 * Whether a signal belongs to this feed symbol.
 *
 * On `symbol` when the signal has one, which is every signal created from now
 * on. The fallback to the display name is only for trades recorded before the
 * field existed, and it is a fallback rather than the rule because the name is
 * not an identifier: the catalogue calls `XAUUSD_otc` "Gold OTC", so nine pairs
 * — every metal and every crypto — would never match themselves.
 */
function sameTrade(signal: TradingSignal | null, chartSymbol: string): boolean {
  if (signal === null) return false;
  return signal.symbol !== undefined
    ? signal.symbol === chartSymbol
    : signal.pair === pairNameFor(chartSymbol);
}

/** Prices at the precision the pair is quoted to — three decimals for yen. */
function formatLevel(price: number): string {
  return price.toFixed(price >= 50 ? 3 : 5);
}

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
    openTrades: {},
    secondsRemaining: 0,
    history: [],
    waitNotice: '',
    analysing: false,
    analysisStage: '',
    candleSecondsLeft: 0,
    marketClosed: false,
    completions: {},
    candlesAnalysed: 0,
    watchOwner: true,
    followPaused: false,
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
      setState((s) => ({
        ...s,
        history: resolveOpenTrades(cached, args.pair, s.openTrades[args.chartSymbol] ?? null),
      }));
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
        stateRef.current.openTrades[argsRef.current.chartSymbol] ?? null,
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
    if (Object.keys(state.openTrades).length > 0 || state.history.length === 0) return;
    const resumable = state.history.find(
      (s) => s.status === 'ACTIVE' && s.expiryTime > Date.now(),
    );
    if (resumable === undefined) return;

    if (resumable.symbol === undefined) return;
    const sym = resumable.symbol;
    setState((s) => ({ ...s, openTrades: { ...s.openTrades, [sym]: resumable } }));

    // Whatever pair it was opened on — it used to require the chart to already
    // be showing that pair, and after a reload the chart is on whatever it
    // defaults to. So a trade running on any other market was never picked back
    // up: no card, no countdown, and nothing to settle it against, leaving a
    // row that sat ACTIVE until it aged into PENDING and stayed there.
    //
    // The chart follows it, which is also the rule everywhere else now: what is
    // on screen and what is being traded are the same pair.
    if (resumable.symbol !== undefined && resumable.symbol !== args.chartSymbol) {
      argsRef.current.onPairSwitch?.(resumable.symbol);
    }
  }, [state.history, state.openTrades, args.chartSymbol]);
  // ── One tab runs the strategy ─────────────────────────────────────────────
  //
  // See `watchLease.ts` for what goes wrong without this. The ref is what the
  // tick reads — state would be a render behind, and a render behind is a whole
  // candle when the interval is seconds.
  const ownerRef = useRef(true);
  const leaseRef = useRef<WatchLease | null>(null);

  useEffect(() => {
    const lease = acquireWatchLease((owned) => {
      ownerRef.current = owned;
      setState((st) => (st.watchOwner === owned ? st : { ...st, watchOwner: owned }));
    });
    leaseRef.current = lease;
    return () => {
      lease.stop();
      leaseRef.current = null;
    };
  }, []);

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

  /**
   * One program state per pair, built lazily.
   *
   * The states are NOT persisted, with one exception below. An armed setup is
   * a pure function of the candles, so it rebuilds itself within a couple of
   * closes; an open cycle is not — it remembers a trade that has already been
   * placed and a martingale that may be owed — so that one is written to
   * storage and read back.
   */
  const programStatesRef = useRef(new Map<string, ProgramState>());

  /** The pair holding the open cycle, or null. Nothing else is ticked while set. */
  const cycleSymbolRef = useRef<string | null>(null);

  /** The loudest alert already sent for a pair's current setup, keyed by setup. */
  const alertedRef = useRef(new Map<string, string>());
  /**
   * The last candle's search diagnostics, per pair.
   *
   * `setupProgress` needs them to tell "no confirmed pivots at all" from "a leg
   * was found and refused", and they arrive on the event rather than living in
   * the program's state. A ref rather than state: they are read during the same
   * sweep that writes them, and a render behind is a whole candle at this
   * cadence.
   */
  const diagnosticsRef = useRef(new Map<string, SetupDiagnostics>());

  const stateFor = useCallback((symbol: string): ProgramState => {
    const prog = programRef.current;
    if (prog === null) return { cycle: null, armed: null, firedKeys: [], lastCandleTime: 0 };

    const held = programStatesRef.current.get(symbol);
    if (held !== undefined) return held;

    const a = argsRef.current;
    const fresh = a.accountId
      ? loadProgramState(prog, a.accountId, symbol, a.timeframe)
      : prog.init();
    programStatesRef.current.set(symbol, fresh);
    if (fresh.cycle !== null) cycleSymbolRef.current = symbol;
    return fresh;
  }, []);

  // Everything is dropped when the program or the account changes: states
  // belong to one account on one program, and carrying them across would
  // settle one user's trade with another's candles.
  useEffect(() => {
    programStatesRef.current = new Map();
    cycleSymbolRef.current = null;
    alertedRef.current = new Map();
  }, [program, args.accountId, args.timeframe]);

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
      setState((s) => {
        // The settled trade leaves the open set. Its result is in the history,
        // which is where a finished trade belongs; leaving it here would keep a
        // countdown on screen for something that has already happened.
        const open = { ...s.openTrades };
        if (settled.symbol !== undefined) delete open[settled.symbol];
        return { ...s, openTrades: open, history };
      });
    },
    [],
  );

  /**
   * Reconciles the open card against the candle the trade actually ran on.
   *
   * Two things were wrong, and both come from the card never seeing that
   * candle.
   *
   * **The entry price was the wrong number.** A signal fires when candle N
   * closes, for a trade on candle N+1, and the card was opened with
   * `close[N]` because that is all there is at the time. But the engine
   * settles from `open[N+1]` — the price the trade is actually taken at. On
   * this feed those differ on 87% of candles, and in 3–5 candles out of a
   * hundred they differ enough to flip the verdict: the user watches price
   * finish above the entry on their screen, and the engine records a LOSS and
   * fires the martingale. So the entry is corrected the moment that candle
   * exists, before the trade settles rather than after.
   *
   * **The card could hang open for ever.** `onCandleClose` reads only the
   * newest closed candle, so if a tick misses one — a slow poll, a pair later
   * in the scan order after another opened a trade — the next call sees a
   * candle PAST the entry and returns `ABORTED` with nothing settled. The
   * countdown had already handed the verdict to the program and stepped
   * aside, so the card sat at zero with no result, for ever. Here the trade is
   * settled from its own candle instead, with `outcomeFor` on `open` and
   * `close`: the same call on the same two numbers the engine uses, so this
   * cannot disagree with it — it is the same arithmetic, not a second opinion.
   *
   * And if that candle never arrives at all, the card is closed as unresolved
   * rather than left spinning. "No price" is a real fourth state.
   */
  const reconcileOpenTrade = useCallback((symbol: string, candles: readonly Candle[]) => {
    const open = stateRef.current.openTrades[symbol] ?? null;
    if (open === null || open.status !== 'ACTIVE') return;

    const bar = candles.find((c) => c.time === open.entryTime);

    if (bar === undefined) {
      // Still fine while the trade is running or the candle is in flight.
      if (Date.now() < open.expiryTime + STRANDED_AFTER_MS) return;

      const stale: TradingSignal = {
        ...open,
        status: 'UNRESOLVED',
        exitPrice: null,
        candlesSnapshot: stateRef.current.candles.slice(),
      };
      const history = mergeHistories([stale], stateRef.current.history);
      const accountId = argsRef.current.accountId;
      if (accountId) {
        saveHistory(accountId, history);
        void pushRemoteHistory(accountId, history);
      }
      setState((s) => {
        const open = { ...s.openTrades };
        delete open[symbol];
        return { ...s, openTrades: open, history };
      });
      return;
    }

    // The candle exists. Show its open as the entry — that is the price the
    // trade was taken at, whatever the card was opened with.
    if (bar.open !== open.entryPrice) {
      setState((s) => {
        const held = s.openTrades[symbol];
        if (held === undefined || held.status !== 'ACTIVE') return s;
        return { ...s, openTrades: { ...s.openTrades, [symbol]: { ...held, entryPrice: bar.open } } };
      });
    }

    // Settle only once the candle is closed. A candle still forming has a
    // `close` that is just the current price, and judging on it is the
    // live-tick settlement this deliberately does not do.
    const closed = Date.now() >= open.expiryTime;
    if (!closed) return;

    const result = argsRef.current.guaranteedWin
      ? 'WIN'
      : outcomeFor(open.direction, bar.open, bar.close);
    settleTo(open, result, bar.open, bar.close);
  }, [settleTo]);

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
  /**
   * Applies one closed candle to one pair, and does whatever the answer says.
   *
   * Returns what the tick came to, so the caller can stop scanning the moment
   * a trade opens.
   */
  const applyEvent = useCallback(
    (symbol: string, prog: StrategyProgram, candles: Candle[], progState: ProgramState): TickResult => {
      const a = argsRef.current;
      const armedBefore = progState.armed?.key ?? null;

      const event = prog.onCandleClose(
        { candles, timeframeMs: timeframeSeconds(a.timeframe) * 1000, now: Date.now() },
        progState,
      );

      if (event.diagnostics !== undefined) {
        diagnosticsRef.current.set(symbol, event.diagnostics);
      }

      // Only the cycle is worth storing — see `stateFor`.
      if (a.accountId && (progState.cycle !== null || event.cycleEnd !== null)) {
        saveProgramState(prog, a.accountId, symbol, a.timeframe, progState);
      }

      // A newly adopted setup is the first thing worth telling the user about:
      // the swing is found and validated, and only the touch is outstanding.
      const armedNow = progState.armed;
      if (armedNow !== null && armedNow.key !== armedBefore) {
        alertedRef.current.set(symbol, `${armedNow.key}|armed`);
        notify(
          `فرصة بتتكوّن — ${displayNameFor(symbol)}`,
          `${armedNow.direction === 'CALL' ? '🟢 صعود' : '🔴 هبوط'} · مستنيين السعر يوصل ${formatLevel(armedNow.level)}`,
        );
      }
      if (armedNow === null && armedBefore !== null) alertedRef.current.delete(symbol);

      if (event.settled !== null) {
        // The card, or — when there is no card — the trade's own row in the
        // history. The verdict used to be dropped entirely if `activeSignal`
        // happened to be empty, which is exactly the state a reload leaves
        // behind: the engine settles the cycle it restored from storage, finds
        // nothing on screen to apply it to, and throws the answer away. The
        // trade then never resolves anywhere the user can see.
        const open = stateRef.current.openTrades[symbol] ?? null;
        const target =
          open !== null && open.status === 'ACTIVE'
            ? open
            : (stateRef.current.history.find(
                (h) => h.status === 'ACTIVE' && sameTrade(h, symbol),
              ) ?? null);

        if (target !== null) {
          settleTo(target, event.settled.result, event.settled.entryPrice, event.settled.exitPrice);
        }
      }

      // The trade's own candle is in this array the moment the scan reaches
      // its pair, which is sooner than the fifteen-second chart poll. The
      // entry line on the chart is drawn at this price, and until it is
      // corrected it sits at the previous close — measured on the live feed,
      // that is a couple of pips from where the trade actually opened.
      reconcileOpenTrade(symbol, candles);

      if (event.signal !== null) {
        cycleSymbolRef.current = symbol;
        // The chart follows the signal. Told before the card appears, so the
        // user is never reading a price for one pair beside a trade on another.
        if (symbol !== a.chartSymbol) a.onPairSwitch?.(symbol);

        const signal: TradingSignal = {
          pair: pairNameFor(symbol),
          symbol,
          direction: event.signal.direction,
          durationMinutes: prog.durationMinutes,
          entryPrice: candles[candles.length - 1]!.close,
          currentPrice: candles[candles.length - 1]!.close,
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
          openTrades: { ...st.openTrades, [symbol]: signal },
          waitNotice: '',
        }));
      }

      if (event.cycleEnd !== null) {
        cycleSymbolRef.current = null;
        return 'cycle_end';
      }
      return event.signal !== null ? 'signal' : 'none';
    },
    [recordOpen, settleTo],
  );

  /**
   * One closed candle, across every pair being watched.
   *
   * Two modes, and the difference matters:
   *
   *   • a cycle is open → ONLY that pair is ticked. Its trade has to settle and
   *     may owe a martingale, and no other pair may open a second trade while
   *     it runs. The others are not ticked at all rather than ticked and
   *     ignored — ignoring a signal would leave that pair believing it had a
   *     trade open that the app never showed.
   *   • otherwise → every pair, in one bulk request, stopping at the first
   *     signal. The pairs after it keep their state untouched for the same
   *     reason.
   */
  /**
   * Measures how close every watched pair is, and records it.
   *
   * This used to also pick a "leader" and move the chart to it, which existed
   * to cover the pairs a user had NOT chosen — back when the app watched all
   * eighty-nine and the user chose none of them. The watch list is the choice
   * now, so there is nothing left to cover and nothing to lead; the chart moves
   * when a signal fires or when the user asks, and not otherwise.
   *
   * What remains is the measuring, because two things on screen read it: the
   * bar above the chart and the bars in the card. One map, written here, so the
   * two cannot disagree about a pair at the same moment.
   */
  const rankWatched = useCallback((bulk: Map<string, Candle[]>) => {
    if (programRef.current === null) return;

    const percents: Record<string, SetupProgress> = {};
    for (const [symbol, candles] of bulk) {
      if (candles.length === 0) continue;
      const held = programStatesRef.current.get(symbol);
      if (held === undefined) continue;
      percents[symbol] = setupProgress(
        held,
        diagnosticsRef.current.get(symbol) ?? null,
        candles[candles.length - 1]!.close,
      );
    }

    // Replaced wholesale rather than merged: a pair whose setup has expired must
    // disappear from the card, and merging would leave its last percentage
    // sitting there for ever, describing a level that no longer exists.
    setState((st) => ({ ...st, completions: percents }));
  }, []);

  const tickProgram = useCallback(async (): Promise<TickResult> => {
    const prog = programRef.current;
    const a = argsRef.current;
    if (prog === null) return 'none';

    // Not this tab's job. Checked here rather than at the interval so the
    // decision is made against the moment of the tick: a tab can gain or lose
    // the lease between two of them, and acting on a stale answer is exactly
    // the double-trade this prevents.
    if (!ownerRef.current) return 'none';

    // Every watched pair, every sweep, on its own real state.
    //
    // There used to be a branch here that gave the engine to whichever pair had
    // an open cycle and shadow-ticked the rest on discarded copies. That was
    // how "one trade at a time" was enforced, and it meant a second pair
    // reaching its level had its trade suppressed and reported afterwards as
    // something the user had missed. Pairs run independently now.

    // ── Scanning ─────────────────────────────────────────────────────────
    // Nothing chosen means nothing watched. It used to fall back to whatever
    // pair was on the chart, which was right when the watch swept the whole
    // catalogue and the fallback only mattered before the list loaded — but now
    // the list IS the user's choice, and quietly watching a pair they did not
    // pick is the mismatch this redesign exists to remove.
    const symbols = a.watchSymbols;
    if (symbols.length === 0) return 'none';
    const bulk = await fetchCandlesBulk(symbols, a.timeframe);

    // The bulk endpoint is part of the proxy, and the two deploy separately.
    // If the app ships first it would otherwise scan nothing at all and go
    // quiet for reasons no user could guess — so it falls back to the pair on
    // screen, which is what it watched before any of this. Degraded, not
    // broken, and it heals itself the moment the proxy catches up.
    if (bulk.size === 0) {
      const only = await fetchCandles(a.chartSymbol, a.timeframe);
      if (only === null || only.length === 0) return 'none';
      setState((st) => ({ ...st, candles: only, currentPrice: only[only.length - 1]!.close }));
      return applyEvent(a.chartSymbol, prog, only, stateFor(a.chartSymbol));
    }

    const onChart = bulk.get(a.chartSymbol);
    if (onChart !== undefined && onChart.length > 0) {
      setState((st) => ({ ...st, candles: onChart, currentPrice: onChart[onChart.length - 1]!.close }));
    }

    // The pair on screen goes first, so that when two pairs would both fire on
    // the same candle the user's own chart wins and nothing jumps.
    const ordered = [a.chartSymbol, ...symbols.filter((sym) => sym !== a.chartSymbol)];

    let read = 0;
    for (const symbol of ordered) {
      const candles = bulk.get(symbol);
      if (candles === undefined || candles.length === 0) continue;

      read++;
      const result = applyEvent(symbol, prog, candles, stateFor(symbol));
      if (result !== 'none') {
        // Counted before the early return: the pairs after this one are
        // deliberately left untouched, but the ones already read were read.
        setState((st) => ({ ...st, candlesAnalysed: st.candlesAnalysed + read }));
        return result;
      }
    }
    if (read > 0) setState((st) => ({ ...st, candlesAnalysed: st.candlesAnalysed + read }));

    // Which pair to follow is a question about all of them at once, so it is
    // asked after the loop rather than inside it.
    rankWatched(bulk);
    return 'none';
  }, [applyEvent, stateFor, rankWatched]);

  /**
   * Between candles: how close is any watched pair to its level?
   *
   * This is the half of the alerting that cannot wait for a close. Every
   * armed setup has a price it is waiting for, and the proxy publishes every
   * pair's live price in one payload — so "nearly there" and "it just
   * happened" can both be said while the candle is still forming.
   *
   * It never trades. A level reached mid-candle is a fact that cannot be taken
   * back — a candle's range only ever grows — so saying so early is honest;
   * ACTING on it early would be a different strategy from the one specified,
   * and the trade still opens on the candle after the one that closes.
   */
  useEffect(() => {
    if (!args.watching || program === null) return;
    let cancelled = false;

    async function poll(): Promise<void> {
      const status = await fetchOtcStatus(argsRef.current.chartSymbol);
      if (cancelled || status === null) return;

      for (const [symbol, st] of programStatesRef.current) {
        const armed = st.armed;
        if (armed === null || st.cycle !== null) continue;

        const price = status.prices[symbol];
        if (typeof price !== 'number' || price <= 0) continue;

        // The leg's size, recovered from the level: the level sits 23.6% of
        // the way back from the end, so the distance to it IS 23.6% of the leg.
        const range = Math.abs(armed.level - armed.endPrice) / 0.236;
        const distance = Math.abs(price - armed.level);

        // Reached: the retracement approaches from the side the leg ran, so
        // an up-swing's level is met from above and a down-swing's from below.
        const reached = armed.direction === 'CALL' ? price <= armed.level : price >= armed.level;
        const stage = reached ? 'touched' : distance <= range * NEAR_FRACTION ? 'near' : null;
        if (stage === null) continue;

        const mark = `${armed.key}|${stage}`;
        if (alertedRef.current.get(symbol) === mark) continue;
        // Never step back down from `touched` to `near` on a wobble.
        if (stage === 'near' && alertedRef.current.get(symbol)?.endsWith('|touched')) continue;
        alertedRef.current.set(symbol, mark);

        const name = displayNameFor(symbol);
        const arrow = armed.direction === 'CALL' ? '🟢 صعود' : '🔴 هبوط';
        if (stage === 'touched') {
          notify(
            `الشروط اتحققت — ${name}`,
            `${arrow} · السعر لمس ${formatLevel(armed.level)} · الصفقة هتفتح مع الشمعة الجاية`,
          );
        } else {
          notify(`الإشارة قربت — ${name}`, `${arrow} · فاضل ${formatLevel(distance)} على ${formatLevel(armed.level)}`);
        }
      }
    }

    void poll();
    const id = setInterval(() => void poll(), PRICE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [args.watching, program]);

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
      reconcileOpenTrade(args.chartSymbol, candles);
    }

    void sync();
    const id = setInterval(() => void sync(), CANDLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [args.chartSymbol, args.timeframe, args.priceSystem]);

  // ── Countdown + settlement ────────────────────────────────────────────────
  /**
   * A once-a-second tick, so the countdowns move.
   *
   * The remaining seconds are DERIVED from each trade's own expiry rather than
   * stored, because there is one per pair now and a single field could describe
   * only one of them. Derived values do not re-render on their own, so this
   * exists purely to say "time passed" — and it runs only while something is
   * counting down.
   *
   * It settles nothing. A trade is settled by the program, from the candle it
   * actually ran on; judging it here against a live tick as well would produce
   * a second verdict, and on a one-minute binary the two disagree often enough
   * to show a WIN card beside a martingale for the same trade.
   */
  const [, forceTick] = useState(0);
  const anyOpen = Object.keys(state.openTrades).length > 0;
  useEffect(() => {
    if (!anyOpen) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [anyOpen]);


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
        symbol: a.chartSymbol,
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

      // Nothing to watch. The button is disabled in this state, so reaching
      // here means something got past the UI — a stale render, a keyboard
      // press on a control that has not repainted yet — and starting a sweep
      // over an empty list would leave a counter running for a watch that can
      // never produce anything.
      if (argsRef.current.watchSymbols.length === 0) return 'unavailable';

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
        // A press is a new session, and the count belongs to the session.
        candlesAnalysed: 0,
      }));

      // Track live price across every stage to spot a frozen market.
      const samples = new Set<number>();
      const sample = () => {
        const p = livePriceRef.current?.();
        if (p && p > 0) samples.add(p);
      };
      sample();

      // ── The staged analysis and the wait screen are gone ────────────────
      //
      // Pressing the button used to open a five-second sequence of narrated
      // stages and then a countdown to the candle close, and only then start
      // watching. Both described work on ONE pair, which is no longer what
      // happens: the strategy runs across every pair the user chose, and it
      // runs again on every candle until something fires.
      //
      // So the watch panel comes up immediately and is the only thing shown.
      // It says what is actually true — live on each candle, across these pairs
      // — instead of narrating a single pass that was over before the user had
      // finished reading about it.

      const finish = (patch: Partial<EngineState>) => {
        analysingRef.current = false;
        setState((s) => ({ ...s, analysing: false, ...patch }));
      };

      // ── Market closed ─────────────────────────────────────────────────────
      //
      // Decided from the pairs being WATCHED, not from the one on the chart.
      // It used to refuse the whole run because the chart happened to be
      // showing a weekday-only pair on a Sunday — with five OTC pairs chosen
      // and trading around the clock, the app announced the market was shut and
      // did nothing. The closed ones are already dropped from the sweep by
      // `watchSymbols`, so the only question left is whether ANY of them are
      // open, and one is enough.
      const open = argsRef.current.watchSymbols.filter((sym) => !isForexPair(sym) || !isWeekend());
      if (open.length === 0) {
        finish({ activeSignal: null, secondsRemaining: 0, marketClosed: true });
        return 'unavailable';
      }

      // ── Frozen price ──────────────────────────────────────────────────────
      //
      // Only when every watched pair is one that can close. A quiet second on
      // OTC is not a closed market — it trades 24/7 — so a single OTC pair in
      // the list is enough for a still price to mean nothing.
      const allClosable = open.every((sym) => isForexPair(sym));
      if (allClosable && livePriceRef.current !== null && samples.size <= 1 && samples.size > 0) {
        finish({ activeSignal: null, secondsRemaining: 0, marketClosed: true });
        return 'unavailable';
      }

      // ── The program's turn ────────────────────────────────────────────────
      // Straight to it. The strategy reads the last CLOSED candle and that one
      // already exists, so waiting for the next close would only be a minute of
      // nothing on screen before the watch does exactly this by itself.
      if (programRef.current !== null) {
        const result = await tickProgram();
        analysingRef.current = false;
        setState((st) => ({ ...st, analysing: false }));
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
          symbol: argsRef.current.chartSymbol,
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

      announceSignal(signal);
      recordOpen(signal);
      finish({
        openTrades: { ...stateRef.current.openTrades, [argsRef.current.chartSymbol]: signal },
        waitNotice: '',
      });
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

      // A trade on ANOTHER pair is not a reason to refuse: pairs run their own
      // cycles now. Only a trade on this one would be a second position.
      if (stateRef.current.openTrades[argsRef.current.chartSymbol] !== undefined) return 'none';
      if (stateRef.current.candles.length === 0) return 'none';

      const signal = forcedSignal(selectedMinutes, true);

      announceSignal(signal);
      recordOpen(signal);
      setState((s) => ({
        ...s,
        openTrades: { ...s.openTrades, [argsRef.current.chartSymbol]: signal },
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

  /**
   * The trade the screen is about: the one on the pair being shown.
   *
   * Derived rather than stored, so it cannot drift from `openTrades`. The other
   * trades carry on in the background — they are on `openTrades`, which is what
   * the bar offering a way back to them reads.
   */
  const onChart = state.openTrades[args.chartSymbol] ?? null;

  return {
    ...state,
    activeSignal: onChart,
    secondsRemaining:
      onChart === null ? 0 : Math.max(0, Math.ceil((onChart.expiryTime - Date.now()) / 1000)),
    /** The program driving this session, or null when the rules are. */
    program,
    requestSignal,
    fireMonitoringSignal,
    clearSignal,
    clearMarketClosed,
    setLivePriceGetter,
  };
}
