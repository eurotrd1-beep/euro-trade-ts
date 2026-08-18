'use client';

/**
 * Price chart — drives `public/chart.js`, which is the project's OWN chart,
 * copied byte-for-byte from euro_trade/web/chart.js (1,431 lines, unchanged).
 *
 * It is the same engine the old app used: live ticks over the `/ws` WebSocket,
 * an 8-second status poll, sim and OTC modes, the entry line and the trade
 * overlay. Nothing here re-implements any of that.
 *
 * The Dart widget reached it through `dart:js` + a platform view. This calls
 * the identical methods with the identical arguments, in the identical order:
 *
 *   init(id, symbol, interval, mode)
 *   update(id, symbol, interval, mode)      on symbol / interval / mode change
 *   setEntryLine(id, price, direction)
 *   setTradeState(id, active, dir, entry, secondsLeft, guaranteedWin)
 *   getLastPrice(id)
 *   destroy(id)
 *   setProxy(url)                            main_screen.dart:253, :280
 */

import { useEffect, useRef } from 'react';
import { getProxyUrl, onProxyUrlChange } from '@euro/shared';

/** The global chart.js installs on `window`. */
interface CandleChartApi {
  init: (id: string, sym: string, iv: string, mode: string) => void;
  update: (id: string, sym: string, iv: string, mode: string) => void;
  destroy: (id: string) => void;
  getLastPrice: (id: string) => number;
  setEntryLine: (id: string, price: number | null, direction: string | null) => void;
  setGlobalEntryLine: (price: number | null, direction: string | null) => void;
  setTradeState: (
    id: string,
    active: boolean,
    direction: string,
    entryPrice: number,
    secondsLeft: number,
    guaranteedWin: boolean,
  ) => void;
  setProxy: (url: string) => void;
  updateAllSimPrice: (price: number) => void;
}

declare global {
  interface Window {
    CandleChart?: CandleChartApi;
  }
}

/** Resolves once chart.js has installed `window.CandleChart`. */
let loader: Promise<void> | null = null;

function loadChartScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.CandleChart) return Promise.resolve();
  if (loader) return loader;

  loader = new Promise<void>((resolve, reject) => {
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
    const script = document.createElement('script');
    // Same cache-busting query the old index.html used.
    script.src = `${base}/chart.js?v=5`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('failed to load chart.js'));
    document.head.appendChild(script);
  });

  return loader;
}

export interface PriceChartProps {
  /** Pocket Option chart symbol, e.g. `EURUSD_otc`. */
  symbol: string;
  /** '1m' | '5m' | '15m' | '1h' */
  interval: string;
  /** 'sim' | 'otc' — the mode chart.js expects. */
  mode: string;
  signalDirection: 'CALL' | 'PUT' | null;
  signalEntryPrice: number | null;
  signalSecondsRemaining: number;
  guaranteedWin: boolean;
  /** Hands back a reader for the chart's last price, as the Dart widget did. */
  onReady?: (priceGetter: () => number) => void;
}

export function PriceChart({
  symbol,
  interval,
  mode,
  signalDirection,
  signalEntryPrice,
  signalSecondsRemaining,
  guaranteedWin,
  onReady,
}: PriceChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<string>(`cc-${Date.now()}`);
  const readyRef = useRef(false);

  // ── init / destroy ────────────────────────────────────────────────────────
  useEffect(() => {
    const id = idRef.current;
    let cancelled = false;

    void loadChartScript()
      .then(() => {
        if (cancelled || !window.CandleChart) return;

        // main_screen.dart calls setChartProxy before the chart runs, so the
        // socket and candle fetches use the admin-configured server.
        window.CandleChart.setProxy(getProxyUrl());
        window.CandleChart.init(id, symbol, interval, mode);

        readyRef.current = true;
        onReady?.(() => {
          try {
            return window.CandleChart?.getLastPrice(id) ?? 0;
          } catch {
            return 0;
          }
        });
      })
      .catch(() => {
        // chart.js missing — the rest of the app keeps working.
      });

    // An admin switching the proxy re-points the chart live, exactly as the
    // Dart screen does on its ServerConfig listener.
    const offProxy = onProxyUrlChange((url) => {
      try {
        window.CandleChart?.setProxy(url);
      } catch {
        // ignored
      }
    });

    return () => {
      cancelled = true;
      offProxy();
      readyRef.current = false;
      try {
        window.CandleChart?.destroy(id);
      } catch {
        // ignored
      }
    };
    // Mount once: symbol/interval/mode changes go through `update`, not a
    // re-init, so the socket and candle buffer survive — same as Dart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── symbol / interval / mode → update ─────────────────────────────────────
  useEffect(() => {
    if (!readyRef.current) return;
    try {
      window.CandleChart?.update(idRef.current, symbol, interval, mode);
    } catch {
      // ignored
    }
  }, [symbol, interval, mode]);

  // ── entry line + trade overlay ────────────────────────────────────────────
  useEffect(() => {
    if (!readyRef.current) return;
    const id = idRef.current;
    const active = signalDirection !== null && signalDirection !== undefined;

    try {
      window.CandleChart?.setEntryLine(
        id,
        active ? (signalEntryPrice ?? 0) : null,
        active ? signalDirection : null,
      );
      window.CandleChart?.setTradeState(
        id,
        active,
        active ? signalDirection : '',
        active ? (signalEntryPrice ?? 0) : 0,
        active ? signalSecondsRemaining : 0,
        active && guaranteedWin,
      );
    } catch {
      // ignored
    }
  }, [signalDirection, signalEntryPrice, signalSecondsRemaining, guaranteedWin]);


  return (
    <div
      ref={hostRef}
      id={idRef.current}
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#0A0714',
        // Same guards the Dart view factory set on its container.
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
