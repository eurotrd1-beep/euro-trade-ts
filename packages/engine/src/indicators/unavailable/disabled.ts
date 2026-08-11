/**
 * DISABLED — not imported by indicators/index.ts, so none of these names reach
 * the registry. The implementations are untouched, in their original files.
 *
 * Reason: الفحص لم يرصد لها أي حركة على 10,744 تقييم — قيمة واحدة طوال العينة
 *
 * Re-enable: توفّر تاريخ أطول يثبت أنها تتحرك، ثم إعادة سطر الاستيراد في indicators/index.ts
 *
 * Appended by scripts/disable-indicators.mts.
 */

import * as m from '../math.js';
import { register } from '../../registry.js';
import { islandReversal, roundingPattern } from '../extended.js';
import { harmonic } from '../ict.js';
import { flag } from '../patterns.js';
import { reaccumulation, redistribution, silverBullet } from '../quant.js';
import { vcp, vsaSignal } from '../schools.js';
import { volumeProfileStats } from '../structure.js';


// ── الفحص لم يرصد لها أي حركة على 10,744 تقييم — قيمة واحدة طوال العينة ──
register('island_reversal', ({ candles, currentPrice }) => islandReversal(candles, currentPrice));
register('rounding_bottom', ({ candles, currentPrice }) =>
  roundingPattern(candles, currentPrice, true),
);
register('rounding_top', ({ candles, currentPrice }) =>
  roundingPattern(candles, currentPrice, false),
);
register('bull_flag', ({ candles, currentPrice }) => flag(candles, currentPrice, true));
register('bear_flag', ({ candles, currentPrice }) => flag(candles, currentPrice, false));
register('silver_bullet', () => silverBullet());
register('reaccumulation', ({ candles, currentPrice }) => reaccumulation(candles, currentPrice));
register('redistribution', ({ candles, currentPrice }) => redistribution(candles, currentPrice));
register('three_drives', ({ candles, currentPrice }) =>
  harmonic(candles, currentPrice, 'three_drives'),
);
register('vcp', ({ candles, currentPrice }) => vcp(candles, currentPrice));
register(['vsa', 'no_demand', 'no_supply'], ({ candles, currentPrice }) =>
  vsaSignal(candles, currentPrice),
);
register('liquidity', ({ candles }) => {
  const volRatio = volumeProfileStats(candles).ratio;
  const volDelta = m.volumeDelta(candles);
  const cmfVal = m.cmf(candles, 20);
  if (volRatio > 1.5 && volDelta > 0 && cmfVal > 0.05) return 'institutional_buying';
  if (volRatio > 1.5 && volDelta < 0 && cmfVal < -0.05) return 'institutional_selling';
  return 'none';
});

// ── المعيار 3 — يقرآن الحجم وهو غير موجود. كانا مستثنيين لأن الحجم الثابت يُختصر من المعادلة فيتبقّى متوسط السعر النموذجي (مُتحقَّق حتى 1e-12)، لكن قاعدة تُطبَّق على البعض ليست قاعدة ──
register('vwap', ({ candles, currentPrice }) => m.vwap(candles, currentPrice));
register('price_vs_vwap', ({ candles, currentPrice }) => currentPrice - m.vwap(candles, currentPrice));
