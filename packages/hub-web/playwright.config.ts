import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:9401',
    headless: true,
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:9401',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
