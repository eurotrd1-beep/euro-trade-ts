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
import { nextCandleWindow } from './tradeWindow';
import {
  fetchRemoteHistory,
  loadHistory,
  mergeHistories,
  pushRemoteHistory,
  resolveOpenTrades,
  saveHistory,
} from './signalHistoryStore';
import { notify,
  notifyStage,
  resetLadders,
} from './signalNotify';
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

/**
 * How much of the current candle has gone, 0 to 1.
 *
 * Read from the clock rather than from the candle buffer, because it has to be
 * right between polls: the buffer updates every few seconds and this is what
 * makes a reading move in the seconds between.
 */
function candleLeft(timeframe: string): number {
  const cs = timeframeSeconds(timeframe);
  const now = Date.now() / 1000;
  return 1 - (now % cs) / cs;
}

/** Prices at the precision the pair is quoted to — three decimals for yen. */
function formatLevel(price: number): string {
  return price.toFixed(price >= 50 ? 3 : 5);
}

/**
 * The sound a placed trade makes. It no longer raises a notification.
 *
 * It used to raise two: "إشارة جديدة" for a primary and "مضاعفة" for a
 * recovery. Both are now duplicates — the ladder in `signalNotify` sends the
 * 100 rung the moment the program returns a signal, which is the same instant
 * this runs, so a user was getting two messages about one event and the pushed
 * one made three.
 *
 * The martingale message went with them rather than being kept as a fourth
 * kind. The proxy has never pushed one either: `push-alerts.js` only climbs
 * for a primary, and a recovery trade opening is the same opportunity
 * continuing, not a new one.
 *
 * The sounds stay. They are instant, they cost nothing, and they are the part
 * that was never repeating.
 */
