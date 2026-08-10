'use client';

/**
 * Main trading screen — ported from lib/screens/main_screen.dart.
 *
 * The Dart screen is one 6,690-line State class holding ~15 subscriptions and
 * ~30 build methods. Here the live data lives in hooks (`useAppConfig`,
 * `usePairs`, `useLiveUser`, `useSignalEngine`) and each section is its own
 * component, so a change to the history list cannot break the chart.
 *
 * Behaviour, thresholds and copy are unchanged.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  tr,
  chartSymbolFor,
  DEFAULT_CURRENCY_PAIRS,
  KEY_USER_ACCOUNT_ID,
  KEY_USER_BROKER,
  type PairRow,
} from '@euro/shared';
import { useAppConfig, usePairs, useLiveUser } from '@/lib/useAppConfig';
import { useOtcStatus } from '@/lib/useOtcStatus';
import { useSignalEngine } from '@/lib/useSignalEngine';
import { useMonitoring, timeframeSeconds } from '@/lib/useMonitoring';
import { PriceChart } from '@/components/PriceChart';
import { AssetSelector } from '@/components/AssetSelector';
import { SignalPanel } from '@/components/SignalPanel';
import { MonitoringPanel } from '@/components/MonitoringPanel';
import { SignalHistory } from '@/components/SignalHistory';
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

  // Session comes from local storage; no session means back to the splash,
  // which re-runs the whole boot decision.
  useEffect(() => {
    try {
      const id = localStorage.getItem(KEY_USER_ACCOUNT_ID);
      if (!id) {
        router.replace('/');
        return;
      }
      setAccountId(id);
      setBroker(localStorage.getItem(KEY_USER_BROKER) ?? '');
    } catch {
      router.replace('/');
    }
  }, [router]);

  const user = useLiveUser(accountId);

  // An admin ban or deletion takes effect while the app is open.
  useEffect(() => {
    if (user.isBanned || user.deleted) router.replace('/');
  }, [user.isBanned, user.deleted, router]);

  // Maintenance switched on mid-session evicts everyone.
  useEffect(() => {
    if (config.maintenance.isActive) router.replace('/maintenance');
  }, [config.maintenance.isActive, router]);

  /**
   * VIP expires client-side the moment the timestamp passes, without waiting
   * for the admin to downgrade the row.
   */
  const isVip = useMemo(() => {
    if (user.role !== 'vip') return false;
    if (!user.vipExpiry) return true;
    return user.vipExpiry > new Date();
  }, [user.role, user.vipExpiry]);

  // The Supabase list replaces the bundled fallback as soon as it lands.
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

  // 'po' hides every non-Pocket-Option pair from users.
  const visiblePairs = useMemo(
    () => (config.displaySource === 'po' ? pairs.filter((p) => p.source === 'po') : pairs),
    [pairs, config.displaySource],
  );

  const chartSymbol = useMemo(() => {
    const match = visiblePairs.find((p) => p.symbol === activePair);
    return match?.chart_symbol ?? chartSymbolFor(activePair);
  }, [visiblePairs, activePair]);

  // Only meaningful in scraping mode; the simulator has no real market hours.
  const market = useOtcStatus(chartSymbol, config.priceSystem !== 'simulator');

  // main_screen.dart:2717
  //   _priceSystemRaw ?? (_chartMode == 'sim' ? 'simulator' : 'scraping')
  const effectivePriceSystem =
    config.priceSystem ?? (config.chartMode === 'sim' ? 'simulator' : 'scraping');

  // main_screen.dart:4537 — the mode chart.js is given.
  const activePairData = visiblePairs.find((p) => p.symbol === activePair);
  const isPo = (activePairData?.source ?? 'po') === 'po';
  const effectiveMode =
    effectivePriceSystem === 'simulator' ? 'sim' : isPo ? 'otc' : 'sim';

  const strategyJson = isVip ? config.strategyVip : config.strategyStandard;

  const engine = useSignalEngine({
    chartSymbol,
    timeframe,
    priceSystem: effectivePriceSystem,
    role: isVip ? 'vip' : 'standard',
    guaranteedWin: user.guaranteedWin,
    strategyJson,
    pair: activePair,
  });

  // Monitoring drives the SAME request path as the manual button, so a fired
  // signal behaves identically no matter which started it.
  const monitoring = useMonitoring({
    timeframeSeconds: timeframeSeconds(timeframe),
    marketClosed: !market.open,
    evaluate: () => engine.requestSignal(selectedMinutes),
    signalPending: engine.activeSignal !== null,
  });

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
          <AssetSelector
            pairs={visiblePairs}
            active={activePair}
            onSelect={setActivePair}
            closedPairs={market.closedPairs}
          />

          {!market.healthy && (
            <div className={styles.reconnecting} role="status">
              {tr(
                'جاري إعادة الاتصال بمزوّد الأسعار...',
                'Reconnecting to the price provider…',
              )}
            </div>
          )}

          <div className={styles.chartCard}>
            <div className={styles.chartHead}>
              <span className={styles.pairName}>{activePair}</span>
              <div className={styles.timeframes} role="group" aria-label={tr('الإطار الزمني', 'Timeframe')}>
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
            selectedMinutes={selectedMinutes}
            onSelectMinutes={setSelectedMinutes}
            onRequest={() => engine.requestSignal(selectedMinutes)}
            onClear={engine.clearSignal}
            hasCandles={engine.candles.length > 0}
            isVip={isVip}
          />

          <MonitoringPanel
            state={monitoring}
            onStart={monitoring.start}
            onStop={monitoring.stop}
            disabled={engine.candles.length === 0}
            marketClosed={!market.open}
          />

          <SignalHistory history={engine.history} />
        </aside>
      </div>
    </main>
  );
}
