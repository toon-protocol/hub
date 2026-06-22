import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__integration__/**/*.integration.test.ts'],
    // Real `hub up` against local Docker chains (image pulls / HS
    // bootstrap) is slow. Gated by RUN_LIVE_OPERATOR_E2E.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
