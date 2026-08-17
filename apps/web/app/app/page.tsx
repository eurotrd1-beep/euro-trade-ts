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
import { programForPlan } from '@euro/engine';
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
import styles from './app.module.css';

const TIMEFRAMES = ['1m', '5m', '15m', '1h'] as const;

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
  const planProgram = useMemo(() => programForPlan(isVip ? 'paid' : 'free'), [isVip]);
  const program = planProgram;
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
  const effectivePriceSystem =
    config.priceSystem ?? (config.chartMode === 'sim' ? 'simulator' : 'scraping');

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
   * The pairs the watch sweeps: everything on offer, minus what the feed says
   * is closed. A closed market cannot produce a candle, so scanning it is a
   * wasted slot in the sweep.
   */
  const watchSymbols = useMemo(
    () =>
      visiblePairs
        .map((p) => p.chart_symbol)
        .filter((sym) => sym && market.closedPairs[sym] !== true),
    [visiblePairs, market.closedPairs],
  );

  /**
   * The chart follows the signal.
   *
   * Switching by chart symbol rather than by display name, because that is
   * what the engine reports and what the feed is keyed by — matching on the
   * pretty name would fail on the first pair whose two names differ.
   */
  const switchToPair = useCallback(
    (chartSymbol: string) => {
      const match = visiblePairs.find((p) => p.chart_symbol === chartSymbol);
      if (match !== undefined) setActivePair(match.symbol);
    },
    [visiblePairs],
  );

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
    programId: planProgram.id,
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
    evaluate: () => engine.fireMonitoringSignal(selectedMinutes),
  });

  stopMonitoringRef.current = monitoring.stop;

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

    const outcome = await engine.requestSignal(selectedMinutes);
    if (outcome !== 'unavailable') monitoring.start();
  }, [engine, monitoring, selectedMinutes]);

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
            onSelect={setActivePair}
            closedPairs={market.closedPairs}
          />

          {!market.healthy && (
            <div className={styles.reconnecting} role="status">
              {tr('جاري إعادة الاتصال بمزوّد الأسعار...', 'Reconnecting to the price provider…')}
            </div>
          )}

          <div className={styles.chartCard}>
            <div className={styles.chartHead}>
              <span className={styles.pairName}>{activePair}</span>
              <div
                className={styles.timeframes}
                role="group"
                aria-label={tr('الإطار الزمني', 'Timeframe')}
              >
                {program !== null ? (
                  <span className={`${styles.tfBtn} ${styles.tfActive}`}>
                    {program.timeframe}
                  </span>
                ) : (
                  TIMEFRAMES.map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => setChosenTimeframe(tf)}
                      className={`${styles.tfBtn} ${timeframe === tf ? styles.tfActive : ''}`}
                      aria-pressed={timeframe === tf}
                    >
                      {tf}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className={styles.chartBody}>
              <PriceChart
                symbol={chartSymbol}
                interval={timeframe}
                mode={effectiveMode}
                guaranteedWin={user.guaranteedWin}
                signalDirection={
                  engine.activeSignal?.status === 'ACTIVE' ? engine.activeSignal.direction : null
                }
                signalEntryPrice={engine.activeSignal?.entryPrice ?? null}
                signalSecondsRemaining={
                  engine.activeSignal?.status === 'ACTIVE' ? engine.secondsRemaining : 0
                }
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
    </main>
  );
}
