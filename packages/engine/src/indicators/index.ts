/**
 * Registers every indicator a strategy may name. There are eight.
 *
 * This file used to import eleven modules and register 237 names. The rest
 * were removed on request: what a rule can ask for now is the Fibonacci family
 * and the two support/resistance readings drawn from the same swing.
 *
 * `math.ts`, `structure.ts` and `patterns.ts` are deliberately NOT imported
 * here any more. They still hold their maths — the analysis stages and the
 * fallback V2 scorer read it directly — but they register nothing, so none of
 * it is reachable from a strategy file. See the banner at the top of each.
 */

import './levels.js';
