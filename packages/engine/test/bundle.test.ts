/**
 * The guard on the vendored engine bundle.
 *
 * `euro-trade-proxy/engine.bundle.js` is a compiled copy of this package, and a
 * compiled copy goes stale in silence: the generator keeps scoring signals with
 * whatever rules were current the last time somebody remembered to rebuild, and
 * nothing anywhere says so. The statistics it writes would then describe an
 * engine that no longer exists.
 *
 * So the fingerprint of the engine source is committed, and this fails the
 * build the moment the source moves past it. It runs in CI as part of the
 * engine suite, which is already the gate on deploying.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCK_PATH, STAMP_PREFIX, engineSourceHash } from '../../../scripts/engine-source-hash.mjs';

/** Where the proxy checkout normally sits, relative to this repo. */
const PROXY_BUNDLE = '../euro-trade-proxy/engine.bundle.js';

const REBUILD = 'node scripts/build-engine-bundle.mjs';

describe('vendored engine bundle', () => {
  const actual = engineSourceHash();

  it('has a lock file to compare against', () => {
    expect(
      existsSync(LOCK_PATH),
      `${LOCK_PATH} مش موجود — شغّل ${REBUILD}`,
    ).toBe(true);
  });

  it('matches the engine source it was built from', () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as { sourceHash: string };
    expect(
      lock.sourceHash,
      `\n\n  engine.bundle.js قديم — شغّل ${REBUILD}\n\n` +
        `  المحرك اتغيّر بعد آخر مرة اتبنى فيها الـ bundle، والمولّد في البروكسي\n` +
        `  لسه شغّال بالقواعد القديمة. بعد ما تشغّل الأمر، اعمل commit للاتنين:\n` +
        `    • euro_trade_ts/${LOCK_PATH}\n` +
        `    • euro-trade-proxy/engine.bundle.js\n\n` +
        `  المتوقّع ${actual.slice(0, 16)}…  المسجّل ${lock.sourceHash.slice(0, 16)}…\n`,
    ).toBe(actual);
  });

  /**
   * Only runs where the sibling checkout exists — CI has one repo. The lock
   * check above is the gate; this one catches the other half of the mistake,
   * rebuilding but forgetting to commit the bundle in the proxy repo.
   */
  it.runIf(existsSync(PROXY_BUNDLE))(
    'the committed copy in euro-trade-proxy carries the same stamp',
    () => {
      const head = readFileSync(PROXY_BUNDLE, 'utf8').slice(0, 400);
      const stamped = new RegExp(`${STAMP_PREFIX}([0-9a-f]{64})`).exec(head)?.[1];
      expect(
        stamped,
        `\n\n  الـ bundle في euro-trade-proxy مش متسجّل ببصمة — شغّل ${REBUILD}\n`,
      ).toBeDefined();
      expect(
        stamped,
        `\n\n  الـ bundle في euro-trade-proxy قديم — شغّل ${REBUILD} واعمل له commit\n`,
      ).toBe(actual);
    },
  );
});
