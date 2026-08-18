/**
 * @euro/engine — the EURO TRADE signal engine.
 *
 * ── WHAT IS LEFT, AND WHY IT IS SO SMALL ───────────────────────────────────
 *
 * This was a line-for-line port of `signal_engine.dart`: 237 registered
 * indicators, a pyramid decision layer, a correlation calibration, and a
 * parity suite that diffed every indicator value against a recorded Dart run.
 *
 * The indicators and the pyramid were removed on request. What a strategy can
 * name is now eight things — the Fibonacci family drawn from the intermediate
 * swing, and the two support/resistance readings taken from the same swing —
 * and how they are scored is a flat sum. The parity suite went with them:
 * there is nothing left for it to compare, because the values it guarded no
 * longer exist. `test/scoring-parity.test.ts` still holds the V2 scorer to its
 * Dart numbers, and that scorer only runs when no strategy is uploaded.
 *
 * Stated plainly so nobody goes looking: the maths in `indicators/math.ts`,
 * `structure.ts` and `patterns.ts` survives and is exported below, but none of
 * it is registered. It feeds the analysis stages the app prints and the V2
 * fallback. A rule naming any of it scores 0.0, exactly like a typo.
 */

// Core types
export type { Candle, IndicatorValue, StrategyRule } from './types.js';
export { makeRule, ruleFromJson } from './types.js';
export {
  VOLUME_DEAD,
  VOLUME_DEGRADES_TO_PRICE,
  VOLUME_DEPENDENT,
  volumeNote,
} from './meta.js';

// Indicator dispatch
export {
  computeIndicator,
  indicatorFor,
  isRegistered,
  registeredNames,
  registeredNamesInOrder,
  systemClock,
  cacheKey,
  type EngineClock,
  type IndicatorContext,
  type IndicatorFn,
} from './registry.js';

// Which names are one computation under several labels, and the check that
// stops a strategy counting one reading as three.
export {
  aliasConflictMessages,
  aliasConflicts,
  aliasGroupOf,
  aliasGroups,
  canonicalName,
  type AliasConflict,
  type AliasGroup,
} from './aliases.js';

// Registers the eight indicators as a side effect. Importing the package is
// enough; no explicit setup call is needed.
import './indicators/index.js';

// Strategy layer
export {
  checkCondition,
  evaluateRules,
  effectiveMaxScore,
  type DynamicStrategy,
  type EvalContext,
} from './strategy.js';

// Parametric configuration and the V2 scorer
export {
  DEFAULT_STRATEGY_CONFIG,
  strategyConfigFromJson,
  type StrategyConfig,
} from './config.js';
export { scoreV2, scoreStandard } from './scoring.js';

// Strategy programs — state machines that read a SEQUENCE of candles, for
// strategies the rule scorer cannot express. See programs/types.ts.
export {
  DEFAULT_PROGRAM_ID,
  programFor,
  programForPlan,
  registeredPrograms,
  fib236Touch,
  NO_EVENT,
  type Plan,
  type StrategyProgram,
  type ProgramState,
  type ProgramContext,
  type ProgramEvent,
  type ProgramStage,
  type SetupDiagnostics,
  type TradeResult,
  type CycleResult,
  type ProgramCycle,
} from './programs/index.js';

// Signal lifecycle
export {
  confidenceFor,
  CONFIDENCE_SATURATION_SCORE,
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

// Indicator maths, exported as FUNCTIONS and registered nowhere. The analysis
// sequence in the app prints live values from these, so they are part of the
// public surface — but no strategy can reach them.
export {
  rsi, sma, ema, atr, vwap, obv, cmf, cci, mfi, roc,
  williamsR, volumeDelta, stochastic, bollingerBands, fullMacd,
  adxFull, supportResistance, clamp,
} from './indicators/math.js';

export { liquidityZones, volumeProfileStats, rsiDivergence, marketStructure } from './indicators/structure.js';
export { candlePatterns, swingPoints, avgBodySize } from './indicators/patterns.js';

/**
 * The swing the Fibonacci is drawn between, and the levels on it.
 *
 * Exported for the app's analysis sequence, which used to narrate a dozen
 * indicators the strategy does not read. It reads this one, so this is what
 * the sequence shows.
 */
export { detectSwing, FIB_LEVELS, type Swing } from './indicators/levels.js';