function announceSignal(signal: TradingSignal): void {
  if (signal.origin === 'monitoring') {
    if (signal.direction === 'CALL') playCallSound();
    else playPutSound();
  } else {
    playNewSignalSound();
  }
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

  // ── One writer for the history ────────────────────────────────────────────
  //
  // A losing trade that owes a martingale is settled and the martingale is
  // opened in the SAME synchronous block: `applyEvent` calls `settleTo` and
  // then `recordOpen`, one after the other, on one candle close. Both used to
  // build their new list the same way:
  //
  //     mergeHistories([row], stateRef.current.history)
  //
  // `stateRef` is assigned during render, and React has not rendered between
  // those two calls — so the second one read the list from BEFORE the first
  // one. It merged the martingale into a list that still held the losing trade
  // as ACTIVE, and then wrote that over the settled version. The loss stayed
  // marked "running" for ever: on screen, in localStorage, and in the copy
  // pushed to the server. The martingale closing did not fix it, because
  // nothing ever looked at the first trade again.
  //
  // So the list has one owner now. `historyRef` is updated SYNCHRONOUSLY on
  // every write, which is what makes two writes in one tick compose instead of
  // race, and the React state follows it.
  const historyRef = useRef<readonly TradingSignal[]>([]);

  // The durable push is coalesced to once per tick. Two pushes racing is the
  // lost-update `pushRemoteHistory` warns about — it reads, merges and writes,
  // so two in flight together can each miss what the other is saving.
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistHistory = useCallback((rows: readonly TradingSignal[], push: boolean) => {
    historyRef.current = rows;
    setState((s) => ({ ...s, history: rows as TradingSignal[] }));

    const id = argsRef.current.accountId;
    if (!id) return;
    saveHistory(id, rows);
    if (!push) return;

    if (pushTimerRef.current !== null) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      pushTimerRef.current = null;
      const account = argsRef.current.accountId;
      // `historyRef`, not the captured array: whatever else was written in the
      // meantime belongs in the same push.
      if (account) void pushRemoteHistory(account, historyRef.current);
    }, 0);
  }, []);

  /** Folds rows into the list and saves it. The only way a trade is recorded. */
  const commitHistory = useCallback(
    (rows: readonly TradingSignal[]) => {
      persistHistory(mergeHistories(rows, historyRef.current), true);
    },
    [persistHistory],
  );

  useEffect(
    () => () => {
      if (pushTimerRef.current !== null) clearTimeout(pushTimerRef.current);
    },
    [],
  );

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

    // Both loads go through `persistHistory` so `historyRef` — which every
    // write composes on top of — is never behind what is on screen.
    const cached = loadHistory(id);
    if (cached.length > 0) {
      persistHistory(
        resolveOpenTrades(
          cached,
          args.pair,
          stateRef.current.openTrades[argsRef.current.chartSymbol] ?? null,
        ),
        false,
      );
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
        mergeHistories(historyRef.current, remote),
        argsRef.current.pair,
        stateRef.current.openTrades[argsRef.current.chartSymbol] ?? null,
      );

      // Only write back when this device is actually carrying something the
      // server has not seen, or when an abandoned trade was just marked. Left
      // unguarded, opening the app would be a write.
      persistHistory(merged, merged.length !== remote.length || differs(merged, remote));
    })();

    return () => { cancelled = true; };
  }, [args.accountId, args.pair, persistHistory]);

  // ── Resume a trade that was still running ─────────────────────────────────
  // The stored list can carry an ACTIVE trade whose expiry has NOT passed —
  // the app was closed, or reloaded, mid-trade. Putting it back into
  // `openTrades` hands it to `reconcileOpenTrade`, which settles it from its
  // own candle exactly as if it had never been interrupted.
  //
  // Restored for every pair, not just the chart's. That is safe because
  // settlement reads the trade's candle rather than whatever price the chart
  // happens to be showing, and the off-chart sweep below fetches those candles.
  useEffect(() => {
    if (state.history.length === 0) return;

    // EVERY trade still inside its window, not the first one found.
    //
    // Pairs run their own cycles, so a reload can land with several running.
    // Restoring one and stopping left the others with a live cycle in the
    // program and no card anywhere: the watch card showed them as "the trade
    // enters next candle" while listing them under conditions still forming,
    // and they only appeared as trades once the user happened to open them.
    const now = Date.now();
    const resumable = state.history.filter(
      (h) =>
        h.status === 'ACTIVE' &&
        h.expiryTime > now &&
        h.symbol !== undefined &&
        state.openTrades[h.symbol] === undefined,
    );
    if (resumable.length === 0) return;

    setState((st) => {
      const open = { ...st.openTrades };
      for (const t of resumable) if (t.symbol !== undefined) open[t.symbol] = t;
      return { ...st, openTrades: open };
    });

    // The chart follows the one finishing soonest — it is the one whose result
    // arrives first, and a chart has to show one pair.
    const soonest = [...resumable].sort((x, y) => x.expiryTime - y.expiryTime)[0];
    if (soonest?.symbol !== undefined && soonest.symbol !== args.chartSymbol) {
      argsRef.current.onPairSwitch?.(soonest.symbol);
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
  /**
   * The last price seen for each symbol.
   *
   * Kept so the readings can be recomputed between polls. The prices arrive
   * every four seconds; the part of the reading that depends on the CLOCK — how
   * much of the candle is left once price is on the level — changes every
   * second, and holding the last price is what lets that be shown without
   * asking the server again.
   */
  const lastPricesRef = useRef<Record<string, number>>({});
  /**
   * Pairs whose level has been touched during the candle now running.
   *
   * Keyed by symbol, holding the setup and the candle it happened on. Both are
   * needed: the flag has to clear when a new candle starts, and it has to clear
   * again if the setup is replaced, or a touch on one level would keep vouching
   * for the next.
   *
   * It exists because the touch is the last condition and cannot be un-done —
   * `touches` reads the candle's high and low, so once price has reached the
   * level the candle will report it whatever price does afterwards. Recomputing
   * from the current price would show the setup drifting away from a level it
   * has already met, and take back a trade that is already owed.
   */
  const touchedRef = useRef(new Map<string, { key: string; candle: number; hit: boolean }>());
  /**
   * The range price has covered during the candle now running, per pair.
   *
   * Built from every price observed, because a touch is CONTAINMENT — the
   * strategy asks whether the level lies inside the candle's high and low, not
   * whether price is currently past it. Measured over recorded candles, the
   * one-sided test was right 6.4% of the time: price that had broken clean
   * through the level and kept going satisfied it, and that is the opposite of
   * a touch. Containment was right 87.6%.
   *
   * Assembled from polled prices, so it can only ever be NARROWER than the real
   * candle — a touch between two polls is missed. That is the safe direction to
   * be wrong in: the reading stays just under 100 and the trade then appears,
   * which is a surprise rather than a broken promise.
   */
  const rangeRef = useRef(new Map<string, { candle: number; high: number; low: number }>());

  /**
   * When the candle now running started, per pair, taken from the FEED.
   *
   * Not from the device clock, and that distinction is the whole point. The
   * range that decides a touch is accumulated within one candle and reset at
   * its boundary, and the strategy will judge the touch against the feed's
   * candle. A clock a few seconds fast puts prices from the end of one candle
   * into the start of the next, so the range spans two candles and reports
   * containment the real candle never had — a touch that shows 100% and then
   * produces no trade, which is exactly what was happening.
   *
   * The feed's newest candle IS the one now forming, so its timestamp is the
   * boundary, whatever the device believes the time is.
   */
  const candleStartRef = useRef(new Map<string, number>());

  const currentCandleStart = useCallback((symbol: string): number => {
    const known = candleStartRef.current.get(symbol);
    if (known !== undefined) return known;
    // Only before the first sweep has been seen for this pair.
    const cs = timeframeSeconds(argsRef.current.timeframe) * 1000;
    return Math.floor(Date.now() / cs) * cs;
  }, []);

  /**
   * Records a touch the moment price reaches the level, and reports whether
   * this pair's current candle has one.
   */
  const touchedNow = useCallback(
    (
      symbol: string,
      armed: { key: string; level: number; endPrice: number; direction: Direction } | null,
      price: number,
    ): boolean => {
      if (armed === null || !(price > 0)) {
        touchedRef.current.delete(symbol);
        rangeRef.current.delete(symbol);
        return false;
      }

      const candle = currentCandleStart(symbol);

      // The range so far, restarted on a new candle.
      const seen = rangeRef.current.get(symbol);
      const range =
        seen !== undefined && seen.candle === candle
          ? { candle, high: Math.max(seen.high, price), low: Math.min(seen.low, price) }
          : { candle, high: price, low: price };
      rangeRef.current.set(symbol, range);

      const held = touchedRef.current.get(symbol);
      const fresh = held === undefined || held.key !== armed.key || held.candle !== candle;
      if (!fresh && held.hit) return true;

      // ── The strategy's own two tests, on the live range ──────────────────
      //
      // Broken first, exactly as the strategy does: a setup whose leg end price
      // has been passed is retired BEFORE the touch is considered, so a level
      // inside the range of a candle that also broke the leg produces nothing.
      // Checking it here is what stopped this claim being wrong one time in
      // eight.
      const broken =
        armed.direction === 'CALL' ? range.high > armed.endPrice : range.low < armed.endPrice;
      if (broken) {
        touchedRef.current.set(symbol, { key: armed.key, candle, hit: false });
        return false;
      }

      // And then containment: the level has to lie INSIDE the range price has
      // covered. Being past it is not touching it.
      const hit = range.low <= armed.level && armed.level <= range.high;
      touchedRef.current.set(symbol, { key: armed.key, candle, hit });
      return hit;
    },
    [currentCandleStart],
  );

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
    // The notification ladder is cleared too: a different account or timeframe
    // is a different set of opportunities, and one carried over would suppress
    // the first real alert on the new one.
    resetLadders();
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

      commitHistory([settled]);
      setState((s) => {
        // The settled trade leaves the open set. Its result is in the history,
        // which is where a finished trade belongs; leaving it here would keep a
        // countdown on screen for something that has already happened.
        const open = { ...s.openTrades };
        if (settled.symbol !== undefined) delete open[settled.symbol];
        return { ...s, openTrades: open };
      });
    },
    [commitHistory],
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
      commitHistory([stale]);
      setState((s) => {
        const open = { ...s.openTrades };
        delete open[symbol];
        return { ...s, openTrades: open };
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

    // ── Settle only once the candle is actually FINISHED ──────────────────
    //
    // This used to ask the clock: `Date.now() >= open.expiryTime`. The clock
    // says the minute is over; it says nothing about whether the feed has
    // finished building that minute's candle. At the instant the countdown
    // hits zero the buffer still holds the trade's candle mid-flight, and its
    // `close` is simply the last tick — so the trade was being judged on a
    // price from the middle of its own candle.
    //
    // Measured on AUD/NZD OTC at 16:24 UTC on 2026-08-19: the candle opened at
    // 1.17391, ran up to 1.17470 and closed at 1.17230. A PUT taken at the open
    // WON. The card settled it against 1.17420 — a price from partway up that
    // run — and recorded a LOSS, then showed the user a close that no candle
    // ever had. The generator, reading the finished candle, recorded the win.
    // Same trade, two verdicts, and the wrong one was the one on screen.
    //
    // A candle is finished when a LATER one exists. That is the feed's own
    // statement that it has moved on, and it is the same discipline
    // `lastClosedIndex` applies inside the engine — never read the bar that is
    // still being written.
    const finished = candles.some((c) => c.time > open.entryTime);
    if (!finished) {
      // Not stuck: the next candle is seconds away. But if it never comes the
      // card must not spin for ever, and settling on a half-built close is
      // exactly what this is here to stop — so it ends as unresolved instead.
      if (Date.now() < open.expiryTime + STRANDED_AFTER_MS) return;
      const stale: TradingSignal = {
        ...open,
        status: 'UNRESOLVED',
        exitPrice: null,
        candlesSnapshot: stateRef.current.candles.slice(),
      };
      commitHistory([stale]);
      setState((s) => {
        const rest = { ...s.openTrades };
        delete rest[symbol];
        return { ...s, openTrades: rest };
      });
      return;
    }

    // ── The forced account's close has to agree with its verdict ──────────
    //
    // This used to stamp WIN on the candle's real close, which on a losing
    // candle put a self-contradicting card on screen: a CALL entered at
    // 1.17391, closed at 1.17230, marked WIN. `guaranteedWinExit` exists for
    // exactly this and was imported here and never called. It keeps the real
    // close whenever the real close already wins — so most cards show the true
    // number — and only when it does not does it move the close a fraction to
    // the winning side.
    if (argsRef.current.guaranteedWin) {
      settleTo(open, 'WIN', bar.open, guaranteedWinExit(open.direction, bar.open, bar.close));
      return;
    }
    settleTo(open, outcomeFor(open.direction, bar.open, bar.close), bar.open, bar.close);
  }, [settleTo, commitHistory]);

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
  const recordOpen = useCallback(
    (signal: TradingSignal) => {
      commitHistory([signal]);
    },
    [commitHistory],
  );

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

      // A newly adopted setup used to be announced here. It sits halfway up
      // the scale — the swing is found, and price may be most of a leg away
      // and may never come back — and since ‹A10› and ‹A11› most of them come
      // to nothing at all. The ladder in `signalNotify` starts at 96 instead;
      // everything below that is the card's job.
      const armedNow = progState.armed;
      if (armedNow === null && armedBefore !== null) {
        notifyStage({ symbol, name: displayNameFor(symbol), setupKey: null, percent: 0 });
      }

      // 100. Tied to the program RETURNING a signal — a closed candle that
      // satisfied every rule — and to nothing else. The identity comes from
      // `armedBefore` because firing has already cleared `progState.armed`.
      if (event.signal !== null && event.signal.stage === 'primary' && armedBefore !== null) {
        notifyStage({
          symbol,
          name: displayNameFor(symbol),
          setupKey: armedBefore,
          percent: 100,
          fired: true,
        });
      }

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
            : // `historyRef`, not the render's copy: a settlement earlier in
              // this same tick has already been folded in there and would not
              // be visible in state until React renders.
              (historyRef.current.find(
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
      // The feed's newest candle is the one now forming: its timestamp is the
      // boundary the strategy will use, so it is the one the range resets on.
      candleStartRef.current.set(symbol, candles[candles.length - 1]!.time);
      const held = programStatesRef.current.get(symbol);
      if (held === undefined) continue;
      const close = candles[candles.length - 1]!.close;
      percents[symbol] = setupProgress(
        held,
        diagnosticsRef.current.get(symbol) ?? null,
        close,
        candleLeft(argsRef.current.timeframe),
        touchedNow(symbol, held.armed, close),
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
    // ── Every pair, every sweep. No stopping at the first one ──────────────
    //
    // This used to return the moment a pair produced anything, leaving every
    // pair after it in the order un-ticked for that candle. That was right when
    // only one trade could exist: once one had opened, the rest were not
    // allowed to anyway.
    //
    // They are now. So stopping there meant a pair that touched its level on
    // the same candle as another simply never had that candle read — the card
    // said the trade was coming, the candle passed, and nothing happened,
    // because the strategy was never shown the candle that would have fired it.
    let outcome: TickResult = 'none';
    for (const symbol of ordered) {
      const candles = bulk.get(symbol);
      if (candles === undefined || candles.length === 0) continue;

      read++;
      const result = applyEvent(symbol, prog, candles, stateFor(symbol));
      // A signal outranks a cycle ending: it is the thing the caller acts on.
      if (result === 'signal' || (result === 'cycle_end' && outcome === 'none')) {
        outcome = result;
      }
    }
    if (read > 0) setState((st) => ({ ...st, candlesAnalysed: st.candlesAnalysed + read }));

    // Which pair to follow is a question about all of them at once, so it is
    // asked after the loop rather than inside it.
    rankWatched(bulk);
    return outcome;
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

      // ── The bars move with the price, not with the candle ────────────────
      //
      // `/api/otc/status` carries a price for every symbol, so the readings can
      // be refreshed on this poll rather than waiting for the next candle to
      // close. That is the difference between a bar that steps once a minute
      // and one the user can watch approaching — and it is the same
      // `setupProgress`, on a fresher price, so nothing can disagree.
      lastPricesRef.current = { ...lastPricesRef.current, ...status.prices };
      const fresh: Record<string, SetupProgress> = { ...stateRef.current.completions };
      let moved = false;
      for (const [symbol, st] of programStatesRef.current) {
        const price = status.prices[symbol];
        if (typeof price === 'number' && price > 0) {
          fresh[symbol] = setupProgress(
          st,
          diagnosticsRef.current.get(symbol) ?? null,
          price,
          candleLeft(argsRef.current.timeframe),
          touchedNow(symbol, st.armed, price),
        );
          moved = true;
        }

        const armed = st.armed;
        if (armed === null || st.cycle !== null) continue;
        if (typeof price !== 'number' || price <= 0) continue;

        // The leg's size, recovered from the level: the level sits 23.6% of
        // the way back from the end, so the distance to it IS 23.6% of the leg.
        const range = Math.abs(armed.level - armed.endPrice) / 0.236;
        const distance = Math.abs(price - armed.level);

        // Reached: the retracement approaches from the side the leg ran, so
        // an up-swing's level is met from above and a down-swing's from below.
        const reached = armed.direction === 'CALL' ? price <= armed.level : price >= armed.level;
        if (!reached) continue;

        // What used to be here: a message the moment price REACHED the level,
        // saying the trade would open on the next candle. ‹A10› and ‹A11›
        // ended that — reaching the level is not a promise any more, the
        // candle has to close past it and three basis points beyond, and most
        // do not. The message kept arriving and was wrong more often than
        // right.
        //
        // Nothing replaces it here. The ladder is driven from the reading the
        // card shows, in the one-second recompute below, so one place decides
        // what a user is told and one number is behind it.
      }

      if (moved) setState((st) => ({ ...st, completions: fresh }));
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

  // ── Every open trade, not just the one on screen ──────────────────────────
  //
  // The feed above reconciles ONE pair: the one the chart is showing. With a
  // program running that is enough by accident — the watch sweeps every watched
  // pair each candle and `applyEvent` reconciles each of them on the way past.
  //
  // A forced account has no program. `tickProgram` never runs, so that sweep
  // never happens, and the feed above is the only thing that ever looks at an
  // open trade. Switch the chart to another pair while a forced trade is open
  // and nothing looks at it again — not after its expiry, not after the
  // stranded timeout, never. It stays ACTIVE for the life of the session, and
  // because the "already trading" guard only checks the CURRENT pair, the watch
  // opens another one on the new chart and strands that too.
  //
  // This closes the hole for both paths at once, which matters beyond the
  // forced account: a program user who unwatches a pair mid-trade takes it out
  // of the sweep and lands in the same place.
  const openSymbols = Object.keys(state.openTrades).sort().join(',');
  useEffect(() => {
    if (args.priceSystem === 'simulator') return;
    const strays = openSymbols.split(',').filter((s) => s !== '' && s !== args.chartSymbol);
    if (strays.length === 0) return;

    let cancelled = false;
    async function sweep(): Promise<void> {
      // One request for all of them. These pairs are off-screen, so nothing
      // here touches `state.candles` — the buffer belongs to the chart.
      const bulk = await fetchCandlesBulk(strays, args.timeframe);
      if (cancelled) return;
      // Every stray, including the ones the request had nothing for. An empty
      // array is not a reason to skip: the stranded-trade timeout lives inside
      // `reconcileOpenTrade`, so a pair the proxy has no history for would
      // never time out either if it were passed over here.
      for (const symbol of strays) reconcileOpenTrade(symbol, bulk.get(symbol) ?? []);
    }

    void sweep();
    const id = setInterval(() => void sweep(), CANDLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [openSymbols, args.chartSymbol, args.timeframe, args.priceSystem, reconcileOpenTrade]);

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
  const watching = args.watching;
  useEffect(() => {
    if (!anyOpen && !watching) return;
    const id = setInterval(() => {
      forceTick((n) => n + 1);

      // Recomputed every second, not every poll.
      //
      // Prices arrive every four seconds, but the reading is not only about
      // price: once a pair is ON its level what remains is the candle, and that
      // drains continuously. Recomputing here — from the last known prices and
      // a fresh clock — is what makes the bar move second by second instead of
      // stepping four times a minute. It is the same `setupProgress`, so the
      // number cannot diverge from the one the poll produces; it is simply
      // asked more often. Measured cost for all 89 pairs: 0.2ms.
      if (programRef.current === null) return;
      const next: Record<string, SetupProgress> = {};
      let any = false;
      for (const [symbol, st] of programStatesRef.current) {
        // The pair on screen has a WebSocket price, which is genuinely live;
        // the rest have the last poll. Using the better one where it exists
        // means the chart's own bar tracks the tick the user is watching.
        const live =
          symbol === argsRef.current.chartSymbol ? (livePriceRef.current?.() ?? 0) : 0;
        const price = live > 0 ? live : lastPricesRef.current[symbol];
        if (typeof price !== 'number' || price <= 0) continue;
        const p = setupProgress(
          st,
          diagnosticsRef.current.get(symbol) ?? null,
          price,
          candleLeft(argsRef.current.timeframe),
          touchedNow(symbol, st.armed, price),
        );
        next[symbol] = p;
        any = true;

        // 96 and 98, from exactly the number the row is showing. Driven from
        // here rather than from the poll because the reading moves with the
        // clock as well as the price — a pair can cross 96 without a tick
        // arriving, and the ladder should not have to wait four seconds to
        // notice. `notifyStage` is idempotent per rung per setup, so being
        // called every second costs nothing.
        notifyStage({
          symbol,
          name: displayNameFor(symbol),
          setupKey: st.armed?.key ?? null,
          percent: p.percent,
        });
      }
      if (any) setState((st) => ({ ...st, completions: next }));
    }, 1000);
    return () => clearInterval(id);
  }, [anyOpen, watching]);


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
   *
   * ── IT RUNS ON A CANDLE, LIKE EVERY OTHER TRADE ───────────────────────────
   *
   * The timing used to come from `alignExpiry`, which snaps to a ONE-MINUTE
   * grid whatever the chart is on. Settlement finds a trade's candle by exact
   * time — `candles.find(c => c.time === entryTime)` — and on a 5m chart the
   * feed's candles are on five-minute boundaries, so a minute-aligned entry
   * matched nothing four times out of five. No candle meant no settlement, and
   * the card ran on past its own countdown until the stranded-trade timeout
   * closed it as UNRESOLVED — the one account that is supposed to win every
   * trade getting no result at all.
   *
   * So the window comes from the timeframe now, and the trade is the NEXT
   * candle: the same shape as a program signal, which fires on a close and
   * trades the candle after it. `durationMinutes` is derived from the same
   * number rather than passed in, because one candle IS one trade and two
   * sources for that could disagree.
   */
  const forcedSignal = useCallback((forMonitoring = false): TradingSignal => {
    const { currentPrice } = stateRef.current;
    const a = argsRef.current;
    const candleMs = timeframeSeconds(a.timeframe) * 1000;
    const window = nextCandleWindow(Date.now(), candleMs);
    const live = livePriceRef.current?.() ?? 0;
    const entry = live > 0 ? live : currentPrice;

    return {
      pair: a.pair,
      symbol: a.chartSymbol,
      direction: (Math.random() < 0.5 ? 'CALL' : 'PUT') as Direction,
      durationMinutes: candleMs / 60_000,
      // Provisional, exactly as it is for a program signal: the candle this
      // trade runs on does not exist yet, so the last price stands in until
      // `reconcileOpenTrade` replaces it with that candle's open.
      entryPrice: entry,
      currentPrice: entry,
      // The band a scored signal used to land in, so the card is
      // indistinguishable from a real one.
      confidence: 92.5 + Math.random() * (98.9 - 92.5),
      entryTime: window.entryTime,
      expiryTime: window.expiryTime,
      status: 'ACTIVE',
      exitPrice: null,
      candlesSnapshot: null,
      marketCondition: '',
      recommendation: '',
      origin: forMonitoring ? 'monitoring' : 'instant',
    };
  }, []);

  /**
   * The button. Runs the full sequence and says what it came to.
   *
   * It answers on the first candle only. When that candle does not match the
   * strategy it returns `no_match` and stops there — carrying on to the next
   * candle is the caller's job, because the counter and the watching panel
   * belong to `useMonitoring`, not here.
   */
  const requestSignal = useCallback(
    async (): Promise<RequestOutcome> => {
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
        signal = forcedSignal();
      } catch {
        // Scoring threw — fall back to a direction from the last two candles,
        // exactly as Dart does rather than leaving the user with nothing.
        const c = stateRef.current.candles;
        const isCall = c.length >= 2 ? c[c.length - 1]!.close >= c[c.length - 2]!.close : true;
        // The same candle window as above. A fallback that lands off the grid
        // would be unsettleable in precisely the way this whole path was.
        const candleMs = timeframeSeconds(argsRef.current.timeframe) * 1000;
        const window = nextCandleWindow(Date.now(), candleMs);
        const entry = livePriceRef.current?.() || stateRef.current.currentPrice;

        signal = {
          pair: argsRef.current.pair,
          symbol: argsRef.current.chartSymbol,
          direction: (isCall ? 'CALL' : 'PUT') as Direction,
          durationMinutes: candleMs / 60_000,
          entryPrice: entry,
          currentPrice: entry,
          confidence: 75.0,
          entryTime: window.entryTime,
          expiryTime: window.expiryTime,
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
    async (): Promise<TickResult> => {
      if (analysingRef.current) return 'none';

      if (programRef.current !== null) return tickProgram();

      // A trade on ANOTHER pair is not a reason to refuse: pairs run their own
      // cycles now. Only a trade on this one would be a second position.
      if (stateRef.current.openTrades[argsRef.current.chartSymbol] !== undefined) return 'none';
      if (stateRef.current.candles.length === 0) return 'none';

      const signal = forcedSignal(true);

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
