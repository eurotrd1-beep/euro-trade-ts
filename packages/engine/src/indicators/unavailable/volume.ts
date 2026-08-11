/**
 * DISABLED — not imported by indicators/index.ts, so none of these names reach
 * the registry.
 *
 * Reason: THE FEED CARRIES NO VOLUME. Pocket Option streams tick prices; the
 * scraper builds candles from them and the payload has no volume field at all
 * (check the raw API — the key is simply absent), so the app substitutes a
 * constant. Every indicator below is computing over a number invented at the
 * edge of the system.
 *
 * Nothing here is wrong with the code. The implementations stay exactly where
 * they were — only the registrations moved — because the input is what is
 * missing, not the logic.
 *
 * Re-enable: the day the candle feed carries real volume. Add
 * `import './unavailable/volume.js'` back to indicators/index.ts, delete the
 * entries from VOLUME_DEPENDENT in ../../meta.ts, and re-run
 * scripts/audit-liveness.mts to confirm they move.
 *
 * ── WHY EACH ONE ──────────────────────────────────────────────────────────
 *
 * Five collapse to a fixed number, so the rule is inert whatever the market
 * does: volume, vol_ratio, volume_oscillator, nvi, pvi.
 *
 * The rest still move, but over the invented constant, which is worse than
 * inert — a plausible number nobody has reason to distrust.
 *
 * wyckoff_phase deserves its own note: volume is not incidental there, it gates
 * the branch. Five of its ten phases test the volume ratio (`sc`, `sos`, `bc`,
 * `st`, `ps`) and with a flat volume that ratio is always 1, so those five are
 * unreachable. It was returning only `none | utad | spring_test | lps` — half a
 * Wyckoff classifier, silently.
 *
 * NOT MOVED, deliberately: `vwap` and `price_vs_vwap`. A constant volume
 * factors out of Σ(typical × V) / ΣV exactly, leaving the mean typical price —
 * verified identical to 1e-12 in test/volume-meta.test.ts. That is a real
 * moving average, so they keep working under a note that says what they
 * actually compute. `cmf` and `mfi` share that property mathematically, but
 * were removed with the rest.
 *
 * Verified 2026-08-11 across 10,744 evaluations per indicator on 405 contiguous
 * segments (33,501 candles, 183 symbols, 24/24 hours).
 */

import * as m from '../math.js';
import { register } from '../../registry.js';
import { cvd } from '../schools.js';
import { elderForceIndex, emv, klinger, nvi, pvt } from '../advanced.js';
import { pvi, volumeOscillator, wyckoffPhase } from '../extended.js';
import { liquidityZones, volumeProfileStats } from '../structure.js';

register('elder_force_index', ({ candles }) => elderForceIndex(candles));
register(['emv', 'ease_of_movement'], ({ candles, rule }) => emv(candles, rule.period));
register('pvt', ({ candles }) => pvt(candles));
register(['klinger', 'klinger_oscillator'], ({ candles }) => klinger(candles));
register('nvi', ({ candles }) => nvi(candles));
register('pvi', ({ candles }) => pvi(candles));
register('mfi', ({ candles, rule }) => m.mfi(candles, rule.period));
register('cmf', ({ candles, rule }) => m.cmf(candles, rule.period));
register('obv', ({ candles }) => m.obv(candles));
register('vol_delta', ({ candles }) => m.volumeDelta(candles));
register('volume_oscillator', ({ candles, rule }) => volumeOscillator(candles, rule.fast, rule.slow));
register('wyckoff_phase', ({ candles, currentPrice }) => wyckoffPhase(candles, currentPrice));
register(['cvd', 'cumulative_volume_delta'], ({ candles }) => cvd(candles));
register('liquidity_score', ({ candles, currentPrice }) => liquidityZones(candles, currentPrice).score);
register('volume_profile', ({ candles, currentPrice }) => {
  const score = liquidityZones(candles, currentPrice).score;
  if (score > 65) return 'high_volume_node';
  if (score < 35) return 'low_volume_node';
  return 'neutral';
});
register(['vol_ratio', 'volume'], ({ candles }) => volumeProfileStats(candles).ratio);
