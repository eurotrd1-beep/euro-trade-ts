/**
 * Core indicator registrations — batch 1.
 *
 * Each `register` call mirrors one `case` in the Dart dispatch switch
 * (`SignalEngine._computeIndicator`, signal_engine.dart:887-1573), including
 * which rule parameters that case actually reads. Cases that ignore a rule
 * parameter ignore it here too.
 */

import { register } from '../registry.js';
import * as m from './math.js';

// ── Momentum ────────────────────────────────────────────────────────────────
register('rsi', ({ candles, rule }) => m.rsi(candles, rule.period));
register('cci', ({ candles, rule }) => m.cci(candles, rule.period));
register('roc', ({ candles, rule, currentPrice }) => m.roc(candles, rule.period, currentPrice));
register('williams_r', ({ candles, rule, currentPrice }) =>
  m.williamsR(candles, rule.period, currentPrice),
);

// ── MACD ────────────────────────────────────────────────────────────────────
// All three read the same computation; the Dart code recomputes it per case.
register('macd_line', ({ candles, currentPrice }) => m.fullMacd(candles, currentPrice).macd);
register('macd_signal', ({ candles, currentPrice }) => m.fullMacd(candles, currentPrice).signal);
register('macd_histogram', ({ candles, currentPrice }) =>
  m.fullMacd(candles, currentPrice).histogram,
);

// ── Moving averages ─────────────────────────────────────────────────────────
// Dart clamps the period to the candle count before calling: min(r.period, len).
register('ema', ({ candles, rule, currentPrice }) =>
  m.ema(candles, Math.min(rule.period, candles.length), currentPrice),
);
register('ema_cross', ({ candles, rule, currentPrice }) =>
  m.ema(candles, Math.min(rule.fast, candles.length), currentPrice) -
  m.ema(candles, Math.min(rule.slow, candles.length), currentPrice),
);

// ── Trend strength ──────────────────────────────────────────────────────────
register('adx', ({ candles, rule }) => m.adxFull(candles, rule.period).adx);
register('plus_di', ({ candles, rule }) => m.adxFull(candles, rule.period).plusDi);
register('minus_di', ({ candles, rule }) => m.adxFull(candles, rule.period).minusDi);

// ── Stochastic ──────────────────────────────────────────────────────────────
register('stoch_k', ({ candles, rule, currentPrice }) =>
  m.stochastic(candles, rule.period, rule.smooth, currentPrice).k,
);
register('stoch_d', ({ candles, rule, currentPrice }) =>
  m.stochastic(candles, rule.period, rule.smooth, currentPrice).d,
);
register('stoch_cross', ({ candles, rule, currentPrice }) => {
  const s = m.stochastic(candles, rule.period, rule.smooth, currentPrice);
  return s.k - s.d;
});

// ── Volatility / bands ──────────────────────────────────────────────────────
register('atr', ({ candles, rule, currentPrice }) => m.atr(candles, rule.period, currentPrice));
register('bb_upper', ({ candles, rule, currentPrice }) =>
  m.bollingerBands(candles, rule.period, currentPrice, rule.stddev).upper,
);
register('bb_lower', ({ candles, rule, currentPrice }) =>
  m.bollingerBands(candles, rule.period, currentPrice, rule.stddev).lower,
);
register('bb_width', ({ candles, rule, currentPrice }) => {
  const bb = m.bollingerBands(candles, rule.period, currentPrice, rule.stddev);
  return bb.upper - bb.lower;
});
register('bb_position', ({ candles, rule, currentPrice }) => {
  const bb = m.bollingerBands(candles, rule.period, currentPrice, rule.stddev);
  const range = bb.upper - bb.lower;
  return range > 0 ? ((currentPrice - bb.lower) / range) * 100.0 : 50.0;
});

// ── Volume ──────────────────────────────────────────────────────────────────
register('vwap', ({ candles, currentPrice }) => m.vwap(candles, currentPrice));
register('price_vs_vwap', ({ candles, currentPrice }) => currentPrice - m.vwap(candles, currentPrice));

// ── Structure levels ────────────────────────────────────────────────────────
register('sr_support', ({ candles, currentPrice }) =>
  m.supportResistance(candles, currentPrice).support,
);
register('sr_resistance', ({ candles, currentPrice }) =>
  m.supportResistance(candles, currentPrice).resistance,
);

// ── Raw price ───────────────────────────────────────────────────────────────
register('price', ({ currentPrice }) => currentPrice);
