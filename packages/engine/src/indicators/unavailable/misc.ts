/**
 * DISABLED — not imported by indicators/index.ts, so this name does not reach
 * the registry.
 *
 * `kelly_criterion` is called with an empty array: `kellyValue([])`. The Kelly
 * fraction needs a history of trade outcomes to size a bet from, and the engine
 * has no such history at the point an indicator runs — so it always answers
 * from nothing.
 *
 * Not a volume problem and not a placeholder, which is why it sits on its own.
 *
 * Re-enable: when the engine can hand an indicator the account's realised
 * outcomes. That is a change to the engine's shape, not a data feed — an
 * indicator currently receives candles, a rule and a clock, and nothing else.
 *
 * Verified 2026-08-11 across 10,744 evaluations on 405 contiguous segments
 * (33,501 candles, 183 symbols, 24/24 hours): one value throughout.
 */

import { register } from '../../registry.js';
import { kellyValue } from '../quant.js';

register('kelly_criterion', () => kellyValue([]));
