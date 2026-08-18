'use client';

/**
 * Main trading screen — ported from lib/screens/main_screen.dart.
 *
 * Layout follows the original: the account card, the asset selector, the
 * chart, then the signal panel, then the live win feed and the signal history.
 *
 * The panel has ONE button where the original had two. "Instant signal" and
 * "smart monitoring" were the same strategy behind two presses, and the choice
 * between them was really a question about the market that the user cannot
 * answer before pressing: instant gave up if the next candle did not match,
 * monitoring waited but made you decide to wait before knowing you had to.
 *
 * `onRequest` below is where the two halves are joined, because this is the
 * only place that can see both: the engine analyses the current candle, and if
 * it comes back `no_match` the watch takes over with the same strategy on the
 * same duration until a signal fires.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  tr,
  chartSymbolFor,
  DEFAULT_CURRENCY_PAIRS,
  KEY_USER_ACCOUNT_ID,
  KEY_USER_BROKER,
  type PairRow,
} from '@euro/shared';
import { programForPlan, SUPPORTED_TIMEFRAMES } from '@euro/engine';
import { loadSession } from '@/lib/session';
import { useAppConfig, usePairs, useLiveUser } from '@/lib/useAppConfig';
import { useOtcStatus } from '@/lib/useOtcStatus';
import { useSignalEngine } from '@/lib/useSignalEngine';
import { useMonitoring, timeframeSeconds } from '@/lib/useMonitoring';
import { useSocialFeed } from '@/lib/useSocialFeed';
import { PriceChart } from '@/components/PriceChart';
import { AssetSelector } from '@/components/AssetSelector';
import { SignalPanel } from '@/components/SignalPanel';
import { SignalHistory } from '@/components/SignalHistory';
import { LiveFeed } from '@/components/LiveFeed';
import { PromoOverlay } from '@/components/PromoOverlay';
import { requestNotificationPermission } from '@/lib/signalNotify';
import { unlockAudio } from '@/lib/sounds';
import { AccountCard } from '@/components/AccountCard';
import { AppHeader } from '@/components/AppHeader';
import { WatchSettings } from '@/components/WatchSettings';
import { LeaderStrip } from '@/components/LeaderStrip';
import styles from './app.module.css';

/*
 * The timeframes the strategy can actually be run on, from the engine.
 *
 * This list used to be ['1m','5m','15m','1h'], written before programs
 * existed and left behind a picker that had been disabled ever since. Only the
 * timeframes the engine declares a trade length for belong here: a button
 * offering 1h would be offering an hour-long trade nobody defined.
 */
const TIMEFRAMES = SUPPORTED_TIMEFRAMES;

