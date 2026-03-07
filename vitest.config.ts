import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@crosstown/core/toon': resolve(__dirname, 'packages/core/src/toon/index.ts'),
      '@crosstown/core/nip34': resolve(__dirname, 'packages/core/src/nip34/index.ts'),
      '@crosstown/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@crosstown/relay': resolve(__dirname, 'packages/relay/src/index.ts'),
      '@crosstown/bls': resolve(__dirname, 'packages/bls/src/index.ts'),
      '@crosstown/sdk': resolve(__dirname, 'packages/sdk/src/index.ts'),
      '@crosstown/client': resolve(__dirname, 'packages/client/src/index.ts'),
      '@crosstown/town': resolve(__dirname, 'packages/town/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/__integration__/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.ts',
        '**/__integration__/**',
        '**/index.ts',
      ],
    },
  },
});
