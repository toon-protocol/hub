/**
 * Mock-driven config-change Playwright spec (Story 21.16, AC-7)
 *
 * Coverage map (AC-14):
 *   T-082  — fee change via Town write-fee slider → Apply → success confirmation
 *   X-003  — SPA half: slider → PATCH /api/nodes/town/config → "Updated." feedback
 *
 * All API calls are mocked via page.route(). The real-restart path
 * (end-to-end connector restart) is covered by townhouse-config-propagation.test.ts.
 *
 * This spec verifies the SPA's user-facing behavior:
 *   - Town management view renders with a fee slider
 *   - Dragging the slider and clicking Apply sends a PATCH with the new fee
 *   - The SPA displays "Updated." confirmation after a successful PATCH
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// ── Shared API stubs ──────────────────────────────────────────────────────────

const TOWN_NODE_STUB = {
  id: 'town',
  type: 'town',
  enabled: true,
  state: 'running',
  uptimeSeconds: 3600,
  image: 'toon:town',
};

interface TownDetailStub {
  currentFee: number;
  patchAssertions?: (body: unknown) => void;
}

async function stubTownAPIs(page: Page, stub: TownDetailStub) {
  // Wizard state — initialized
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

  // Transport status — direct
  await page.route('**/api/transport', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'direct',
        reachable: true,
        latencyProxyMs: null,
        latencyDirectMs: 5,
        lastProbedAt: Date.now(),
        probeError: null,
        ts: Date.now(),
      }),
    });
  });

  // Node list
  await page.route('**/api/nodes', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([TOWN_NODE_STUB]),
    });
  });

  // Node detail + bandwidth (useNodeMetrics polls these)
  await page.route('**/api/nodes/town/bandwidth', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ bytesSent: 0, bytesReceived: 0, ts: Date.now() }),
    });
  });

  await page.route('**/api/nodes/town', async (route) => {
    if (route.request().method() === 'PATCH') {
      // Delegate to the PATCH handler below
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...TOWN_NODE_STUB,
        config: { enabled: true, feePerEvent: stub.currentFee },
        metrics: {
          packetsForwarded: 0,
          packetsRejected: 0,
          bytesSent: 0,
          attribution: 'per-peer',
          available: true,
        },
      }),
    });
  });

  // PATCH /api/nodes/town/config
  await page.route('**/api/nodes/town/config', async (route) => {
    const body = route.request().postDataJSON();
    stub.patchAssertions?.(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true, feePerEvent: body?.feePerEvent ?? stub.currentFee }),
    });
  });

  // Relay event stream (EventFeed uses SSE/WS — stub as empty 404 to prevent noise)
  await page.route('**/api/nodes/town/relay-events', async (route) => {
    await route.fulfill({ status: 404, body: '{}' });
  });

  // Timeseries (usePacketTimeseries)
  await page.route('**/api/nodes/town/timeseries', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  // WebSocket upgrade + misc — catch-all (must be last)
  await page.route('**/api/**', async (route) => {
    if (route.request().method() !== 'GET' && route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

// ── Test ──────────────────────────────────────────────────────────────────────

test.describe('Town write-fee config change (T-082, X-003 SPA half)', () => {
  test(
    'T-082 / X-003: slider → Apply → PATCH sent with new fee → "Updated." shown',
    async ({ page }) => {
      let capturedPatchBody: unknown;

      const stub: TownDetailStub = {
        currentFee: 0,
        patchAssertions: (body) => {
          capturedPatchBody = body;
        },
      };

      await stubTownAPIs(page, stub);
      await page.goto('/town');

      // ── Wait for the Town card to render ─────────────────────────────────────
      // TownCard: <article aria-label="town town node">
      const townCard = page.getByRole('article', { name: /town node/i });
      await expect(townCard).toBeVisible({ timeout: 10_000 });

      // ── Locate the fee slider ─────────────────────────────────────────────────
      // FeeSlider renders: <Input aria-label="Write fee for town (0–10000 sats)">
      // HTML range input has role="slider" in ARIA
      const slider = page.getByRole('slider', {
        name: /Write fee for town/i,
      });
      await expect(slider).toBeVisible({ timeout: 5_000 });

      // ── Change the slider value via evaluate ──────────────────────────────────
      // Playwright's fill() on range inputs sets the value but doesn't fire
      // the React synthetic onChange. We set value + dispatch input + change events.
      const TARGET_FEE = 500;
      await slider.evaluate((el, value) => {
        const input = el as HTMLInputElement;
        const nativeInputSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )?.set;
        nativeInputSetter?.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, TARGET_FEE);

      // The fee display span should show the new value
      await expect(page.getByText(`${TARGET_FEE} sats`)).toBeVisible({
        timeout: 3_000,
      });

      // ── Click Apply ──────────────────────────────────────────────────────────
      const applyButton = townCard.getByRole('button', { name: /apply/i });
      await expect(applyButton).toBeEnabled({ timeout: 3_000 });
      await applyButton.click();

      // ── Assert success feedback ───────────────────────────────────────────────
      // FeeSlider shows "Updated." after onApply resolves successfully
      await expect(page.getByText('Updated.')).toBeVisible({ timeout: 5_000 });

      // ── Assert PATCH was sent with correct body ───────────────────────────────
      expect(capturedPatchBody, 'PATCH body should contain feePerEvent').toMatchObject({
        feePerEvent: TARGET_FEE,
      });
    }
  );
});
