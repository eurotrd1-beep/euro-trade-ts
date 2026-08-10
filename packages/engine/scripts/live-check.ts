/**
 * Live smoke check — runs the ported engine against REAL candles from the
 * production proxy.
 *
 * The parity suite proves the engine matches Dart on a frozen synthetic
 * fixture. This proves something different and equally necessary: that the
 * real feed still has the shape the port expects, and that the engine produces
 * sane values on live market data.
 *
 * Deliberately NOT part of `npm test` — it needs the network and real market
 * state, so it must never be able to fail CI for reasons unrelated to the code.
 *
 * Run with:  npx tsx scripts/live-check.ts [SYMBOL] [INTERVAL]
 */

import {
  computeIndicator,
  confidenceFor,
  makeRule,
  registeredNames,
  scoreV2,
  systemClock,
  type Candle,
} from '../src/index.js';

const PROXY = 'https://euro-trade-cache.eurotrade.workers.dev';
const symbol = process.argv[2] ?? 'EURUSD_otc';
const interval = process.argv[3] ?? '1m';

const SAMPLE = [
  'rsi', 'adx', 'macd_line', 'stoch_k', 'bb_position',
  'ichimoku', 'market_structure', 'candle_pattern', 'supertrend', 'atr',
];

async function main(): Promise<void> {
  const res = await fetch(
    `${PROXY}/api/otc/candles?symbol=${symbol}&interval=${interval}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (res.status !== 200) throw new Error(`proxy returned ${res.status}`);

  const body = (await res.json()) as { candles?: Array<Record<string, number>> };
  const raw = body.candles ?? [];
  if (raw.length === 0) throw new Error('proxy returned no candles');

  const candles: Candle[] = raw.map((e) => ({
    open: e['o']!, high: e['h']!, low: e['l']!, close: e['c']!,
    volume: 1000, time: e['t']! * 1000,
  }));
  const currentPrice = candles[candles.length - 1]!.close;
  const ageMin = (Date.now() / 1000 - raw[raw.length - 1]!['t']!) / 60;

  console.log(`symbol ${symbol} @ ${interval}`);
  console.log(`candles ${candles.length} | price ${currentPrice} | last candle ${ageMin.toFixed(1)} min old`);
  console.log('');

  const clock = systemClock();
  let ok = 0, threw = 0, nonFinite = 0;
  const samples: Record<string, string> = {};

  for (const name of registeredNames()) {
    try {
      const v = computeIndicator(
        candles,
        makeRule({ indicator: name, condition: 'gt', signal: 'CALL', score: 1 }),
        currentPrice,
        clock,
      );
      if (typeof v === 'number' && !Number.isFinite(v)) {
        nonFinite++;
        console.log(`  NON-FINITE: ${name} = ${v}`);
      } else ok++;

      if (SAMPLE.includes(name)) {
        samples[name] = typeof v === 'number' ? v.toFixed(6) : String(v);
      }
    } catch (e) {
      threw++;
      console.log(`  THREW: ${name} — ${(e as Error).message}`);
    }
  }

  console.log(`indicators: ${ok} ok | ${threw} threw | ${nonFinite} non-finite`);
  console.log('');
  console.log('samples:');
  for (const [k, v] of Object.entries(samples)) console.log(`  ${k.padEnd(18)} ${v}`);

  console.log('');
  const score = scoreV2(candles, currentPrice);
  console.log(`V2 score      ${score.toFixed(4)}  →  ${score >= 0 ? 'CALL' : 'PUT'}`);
  console.log(`confidence    ${confidenceFor(Math.abs(score), 92.5, 98.9).toFixed(2)}%`);

  if (threw > 0 || nonFinite > 0) {
    console.log('');
    console.log('FAILED: the live feed produced values the engine cannot handle.');
    process.exitCode = 1;
  }
}

void main().catch((e: unknown) => {
  console.error('live check failed:', (e as Error).message);
  process.exitCode = 1;
});
