import { defineConfig } from 'vitest/config';

/**
 * Tests for the app layer. Node environment on purpose — what needs covering
 * here is decision logic (which strategies publish, which are refused), not
 * rendering. Anything that reaches for the DOM or Supabase belongs behind a
 * seam, not behind a fake browser.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
