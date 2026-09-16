import { defineConfig } from 'vitest/config';

/**
 * Node, not the Workers pool. Nothing here touches D1, a socket or a real
 * request: the subject is `decide()` and the schema file, both of which are
 * plain values. Running them on the edge runtime would add a dependency
 * without adding a thing that could be checked.
 */
export default defineConfig({
  test: { globals: true, environment: 'node', include: ['test/**/*.test.ts'] },
});
