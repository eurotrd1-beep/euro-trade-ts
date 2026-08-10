/**
 * @euro/engine — the EURO TRADE signal engine.
 *
 * A line-for-line TypeScript port of `signal_engine.dart`, proven identical to
 * the Dart original by the parity suite in `test/`:
 *
 *   • 359 indicators           — every value diffed against a recorded Dart run
 *   • pyramid decision layer   — 8 scenarios covering every accept/reject path
 *   • V2 parametric scorer     — 4 configurations
 *   • confidence and outcomes  — the numbers shown on each trade
 *
 * The one exception is `monte_carlo_risk_simulation`, which draws random
 * samples and so cannot be value-matched in any runtime; the parity test
 * documents it explicitly rather than skipping it quietly.
 *
 * Regenerate the fixture with:
 *   cd tools/golden-dart && flutter test test/generate_golden_test.dart
 */

// Core types
export type { Candle, IndicatorValue, StrategyRule } from './types.js';
export { makeRule, ruleFromJson } from './types.js';

// Indicator dispatch
export {
  computeIndicator,
  isRegistered,
  registeredNames,
  systemClock,
  cacheKey,
  type EngineClock,
  type IndicatorContext,
  type IndicatorFn,
} from './registry.js';

// Registers all 359 indicators as a side effect. Importing the package is
// enough; no explicit setup call is needed.
import './indicators/index.js';

// Strategy layer
export {
  checkCondition,
  categoryForIndicator,
  evaluateStrategyPro,
  evaluateRules,
  effectiveMaxScore,
  pyramidFromJson,
  DEFAULT_PYRAMID,
  type DynamicStrategy,
  type PyramidConfig,
  type ProResult,
  type EvalContext,
} from './strategy.js';

// Parametric configuration and the V2 scorer
export {
  DEFAULT_STRATEGY_CONFIG,
  strategyConfigFromJson,
  type StrategyConfig,
} from './config.js';
export { scoreV2, scoreStandard } from './scoring.js';

// Signal lifecycle
export {
  confidenceFor,
  alignExpiry,
  tieEpsilon,
  outcomeFor,
  resolveExitPrice,
  guaranteedWinExit,
  type Direction,
  type SignalStatus,
  type TradingSignal,
  type AlignedExpiry,
} from './signal.js';
