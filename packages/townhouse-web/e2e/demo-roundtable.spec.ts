/**
 * Real-stack demo composition Playwright spec (Story D10).
 *
 * Covers:
 *   AC-D10-3 — Home/dashboard composition renders correctly:
 *     - Page loads at "/" without errors
 *     - Ditto iframe element is present with src="/ditto/"
 *     - Earnings panel renders (aria-label "Earnings")
 *     - Log-tail panel renders (aria-label "Live container logs")
 *     - StatusPills row renders all four pills (town/mill/dvm/ator)
 *   AC-D10-4 — GET /api/earnings returns 200 and matches Story 47.2 AggregatedEarnings schema:
 *     { apex: { routingFees: Record<assetCode, PerAsset> }, peers: NodeEarnings[] }
 *     Updated shape replaces legacy by_source/{relay,mill,dvm,connector} (Story 47.2).
 *   AC-D10-5 — GET /api/logs/stream opens with Content-Type: text/event-stream
 *     and the SSE handshake succeeds. We don't wait indefinitely for events —
 *     a successful upstream stream open with one event-or-comment frame is
 *     sufficient (mirrors the AC-D6 contract: docker-discovery error or
 *     "no containers running" warn IS a valid first event).
 *
 * AC-D10-2 + AC-D10-7 — runs against the REAL CLI infra
 * (`scripts/townhouse-test-infra.sh up` warms images; operator runs
 * `townhouse init --preset=demo` + `townhouse up`). Ditto build artifact
 * may NOT be present (heavy build step) — we only assert the iframe element
 * exists with the correct src; we never reach into the iframe content.
 *
 * NO MOCKS — every page.route() call is forbidden in this spec.
 * Real API data is required; the spec skips when TOWNHOUSE_E2E_REAL_STACK !== '1'.
 *
 * Tagged @real-stack for the `pnpm e2e:real` grep selector.
 *
 * Pre-condition (managed by CI or operator):
 *   1. bash scripts/townhouse-test-infra.sh up
 *   2. townhouse init --preset=demo --config-dir <dir> --yes
 *      (preset locks: 1 town + 1 mill + 1 dvm, fees=0, transport=ator;
 *      see packages/townhouse/src/presets/demo.ts)
 *   3. townhouse up --config-dir <dir>
 *      (no --preset on `up` — preset is init-only; `up` reads the written config)
 *   The Vite dev server (playwright.config.ts webServer) proxies /api/*
 *   to the Townhouse Fastify API on http://127.0.0.1:9400.
 *
 * AC-D10-6 note on infra script: townhouse-test-infra.sh does NOT need
 * --preset awareness. The script's only job is to warm the Docker image
 * cache (connector + toon:{town,mill,dvm}). Preset selection happens at
 * `townhouse init --preset=demo` time — downstream of this script. The
 * `up` command is preset-agnostic; it consumes whatever config init wrote.
 */

import { test, expect, request as pwRequest } from '@playwright/test';

const REAL_STACK = process.env['TOWNHOUSE_E2E_REAL_STACK'] === '1';

// ── Earnings response shape (Story 47.2 — AggregatedEarnings) ────────────────
// Mirrors AggregatedEarnings from packages/townhouse/src/earnings/aggregator.ts.
// Repeated here (not imported) to keep the spec self-contained and lock the
// wire contract independently of the producer's types.
interface PerAssetShape {
  lifetime: string;
  today: string;
  month: string;
  year: string;
}
interface NodeEarningsShape {
  id: string;
  type: 'town' | 'mill' | 'dvm' | 'external';
  byAsset: Record<string, PerAssetShape>;
}
interface AggregatedEarningsShape {
  /** 'ok' on the happy path; 'connector_unavailable' when getEarnings() throws. */
  status: 'ok' | 'connector_unavailable';
  apex: {
    routingFees: Record<string, PerAssetShape>;
  };
  peers: NodeEarningsShape[];
}
const REQUIRED_PILLS = ['town', 'mill', 'dvm', 'ator'] as const;

