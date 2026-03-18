import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@toon-protocol/core/toon': resolve(__dirname, 'packages/core/src/toon/index.ts'),
      '@toon-protocol/core/nip34': resolve(__dirname, 'packages/core/src/nip34/index.ts'),
      '@toon-protocol/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@toon-protocol/relay': resolve(__dirname, 'packages/relay/src/index.ts'),
      '@toon-protocol/bls': resolve(__dirname, 'packages/bls/src/index.ts'),
      '@toon-protocol/sdk': resolve(__dirname, 'packages/sdk/src/index.ts'),
      '@toon-protocol/client': resolve(__dirname, 'packages/client/src/index.ts'),
      '@toon-protocol/town': resolve(__dirname, 'packages/town/src/index.ts'),
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
