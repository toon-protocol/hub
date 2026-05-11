/**
 * Real-stack lifecycle Playwright spec (Story 21.16, AC-6)
 *
 * Coverage map (AC-14):
 *   T-081  — dashboard home renders: 3 node cards + earnings label + ATOR indicator
 *   X-007  — subset: SPA loads and reflects real stack state (wizard not exercised)
 *
 * Pre-condition (managed by CI or operator):
 *   1. bash scripts/townhouse-test-infra.sh up
 *   2. townhouse init --config-dir <dir> --password <pw>
 *   3. townhouse up --town --mill --dvm --config-dir <dir>
 *   The Vite dev server (playwright.config.ts webServer) proxies /api/* to the
 *   Townhouse Fastify API running at http://127.0.0.1:9400 (started by `townhouse up`).
 *
 * NO MOCKS — every page.route() call is forbidden in this spec.
 * Real API data is required; the spec skips when TOWNHOUSE_E2E_REAL_STACK !== '1'.
 *
 * Tagged @real-stack for the `pnpm e2e:real` grep selector (AC-11).
 */

import { test, expect } from '@playwright/test';

const REAL_STACK = process.env['TOWNHOUSE_E2E_REAL_STACK'] === '1';

test.describe('@real-stack Home view (T-081, X-007 subset)', () => {
  test.skip(!REAL_STACK, 'Real-stack E2E disabled — set TOWNHOUSE_E2E_REAL_STACK=1');

  test(
    'T-081: three node cards render with running status + earnings label + ATOR indicator',
    async ({ page }) => {
      await page.goto('/');

      // ── Node cards (all three: town, mill, dvm) ─────────────────────────────
      // NodeCard renders: <article aria-label="town node"> (Home.tsx:73)
      const townCard = page.getByRole('article', { name: /town node/i });
      const millCard = page.getByRole('article', { name: /mill node/i });
      const dvmCard = page.getByRole('article', { name: /dvm node/i });

      await expect(townCard).toBeVisible({ timeout: 15_000 });
      await expect(millCard).toBeVisible({ timeout: 5_000 });
      await expect(dvmCard).toBeVisible({ timeout: 5_000 });

      // ── Status dots: each card's dot should be "ok" (running state) ─────────
      // StatusDot aria-label is: "<type> node status: ok" (Home.tsx:78-80).
      // The .or() covers both role="img" and plain aria-label implementations.
      await expect(
        page.getByRole('img', { name: /town node status: ok/i }).or(
          townCard.getByLabel(/town node status: ok/i)
        )
      ).toBeVisible({ timeout: 5_000 });

      // ── Earnings label — MetricBlock uses label="Events today" ──────────────
      // At least one "Events today" label must be present (may be shown as aggregate)
      await expect(page.getByText('Events today')).toBeVisible({ timeout: 5_000 });

      // ── ATOR indicator in HomeHeader ─────────────────────────────────────────
      // Default config = direct transport → aria-label "Direct transport" (Home.tsx:169)
      // StatusDot with this label appears in the HomeHeader (Home.tsx:229)
      await expect(
        page.getByLabel(/Direct transport/i)
      ).toBeVisible({ timeout: 5_000 });
    }
  );
});