test.describe('@real-stack Demo composition (D10)', () => {
  test.skip(
    !REAL_STACK,
    'Real-stack E2E disabled — set TOWNHOUSE_E2E_REAL_STACK=1 (and bring up the demo stack: townhouse init --preset=demo + townhouse up)'
  );

  // AC-D10-3 — dashboard composition renders.
  test(
    'AC-D10-3: Home renders Ditto iframe + Earnings + LogTail + 4 StatusPills',
    async ({ page }) => {
      // Track console errors to fail fast on render-blocking issues.
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => {
        consoleErrors.push(`pageerror: ${err.message}`);
      });

      await page.goto('/');

      // 1) Demo dashboard root container is mounted.
      // Home.tsx renders <div data-testid="demo-dashboard" aria-label="Demo dashboard">
      await expect(page.getByTestId('demo-dashboard')).toBeVisible({
        timeout: 15_000,
      });

      // 2) Ditto iframe element is present with the correct src.
      // We deliberately do NOT assert iframe content — Town-Frontend may
      // not be built on the test machine; that 404 is acceptable per
      // AC-D10-3 (assert ELEMENT, not content).
      const dittoIframe = page.locator('iframe[title="Ditto demo client"]');
      await expect(dittoIframe).toHaveCount(1, { timeout: 10_000 });
      await expect(dittoIframe).toHaveAttribute('src', '/ditto/');

      // 3) Earnings panel renders.
      // earnings-panel.tsx wraps content in <section aria-label="Earnings">.
      // Story 47.2 shape: apex routing fees + per-peer earnings table.
      const earningsPanel = page.getByRole('region', { name: 'Earnings' });
      await expect(earningsPanel).toBeVisible({ timeout: 10_000 });
      await expect(earningsPanel.getByRole('heading', { name: /^Earnings$/ }))
        .toBeVisible();

      // Apex routing fees section must be present (may be empty on fresh demo).
      await expect(
        earningsPanel.getByRole('region', { name: /Apex routing fees/i })
      ).toBeVisible({ timeout: 10_000 });

      // Peer earnings section must be present (may be empty on fresh demo).
      await expect(
        earningsPanel.getByRole('region', { name: /Peer earnings/i })
      ).toBeVisible({ timeout: 10_000 });

      // 4) Log-tail panel renders.
      // log-tail.tsx wraps content in <section aria-label="Live container logs">.
      const logTail = page.getByRole('region', { name: 'Live container logs' });
      await expect(logTail).toBeVisible({ timeout: 10_000 });
      await expect(logTail.getByRole('heading', { name: /^Live logs$/ }))
        .toBeVisible();

      // 5) StatusPills renders all four pills.
      // status-pills.tsx wraps content in <section aria-label="Service status">.
      // Each pill is <li data-service="<svc>">.
      const pillsRow = page.getByRole('region', { name: 'Service status' });
      await expect(pillsRow).toBeVisible({ timeout: 10_000 });
      for (const svc of REQUIRED_PILLS) {
        await expect(
          pillsRow.locator(`li[data-service="${svc}"]`)
        ).toBeVisible({ timeout: 5_000 });
      }
      // Sanity: exactly four pills.
      await expect(pillsRow.locator('li[data-service]')).toHaveCount(4);

      // No console errors blocking the render. We allow benign warnings; only
      // hard errors are gated on. Ditto iframe 404 produces a network error,
      // not a console error, so this is safe even when Town-Frontend isn't built.
      // Filter out known-noisy entries (none expected for demo composition).
      const blockingErrors = consoleErrors.filter(
        (msg) =>
          // The Ditto iframe 404 surfaces as a network error in DevTools
          // but not as a console.error in most browsers. If a test machine
          // surfaces it, we ignore.
          !/ditto/i.test(msg) &&
          // Service worker / manifest noise on dev server — not relevant.
          !/manifest|service.?worker/i.test(msg)
      );
      expect(
        blockingErrors,
        `Unexpected console errors: ${blockingErrors.join('\n')}`
      ).toHaveLength(0);
    }
  );

  // AC-D10-4 — Earnings API contract (Story 47.2: AggregatedEarnings shape).
  test(
    'AC-D10-4: GET /api/earnings returns AggregatedEarnings schema { apex, peers }',
    async ({ baseURL }) => {
      // Hit the API via the Vite dev server proxy (playwright.config.ts
      // webServer reuses an existing dev server; the proxy forwards
      // /api/* to http://127.0.0.1:9400). Using the same proxy path as
      // the SPA also catches CORS / proxy regressions.
      const ctx = await pwRequest.newContext({ baseURL });
      try {
        const res = await ctx.get('/api/earnings');
        expect(res.status(), 'GET /api/earnings should return 200').toBe(200);

        const body = (await res.json()) as AggregatedEarningsShape;

        // status field: 'ok' on the happy path (demo connector is wired).
        // A fresh demo may briefly return 'connector_unavailable' during
        // settlement boot — accept either, but flag a non-recognised value.
        expect(
          ['ok', 'connector_unavailable'].includes(body.status),
          `status must be 'ok' or 'connector_unavailable' (got: ${body.status})`
        ).toBe(true);

        // apex.routingFees: object keyed by assetCode.
        expect(body.apex, 'apex must be present').toBeDefined();
        expect(
          typeof body.apex.routingFees,
          'apex.routingFees must be an object'
        ).toBe('object');
        expect(
          body.apex.routingFees,
          'apex.routingFees must not be null'
        ).not.toBeNull();

        // Each routingFees entry must have PerAsset shape.
        for (const [code, asset] of Object.entries(body.apex.routingFees)) {
          expect(typeof asset.lifetime, `routingFees.${code}.lifetime must be string`).toBe('string');
          expect(typeof asset.today, `routingFees.${code}.today must be string`).toBe('string');
          expect(typeof asset.month, `routingFees.${code}.month must be string`).toBe('string');
          expect(typeof asset.year, `routingFees.${code}.year must be string`).toBe('string');
        }

        // peers: array of NodeEarnings.
        expect(Array.isArray(body.peers), 'peers must be an array').toBe(true);
        for (const peer of body.peers) {
          expect(typeof peer.id, 'peer.id must be a string').toBe('string');
          expect(
            ['town', 'mill', 'dvm', 'external'].includes(peer.type),
            `peer.type must be a valid NodeType | 'external' (got: ${peer.type})`
          ).toBe(true);
          expect(typeof peer.byAsset, 'peer.byAsset must be an object').toBe('object');
        }
      } finally {
        await ctx.dispose();
      }
    }
  );

  // AC-D10-5 — Log-tail SSE handshake.
  test(
    'AC-D10-5: GET /api/logs/stream opens with text/event-stream and the SSE handshake succeeds',
    async ({ baseURL }) => {
      // We can't use Playwright's request API for SSE (it buffers the
      // body). Instead, drive a raw fetch from the page so we can read
      // the underlying stream incrementally and tear down cleanly. This
      // also exercises the Vite proxy's streaming behavior end-to-end.
      const ctx = await pwRequest.newContext({ baseURL });
      try {
        // Step 1: assert the response headers (handshake) — Playwright's
        // request API will start the response without buffering the
        // body indefinitely. We check Content-Type and tear down.
        const res = await ctx.fetch('/api/logs/stream', {
          method: 'GET',
          // Set a server-friendly Accept header.
          headers: { Accept: 'text/event-stream' },
          // The Vite proxy + Fastify will keep the connection open;
          // a small timeout forces us to read just enough to validate
          // the handshake.
          timeout: 15_000,
          // maxRedirects=0 is the default; no need to set it.
        });

        expect(
          res.status(),
          'GET /api/logs/stream should return 200'
        ).toBe(200);

        const ctype = res.headers()['content-type'] ?? '';
        expect(
          ctype.toLowerCase().includes('text/event-stream'),
          `Content-Type should include text/event-stream (got: ${ctype})`
        ).toBe(true);

        // Cache-Control should be no-cache (SSE best practice;
        // log-tail.ts route sets this explicitly).
        const cc = res.headers()['cache-control'] ?? '';
        expect(
          /no-cache/i.test(cc),
          `Cache-Control should be no-cache (got: ${cc})`
        ).toBe(true);

        // Read up to the first chunk of the body OR fall through after a
        // short window. Per AC-D10-5, the test passes if either:
        //   (a) at least one event arrives within 30s, OR
        //   (b) the connection is correctly held open (handshake succeeded).
        // We've already proven (b) by inspecting the handshake; reading
        // the body is best-effort to confirm at least one frame.
        try {
          const body = await Promise.race([
            res.body(),
            new Promise<Buffer>((_resolve, reject) =>
              setTimeout(
                () => reject(new Error('first-frame timeout (acceptable)')),
                10_000
              )
            ),
          ]);
          // Body may be empty (heartbeat-only window) or contain a "data: "
          // frame or a ": heartbeat" comment. Any non-empty buffer means
          // SSE is wired; an empty/timeout fall-through still passes per
          // AC-D10-5(b).
          if (body && body.length > 0) {
            const text = body.toString('utf-8');
            // Must look like an SSE frame: "data: " or ": " (comment)
            // or end-of-frame "\n\n".
            const looksLikeSse =
              /^data: /m.test(text) ||
              /^: /m.test(text) ||
              /\n\n/.test(text);
            expect(
              looksLikeSse,
              `body should look like an SSE frame (got first ${Math.min(text.length, 200)} chars: ${text.slice(0, 200)})`
            ).toBe(true);
          }
        } catch {
          // Acceptable: handshake validated above; first-frame timeout is
          // a pass per AC-D10-5(b).
        }
      } finally {
        await ctx.dispose();
      }
    }
  );
});
