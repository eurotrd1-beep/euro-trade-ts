'use client';

/**
 * Main trading screen — ported from lib/screens/main_screen.dart.
 *
 * Layout follows the original: the account card, the asset selector, the
 * chart, then ONE panel holding both the instant-signal and smart-monitoring
 * buttons stacked, then the live win feed and the signal history.
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
  const [timeframe, setTimeframe] = useState<string>('1m');
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

  const strategyJson = isVip ? config.strategyVip : config.strategyStandard;

  // The instant button takes over from monitoring, as requestNextSignal does.
  // A ref breaks the circular dependency between the two hooks.
  const stopMonitoringRef = useRef<(() => void) | null>(null);
  const takeOverMonitoring = useCallback(() => stopMonitoringRef.current?.(), []);

  const engine = useSignalEngine({
    chartSymbol,
    timeframe,
    priceSystem: effectivePriceSystem,
    role: isVip ? 'vip' : 'standard',
    guaranteedWin: user.guaranteedWin,
    strategyJson,
    pair: activePair,
    onTakeOverMonitoring: takeOverMonitoring,
  });

  const marketClosed = !market.open || engine.marketClosed;

  const monitoring = useMonitoring({
    timeframeSeconds: timeframeSeconds(timeframe),
    marketClosed,
    // Monitoring already waited for the candle close, so it fires directly
    // instead of re-running the analysis sequence.
    evaluate: () => engine.fireMonitoringSignal(selectedMinutes),
    signalPending: engine.activeSignal !== null,
  });

  stopMonitoringRef.current = monitoring.stop;

  const socialPairs = useMemo(() => visiblePairs.map((p) => p.symbol), [visiblePairs]);
  const socialLogs = useSocialFeed({ pairs: socialPairs, marketClosed });

  if (!accountId) return <main className={styles.screen} />;

  return (
    <main className={styles.screen}>
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
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setTimeframe(tf)}
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
            selectedMinutes={selectedMinutes}
            onSelectMinutes={setSelectedMinutes}
            onRequest={() => void engine.requestSignal(selectedMinutes)}
            onClear={engine.clearSignal}
            hasCandles={engine.candles.length > 0}
            monitoring={monitoring}
            onStartMonitoring={monitoring.start}
            onStopMonitoring={monitoring.stop}
          />

          <LiveFeed logs={socialLogs} />

          <SignalHistory history={engine.history} />
        </aside>
      </div>
    </main>
  );
}
