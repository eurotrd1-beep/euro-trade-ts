import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the app layer. Node environment on purpose — what needs covering
 * here is decision logic (which strategies publish, which are refused), not
 * rendering. Anything that reaches for the DOM or Supabase belongs behind a
 * seam, not behind a fake browser.
 */
export default defineConfig({
  // `@/` is what the app itself imports by, via tsconfig paths. Vitest reads
  // neither Next's config nor those paths, so without this a test can only
  // reach app code by relative path — and the first one that tried failed to
  // resolve rather than falling back.
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
