'use client';

/**
 * Candlestick chart — replaces lib/widgets/price_chart_web.dart.
 *
 * The Dart widget reached a JavaScript chart through `dart:ui_web` platform
 * views and a `dart:js` bridge, splitting Flutter's canvas into layers around a
 * DOM island. Here the chart is simply a DOM element, so that whole bridge —
 * and its scroll/clipping quirks — disappears.
 *
 * Behaviour kept from the original:
 *   • an entry line drawn at the signal price, coloured by direction
 *   • the same palette as the rest of the app
 *   • a `priceGetter` handed back to the parent so the engine can read the live
 *     price without prop-drilling it through every render
 */

import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '@euro/engine';

export interface PriceChartProps {
  candles: readonly Candle[];
  /** 'CALL' | 'PUT' | null — null removes the entry line. */
  signalDirection: 'CALL' | 'PUT' | null;
  signalEntryPrice: number | null;
  /** Called once the chart is live; hands back a reader for the latest close. */
  onReady?: (priceGetter: () => number) => void;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function PriceChart({
  candles,
  signalDirection,
  signalEntryPrice,
  onReady,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const latestRef = useRef(0);

  // Create once. Re-creating on every data change would reset zoom and pan.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: cssVar('--text-secondary', '#8B88A0'),
        fontFamily: 'inherit',
      },
      grid: {
        vertLines: { color: cssVar('--border-glow', '#2C2250'), style: LineStyle.Dotted },
        horzLines: { color: cssVar('--border-glow', '#2C2250'), style: LineStyle.Dotted },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: cssVar('--border-glow', '#2C2250') },
      timeScale: {
        borderColor: cssVar('--border-glow', '#2C2250'),
        timeVisible: true,
        secondsVisible: false,
      },
      autoSize: true,
      handleScale: { axisPressedMouseMove: false },
    });

    const series = chart.addCandlestickSeries({
      upColor: cssVar('--call-green', '#00FF7F'),
      downColor: cssVar('--put-red', '#FF2A6D'),
      borderUpColor: cssVar('--call-green', '#00FF7F'),
      borderDownColor: cssVar('--put-red', '#FF2A6D'),
      wickUpColor: cssVar('--call-green', '#00FF7F'),
      wickDownColor: cssVar('--put-red', '#FF2A6D'),
    });

    chartRef.current = chart;
    seriesRef.current = series;

    onReady?.(() => latestRef.current);

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      entryLineRef.current = null;
    };
    // onReady is intentionally excluded: a parent re-render must not tear the
    // chart down and lose the user's zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Feed data.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || candles.length === 0) return;

    const data: CandlestickData[] = candles.map((c) => ({
      // lightweight-charts wants seconds, the engine carries milliseconds.
      time: Math.floor(c.time / 1000) as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    series.setData(data);
    latestRef.current = candles[candles.length - 1]!.close;
  }, [candles]);

  // Entry line — added, moved and removed as the active signal changes.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    if (entryLineRef.current) {
      series.removePriceLine(entryLineRef.current);
      entryLineRef.current = null;
    }

    if (signalDirection === null || signalEntryPrice === null) return;

    const isCall = signalDirection === 'CALL';
    entryLineRef.current = series.createPriceLine({
      price: signalEntryPrice,
      color: isCall ? cssVar('--call-green', '#00FF7F') : cssVar('--put-red', '#FF2A6D'),
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: signalDirection,
    });
  }, [signalDirection, signalEntryPrice]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', minHeight: 260 }}
      role="img"
      aria-label="Price chart"
    />
  );
}
