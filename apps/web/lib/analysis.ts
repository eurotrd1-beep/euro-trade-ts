/**
 * The analysis sequence the signal button runs — ported from
 * `requestNextSignal` (signal_engine.dart:2301).
 *
 * Twelve stages, 400 ms apart, each showing what it actually measured. Then it
 * WAITS for the current candle to close so the trade opens with the next one —
 * that wait is the whole point of the button and was missing before.
 *
 * The stage texts are not decoration: they print live indicator values, so a
 * user watching them can see the analysis is reading their pair.
 */

import {
  adxFull,
  atr as calcAtr,
  cci as calcCci,
  cmf as calcCmf,
  mfi as calcMfi,
  rsi as calcRsi,
  stochastic,
  supportResistance,
  volumeDelta,
  vwap as calcVwap,
} from '@euro/engine';
import { liquidityZones, rsiDivergence } from '@euro/engine';
import { candlePatterns } from '@euro/engine';
import { formatPrice, tr } from '@euro/shared';
import type { Candle } from '@euro/engine';

/** Dart: `await Future.delayed(const Duration(milliseconds: 400))` per stage. */
export const STAGE_DELAY_MS = 400;

/** Dart polls the candle-close countdown every 100 ms. */
export const WAIT_TICK_MS = 100;

export interface StageInput {
  candles: readonly Candle[];
  currentPrice: number;
  pair: string;
}

/**
 * Builds all twelve stage messages up front. The Dart version computes each
 * indicator immediately before showing its line; the values are identical
 * either way because the candle buffer does not change during the sequence.
 */
export function buildStages({ candles, currentPrice, pair }: StageInput): string[] {
  const name = pair.replace(' (OTC)', '');

  const sr = supportResistance(candles, currentPrice);
  const rsi = calcRsi(candles, 14);
  const stoch = stochastic(candles, 14, 3, currentPrice);
  const cci = calcCci(candles, 20);
  const atr = calcAtr(candles, 14, currentPrice);
  const adx = adxFull(candles, 14);
  const vwap = calcVwap(candles, currentPrice);
  const mfi = calcMfi(candles, 14);
  const cmf = calcCmf(candles, 20);
  const volDelta = volumeDelta(candles);
  const liq = liquidityZones(candles, currentPrice);
  const pattern = candlePatterns(candles);
  const divergence = rsiDivergence(candles);

  return [
    tr(
      `📊 تحليل مستويات الدعم والمقاومة لـ ${name} | الدعم: ${formatPrice(sr.support)} | المقاومة: ${formatPrice(sr.resistance)}...`,
      `📊 Analyzing support & resistance for ${name} | Support: ${formatPrice(sr.support)} | Resistance: ${formatPrice(sr.resistance)}...`,
    ),
    tr(
      `📈 فحص مؤشرات التذبذب ومناطق التشبع | RSI: ${rsi.toFixed(1)} | Stochastic: ${stoch.k.toFixed(1)} | CCI: ${cci.toFixed(0)}...`,
      `📈 Checking oscillators & overbought/oversold zones | RSI: ${rsi.toFixed(1)} | Stochastic: ${stoch.k.toFixed(1)} | CCI: ${cci.toFixed(0)}...`,
    ),
    tr(
      `⚡ فحص قوة الاتجاه ومعدل التذبذب | ATR: ${atr.toFixed(5)} | ADX: ${adx.adx.toFixed(1)}...`,
      `⚡ Checking trend strength & volatility | ATR: ${atr.toFixed(5)} | ADX: ${adx.adx.toFixed(1)}...`,
    ),
    tr(
      `🏦 مراقبة تدفق سيولة الحوت والـ MFI | MFI: ${mfi.toFixed(1)} | VWAP: ${formatPrice(vwap)}...`,
      `🏦 Watching whale liquidity flow & MFI | MFI: ${mfi.toFixed(1)} | VWAP: ${formatPrice(vwap)}...`,
    ),
    tr(
      `💰 حساب ضغط الشراء مقابل البيع | CMF: ${cmf.toFixed(3)} | Vol Delta: ${volDelta.toFixed(1)}%...`,
      `💰 Calculating buying vs selling pressure | CMF: ${cmf.toFixed(3)} | Vol Delta: ${volDelta.toFixed(1)}%...`,
    ),
    tr(
      `🔍 تحديد مناطق الطلب والعرض والمستويات المؤسسية | LIQ Score: ${liq.score.toFixed(0)}%...`,
      `🔍 Identifying demand & supply zones and institutional levels | LIQ Score: ${liq.score.toFixed(0)}%...`,
    ),
    tr(
      `🕯️ تحليل البرايس أكشن ونموذج الشموع | Pattern: ${pattern.replace(/_/g, ' ')} | Divergence: ${divergence}...`,
      `🕯️ Analyzing price action & candlestick patterns | Pattern: ${pattern.replace(/_/g, ' ')} | Divergence: ${divergence}...`,
    ),
    tr(
      '⚙️ قياس قوة العملة مقابل مؤشر الدولار والعملات الأخرى (Correlation Index)...',
      '⚙️ Measuring currency strength vs the dollar index and other currencies (Correlation Index)...',
    ),
    tr(
      '🔄 فحص محاذاة الاتجاه عبر الفريمات المتعددة لضمان دقة الدخول...',
      '🔄 Checking trend alignment across multiple timeframes to ensure entry accuracy...',
    ),
    tr(
      '🛡️ تصفية الضوضاء السعرية وكشف كسر الدعم والمقاومة الكاذب...',
      '🛡️ Filtering price noise and detecting false support/resistance breaks...',
    ),
    tr(
      '🔒 تطبيق مرشحات الأمان وفحص نسبة العائد للمخاطرة...',
      '🔒 Applying safety filters and checking the risk/reward ratio...',
    ),
    tr(
      '🏁 احتساب Confluence النهائي لـ 18 مؤشر فني وحسم اتجاه السوق...',
      '🏁 Computing the final confluence of 18 technical indicators and deciding market direction...',
    ),
  ];
}

/** The countdown line shown while waiting for the candle to close. */
export function waitingText(secondsLeft: number): string {
  return tr(
    `بانتظار إغلاق الشمعة الحالية لفتح صفقة مع الشمعة القادمة: ${secondsLeft} ثانية...`,
    `Waiting for the current candle to close to open a trade with the next candle: ${secondsLeft}s...`,
  );
}

/** Dart: `_isForexPairType()` — OTC pairs trade 24/7 and are never "weekend closed". */
export function isForexPair(pairSymbol: string): boolean {
  return !pairSymbol.toUpperCase().includes('OTC');
}

export function isWeekend(now: Date = new Date()): boolean {
  const d = now.getDay();
  return d === 6 || d === 0; // Saturday or Sunday
}
