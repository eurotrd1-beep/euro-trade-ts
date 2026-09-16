import { defineConfig } from 'vitest/config';

/**
 * Node environment, not the Workers pool. What needs covering is the fan-out
 * RULES — who may write prices, what a joining socket is handed, when the
 * feeder is told to stop — and those are decisions, not runtime behaviour. The
 * Durable Object API is faked here precisely so the decisions can be driven
 * without a live edge.
 */
export default defineConfig({
  test: { globals: true, environment: 'node', include: ['test/**/*.test.ts'] },
});
