/**
 * E2E spec for transport flip flow (AC-19).
 *
 * Covers: Direct→ATOR→unreachable→recovery-to-Direct.
 * All API calls are mocked at the network layer — no real connector restarts.
 * Requires the Vite dev server (`pnpm dev`) listening on port 9401.
 * Optionally: `./scripts/townhouse-dev-infra.sh up` provides a real SOCKS5
 * service at 127.0.0.1:28050 for Task 9.2 manual verification.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const DIRECT_STATUS = {
  mode: 'direct',
  reachable: true,
  latencyProxyMs: null,
  latencyDirectMs: 5,
  lastProbedAt: Date.now(),
  probeError: null,
  ts: Date.now(),
};

const ATOR_OK_STATUS = {
  mode: 'ator',
  socksProxy: 'socks5h://proxy.ator.io:9050',
  reachable: true,
  latencyProxyMs: 120,
  latencyDirectMs: 5,
  lastProbedAt: Date.now(),
  probeError: null,
  ts: Date.now(),
};

const ATOR_DOWN_STATUS = {
  mode: 'ator',
  socksProxy: 'socks5h://proxy.ator.io:9050',
  reachable: false,
  latencyProxyMs: null,
  latencyDirectMs: 5,
  lastProbedAt: Date.now(),
  probeError: 'ECONNREFUSED',
  ts: Date.now(),
};

const NODES_STUB = [
  {
    id: 'town',
    type: 'town',
    enabled: true,
    state: 'running',
    uptimeSeconds: 3600,
    image: 'toon:town',
  },
];

/**
 * Mutable transport scenario — the test mutates `transportScenario.current`
 * to switch what GET /api/transport returns, and registers a single stable
 * route handler. This avoids the unroute/route race during the 5 s polling
 * window where a poll could land on the catch-all 404 fallback.
 */
interface TransportScenario {
  current: object;
  patchAssertions?: (body: unknown) => void;
  patchResponse?: object;
}

async function stubBasicAPIs(page: Page, scenario: TransportScenario) {
  await page.route('**/api/nodes', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(NODES_STUB),
    });
  });
  await page.route('**/api/nodes/town', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...NODES_STUB[0],
        config: { enabled: true, feePerEvent: 1 },
        metrics: {
          packetsForwarded: 5,
          packetsRejected: 0,
          bytesSent: 1024,
          attribution: 'aggregate',
          available: true,
        },
      }),
    });
  });
  await page.route('**/api/wizard/state', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        config_exists: true,
        wallet_exists: true,
        containers_running: true,
        mode: 'normal',
        ts: Date.now(),
      }),
    });
  });
  await page.route('**/api/transport', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      scenario.patchAssertions?.(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          scenario.patchResponse ?? {
            mode: 'direct',
            restartTriggered: true,
            restartedAt: Date.now(),
          }
        ),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...scenario.current,
        lastProbedAt: Date.now(),
        ts: Date.now(),
      }),
    });
  });
  // Catch websocket upgrade or other endpoints
  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{}',
    });
  });
}

test.describe('Transport flip flow', () => {
  test('Direct→ATOR: panel updates, dot reflects reachability, recovery path works', async ({
    page,
  }) => {
    // Single mutable scenario — switching `scenario.current` is observed by
    // the next poll without unroute/route gymnastics.
    const scenario: TransportScenario = {
      current: DIRECT_STATUS,
      patchAssertions: (body) => {
        expect(body).toMatchObject({ mode: 'ator' });
      },
      patchResponse: {
        mode: 'ator',
        socksProxy: 'socks5h://proxy.ator.io:9050',
        restartTriggered: true,
        restartedAt: Date.now(),
      },
    };
    await stubBasicAPIs(page, scenario);
    await page.goto('/settings');

    // Step 1: Direct mode shown
    await expect(page.getByRole('radio', { name: /direct/i })).toBeChecked();
    await expect(page.getByText(/Direct · Reachable/i)).toBeVisible();

    // Step 2: Select ATOR + Save. After PATCH, swap the GET payload to ATOR-OK.
    scenario.current = ATOR_OK_STATUS;
    await page.getByRole('radio', { name: /ator/i }).click();
    await page.getByRole('button', { name: /save/i }).click();

    await expect(page.getByText(/ATOR · Reachable/i)).toBeVisible({
      timeout: 10_000,
    });

    // Step 3: Simulate ATOR becoming unreachable — just swap the scenario.
    scenario.current = ATOR_DOWN_STATUS;

    await expect(page.getByText(/ATOR · Unreachable/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole('button', { name: /switch to direct/i })
    ).toBeVisible();

    // Step 4: Recovery — switch PATCH expectations + GET payload, then click.
    scenario.patchAssertions = (body) => {
      expect(body).toMatchObject({ mode: 'direct' });
    };
    scenario.patchResponse = {
      mode: 'direct',
      restartTriggered: true,
      restartedAt: Date.now(),
    };
    scenario.current = DIRECT_STATUS;

    await page.getByRole('button', { name: /switch to direct/i }).click();

    await expect(page.getByText(/Direct · Reachable/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('Settings link in Home header navigates to /settings', async ({
    page,
  }) => {
    const scenario: TransportScenario = { current: DIRECT_STATUS };
    await stubBasicAPIs(page, scenario);
    await page.goto('/');

    // Wait for Home to render
    await expect(
      page.getByRole('link', { name: /view settings/i })
    ).toBeVisible({ timeout: 5_000 });
    await page.getByRole('link', { name: /view settings/i }).click();

    // Should be on /settings
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByText('Transport')).toBeVisible();
  });
});
