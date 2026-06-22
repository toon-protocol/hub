import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for integration tests (Story 21.3).
 *
 * Requires real Docker daemon. Only run when RUN_DOCKER_INTEGRATION=1.
 * Timeout set to 120s to account for container startup times.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__integration__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
