import { defineConfig } from 'vitest/config';

/**
 * The parity run, kept OUT of `npm test` on purpose.
 *
 * It reads the live Postgres — every signal, every aggregate row — and needs a
 * service key and a network. A suite that cannot run without those is a suite
 * that gets skipped in CI, and a skipped test reads exactly like a passing one
 * on the summary line.
 *
 * So it is a separate command, run deliberately, before the port is trusted:
 *
 *   npm run parity            (in apps/data-hub)
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['parity/**/*.test.ts'],
    // One real database, many rows; the default 5s is not enough.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