export default function MainScreen() {
  const router = useRouter();
  const config = useAppConfig();
  const livePairs = usePairs();

  const [accountId, setAccountId] = useState<string | null>(null);
  const [broker, setBroker] = useState('');
  const [chosenTimeframe, setChosenTimeframe] = useState<string>('1m');
  const [selectedMinutes, setSelectedMinutes] = useState(1);

  const [activePair, setActivePair] = useState<string>('EUR/USD OTC');

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.replace('/');
      return;
    }
    setAccountId(session.accountId);
    setBroker(session.broker);
  }, [router]);

  const user = useLiveUser(accountId);

  useEffect(() => {
    if (user.isBanned || user.deleted) router.replace('/');
  }, [user.isBanned, user.deleted, router]);

  useEffect(() => {
    if (config.maintenance.isActive) router.replace('/maintenance');
  }, [config.maintenance.isActive, router]);

  /** VIP lapses client-side the moment the timestamp passes. */
  const isVip = useMemo(() => {
    if (user.role !== 'vip') return false;
    if (!user.vipExpiry) return true;
    return user.vipExpiry > new Date();
  }, [user.role, user.vipExpiry]);

  /**
   * The strategy program, and the two things it decides for the user.
   *
   * A strategy written around one-minute candles has no meaningful answer on
   * 15m, and its trades are one candle long by construction. Offering either
   * choice would produce signals nobody could explain — so while a program is
   * running, the timeframe and the trade length are ITS values and the pickers
   * stop being pickers.
   */
  const program = useMemo(
    () => programForPlan(isVip ? 'paid' : 'free', chosenTimeframe),
    [isVip, chosenTimeframe],
  );
  // The program is bound to the chosen timeframe, so this is that choice —
  // read back from the program rather than kept beside it, so the chart, the
  // engine and the trade length can never describe different candles.
  const timeframe = program.timeframe;

  const pairs: PairRow[] = useMemo(() => {
    if (livePairs && livePairs.length > 0) return livePairs.filter((p) => p.enabled);
    return DEFAULT_CURRENCY_PAIRS.map((p, i) => ({
      id: `local-${i}`,
      symbol: p.symbol,
      chart_symbol: p.chartSymbol,
      category: p.category,
      type: p.type,
      order: i,
      created_at: '',
      source: p.source,
      is_otc: p.isOtc,
      enabled: p.enabled,
    }));
  }, [livePairs]);

  const visiblePairs = useMemo(
    () => (config.displaySource === 'po' ? pairs.filter((p) => p.source === 'po') : pairs),
    [pairs, config.displaySource],
  );

  const chartSymbol = useMemo(() => {
    const match = visiblePairs.find((p) => p.symbol === activePair);
    return match?.chart_symbol ?? chartSymbolFor(activePair);
  }, [visiblePairs, activePair]);

  const market = useOtcStatus(chartSymbol, config.priceSystem !== 'simulator');

  // main_screen.dart:2717
  //
  // The simulator is opt-in, and only ever from a value that actually arrived.
  // This used to read `priceSystem ?? (chartMode === 'sim' ? …)`, and both of
  // those start unset — so between mount and the first config reply the app
  // resolved to 'simulator', switched the chart to synthetic candles and told
  // `useSignalEngine` to skip the real feed entirely. On a slow connection
  // that window is seconds, on every open, with the database saying
  // 'scraping' the whole time. Now nothing selects the simulator until the
  // rows are in and one of them says so.
  const effectivePriceSystem = !config.loaded
    ? 'scraping'
    : (config.priceSystem ?? (config.chartMode === 'sim' ? 'simulator' : 'scraping'));

  // main_screen.dart:4537
  const activePairData = visiblePairs.find((p) => p.symbol === activePair);
  const isPo = (activePairData?.source ?? 'po') === 'po';
  const effectiveMode = effectivePriceSystem === 'simulator' ? 'sim' : isPo ? 'otc' : 'sim';

  // Pressing the button while a watch is running restarts the analysis, so the
  // old watch is stopped first. A ref breaks the circular dependency between
  // the two hooks.
  const stopMonitoringRef = useRef<(() => void) | null>(null);
  const takeOverMonitoring = useCallback(() => stopMonitoringRef.current?.(), []);

  /**
   * The pairs the user chose, minus what the feed says is closed.
   *
   * It used to be every pair the catalogue offered. Now it is the selection
   * from ⚙️ settings — the same list the notification subscription uses, so
   * "which pairs am I following" has exactly one answer.
   *
   * Held in state rather than derived, because the source is `localStorage` and
   * reading it during render would make the first paint disagree with the
   * server-rendered markup. `WatchSettings` reports it on mount and on every
   * change, including the migration of the old notifications-only list.
   *
   * A closed market cannot produce a candle, so scanning it is a wasted slot —
   * but it stays in the user's SELECTION, because a market being shut for the
   * weekend is not them changing their mind.
   */
  const [watchedPairs, setWatchedPairs] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const watchSymbols = useMemo(
    () => watchedPairs.filter((sym) => sym && market.closedPairs[sym] !== true),
    [watchedPairs, market.closedPairs],
  );

  /**
   * The chart follows the signal.
   *
   * Switching by chart symbol rather than by display name, because that is
   * what the engine reports and what the feed is keyed by — matching on the
   * pretty name would fail on the first pair whose two names differ.
   */
  /**
   * A pair the user chose themselves.
   *
   * Distinct from `switchToPair`, which is the app moving the chart on its
   * own. Only this one stops the automatic follow — the difference between
   * "the app decided" and "I decided" is exactly what the pause is for, and
   * routing both through one function would make every automatic switch look
   * like a manual one and freeze the follow after the first move.
   */
  const pauseFollowRef = useRef<((paused: boolean) => void) | null>(null);

  const pickPairByHand = useCallback(
    (symbol: string) => {
      setActivePair(symbol);
      pauseFollowRef.current?.(true);
    },
    [],
  );

  const switchToPair = useCallback(
    (chartSymbol: string) => {
      const match = visiblePairs.find((p) => p.chart_symbol === chartSymbol);
      if (match !== undefined) setActivePair(match.symbol);
    },
    [visiblePairs],
  );

  /**
   * Opens the chart the notification was about.
   *
   * Two ways in, because a tap lands in one of two states. A cold start opens
   * `?pair=…` and this reads it once; a tab that was already open gets a
   * message from the service worker instead, since focusing it is better than
   * launching a second copy of the app with its own watch loop.
   *
   * The symbol arrives in the scraper's form (`EURUSD_otc`) because that is
   * what the generator knows, and `switchToPair` speaks exactly that.
   */
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('pair');
    if (requested) {
      switchToPair(requested);
      // Taken out of the address bar so a refresh does not drag the user back
      // to a pair they have since navigated away from.
      const url = new URL(window.location.href);
      url.searchParams.delete('pair');
      window.history.replaceState({}, '', url.toString());
    }

    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; symbol?: string } | null;
      if (data?.type === 'open-pair' && data.symbol) switchToPair(data.symbol);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [switchToPair]);


  /**
   * The watch's `active`, mirrored into state.
   *
   * A ref would be simpler and would not work: `useMonitoring` is created
   * AFTER the engine — it needs the engine's tick — so at the moment the
   * engine is built the ref still holds last render's value, and a flag that
   * arrives a render late never starts the effect that watches for it. State
   * costs one extra render and is actually correct.
   */
  const [watching, setWatching] = useState(false);

  const engine = useSignalEngine({
    chartSymbol,
    timeframe,
    priceSystem: effectivePriceSystem,
    role: isVip ? 'vip' : 'standard',
    guaranteedWin: user.guaranteedWin,
    // The plan decides the strategy, and that is the whole of it. Which
    // program each plan runs lives in `programs/index.ts`, so the day the paid
    // plan gets its own, this line does not change.
    programId: program.id,
    // Every pair the user can see, not just the one on screen. A setup on a
    // pair nobody is looking at is worth exactly as much as one on this chart.
    watchSymbols,
    watching,
    onPairSwitch: switchToPair,
    pair: activePair,
    accountId,
    onTakeOverMonitoring: takeOverMonitoring,
  });

  const marketClosed = !market.open || engine.marketClosed;

  const monitoring = useMonitoring({
    timeframeSeconds: timeframeSeconds(timeframe),
    marketClosed,
    // The watch already waited for the candle close, so it hands the candle
    // straight to the strategy instead of replaying the twelve analysis stages.
    // The program's own trade length, not the picker's. One candle is one
    // trade, so on 5m the trade is five minutes — and a forced signal, which
    // is the one path that still reads this number, must expire with the
    // strategy's trades rather than a minute into them.
    evaluate: () => engine.fireMonitoringSignal(program.durationMinutes),
  });

  // A trade is running, or the watch is on and may open one at any candle.
  // Either way the timeframe is committed until it finishes — switching under
  // an open card would leave a one-minute trade waiting for a five-minute
  // close, and the countdown on screen would be measuring nothing.
  const tradeOpen = engine.activeSignal?.status === 'ACTIVE' || monitoring.active;

  /**
   * Whether the open trade belongs to the pair currently on the chart.
   *
   * Compared on the SYMBOL, never the display name: the catalogue calls
   * `XAUUSD_otc` "Gold OTC", so nine pairs — every metal and every crypto —
   * do not match anything derivable from their own symbol, and a name-based
   * check would report "different pair" for a chart showing exactly that pair.
   *
   * The chart used to be handed `activeSignal` unconditionally, so a trade
   * running on gold drew its entry line and its countdown overlay across
   * whatever pair the user had opened — a price from one market laid over the
   * candles of another, at the exact level of detail somebody would act on.
   */
  const tradeOnThisChart =
    engine.activeSignal !== null &&
    engine.activeSignal.status === 'ACTIVE' &&
    (engine.activeSignal.symbol !== undefined
      ? engine.activeSignal.symbol === chartSymbol
      : engine.activeSignal.pair === activePair);

  stopMonitoringRef.current = monitoring.stop;
  pauseFollowRef.current = engine.setFollowPaused;

  useEffect(() => {
    setWatching(monitoring.active);
  }, [monitoring.active]);

  /**
   * The button, both halves of it.
   *
   * The watch starts on a signal as well as on a miss, which looks odd until
   * you follow what a signal now means: the strategy has opened a trade, and
   * that trade still has to be settled on the next candle and may owe a
   * martingale after it. The watch is what carries the cycle to its end, and
   * it stops itself there.
   *
   * `unavailable` is the only outcome that starts nothing — a closed market, a
   * trade already open, an analysis already running. Watching in any of those
   * would leave a counter ticking for something that cannot happen.
   */
  const analyseAndSignal = useCallback(async () => {
    unlockAudio();
    void requestNotificationPermission();

    const outcome = await engine.requestSignal(program.durationMinutes);
    if (outcome !== 'unavailable') monitoring.start();
  }, [engine, monitoring, program.durationMinutes]);

  const socialPairs = useMemo(() => visiblePairs.map((p) => p.symbol), [visiblePairs]);
  const socialLogs = useSocialFeed({ pairs: socialPairs, marketClosed });

  if (!accountId) return <main className={styles.screen} />;

  return (
    <main className={styles.screen}>
      {/* The ad gates itself; it renders nothing unless all four conditions hold. */}
      <PromoOverlay accountId={accountId} telegram={config.social.telegram} />

      <AppHeader
        accountId={accountId}
        broker={broker}
        isVip={isVip}
        vipExpiry={user.vipExpiry}
        telegram={config.social.telegram}
      />

      <div className={styles.layout}>
        <section className={styles.chartColumn}>
          <AccountCard
            accountId={accountId}
            broker={broker}
            isVip={isVip}
            vipExpiry={user.vipExpiry}
          />

          <AssetSelector
            pairs={visiblePairs}
            active={activePair}
            onSelect={pickPairByHand}
            closedPairs={market.closedPairs}
          />

          {!market.healthy && (
            <div className={styles.reconnecting} role="status">
              {tr('جاري إعادة الاتصال بمزوّد الأسعار...', 'Reconnecting to the price provider…')}
            </div>
          )}

          {/*
            Another tab of this account is driving the strategy. Said out loud
            rather than left to look broken: this tab shows live prices and the
            full history, it simply is not the one opening trades — and one tab
            must be, because two of them ticking the same pair open two trades
            for one setup and then overwrite each other's cycle.
          */}
          {!engine.watchOwner && (
            <div className={styles.reconnecting} role="status">
              {tr(
                'المراقبة شغالة في تاب تاني من نفس الحساب. التاب ده بيعرض الأسعار والسجل عادي، بس مش هو اللي بيفتح الصفقات.',
                'Watching is running in another tab of this account. This tab shows live prices and history, but is not the one opening trades.',
              )}
            </div>
          )}

          {/*
            Above the chart, not inside it: it explains why the chart is
            showing what it is showing, which has to be readable before the
            chart is, not after.
          */}
          <LeaderStrip
            leader={engine.leader}
            paused={engine.followPaused}
            tradeOpen={engine.activeSignal?.status === 'ACTIVE'}
            displayName={(sym) => visiblePairs.find((p) => p.chart_symbol === sym)?.symbol ?? sym}
            onResume={() => engine.setFollowPaused(false)}
          />

          <div className={styles.chartCard}>
            <div className={styles.chartHead}>
              <span className={styles.pairName}>{activePair}</span>
              <div
                className={styles.timeframes}
                role="group"
                aria-label={tr('الإطار الزمني', 'Timeframe')}
              >
                {/*
                  A real picker again. It was frozen to a label when strategies
                  became programs, because the program declared its own
                  timeframe and offering a choice the engine would ignore is
                  worse than offering none. The engine now takes the timeframe
                  as an argument — same strategy, same rules, measured on
                  whichever candles are chosen — so the choice means something
                  and is handed straight to it.

                  Disabled mid-trade: the open card counts down in the candles
                  it was placed on, and changing the timeframe under it would
                  leave a one-minute trade waiting for a five-minute close.
                */}
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setChosenTimeframe(tf)}
                    disabled={tradeOpen}
                    title={
                      tradeOpen
                        ? tr('فيه صفقة شغالة دلوقتي', 'A trade is running')
                        : undefined
                    }
                    className={`${styles.tfBtn} ${timeframe === tf ? styles.tfActive : ''}`}
                    aria-pressed={timeframe === tf}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.chartBody}>
              <PriceChart
                symbol={chartSymbol}
                interval={timeframe}
                mode={effectiveMode}
                guaranteedWin={user.guaranteedWin}
                signalDirection={tradeOnThisChart ? engine.activeSignal!.direction : null}
                signalEntryPrice={tradeOnThisChart ? engine.activeSignal!.entryPrice : null}
                signalSecondsRemaining={tradeOnThisChart ? engine.secondsRemaining : 0}
                onReady={engine.setLivePriceGetter}
              />
            </div>
          </div>
        </section>

        <aside className={styles.sideColumn}>
          <SignalPanel
            signal={engine.activeSignal}
            secondsRemaining={engine.secondsRemaining}
            waitNotice={engine.waitNotice}
            analysing={engine.analysing}
            analysisStage={engine.analysisStage}
            candleSecondsLeft={engine.candleSecondsLeft}
            marketClosed={marketClosed}
            pair={activePair}
            timeframe={timeframe}
            watchedCount={watchedPairs.length}
            onOpenSettings={() => setSettingsOpen(true)}
            selectedMinutes={program?.durationMinutes ?? selectedMinutes}
            onSelectMinutes={setSelectedMinutes}
            fixedDuration={program !== null}
            strategyName={program?.name ?? null}
            onRequest={() => void analyseAndSignal()}
            onClear={engine.clearSignal}
            hasCandles={engine.candles.length > 0}
            monitoring={monitoring}
            onStopMonitoring={monitoring.stop}
          />

          <LiveFeed logs={socialLogs} />

          <SignalHistory history={engine.history} />
        </aside>
      </div>

      {/*
        Last in the tree because it is a modal: it belongs to the page rather
        than to the chart column, and nesting a fixed overlay inside a scrolling
        column is how one ends up clipped by its parent on a phone.
      */}
      <WatchSettings
        accountId={accountId}
        plan={isVip ? 'paid' : 'free'}
        pairs={visiblePairs}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChange={setWatchedPairs}
      />
    </main>
  );
}
