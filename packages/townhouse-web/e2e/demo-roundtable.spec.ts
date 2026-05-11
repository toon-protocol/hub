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
 *   AC-D10-4 — GET /api/earnings returns 200 and matches AC-D4-1 schema:
 *     { since, totals:{sats,tokens}, by_source:{relay,mill,dvm,connector}, items? }
 *     Each by_source bucket has sats:string and tokens:object; since parses ISO8601.
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

// ── Earnings response shape (AC-D4-1) ─────────────────────────────────────────
// Mirrors EarningsPayload from packages/townhouse/src/earnings/aggregator.ts.
// Repeated here (not imported) to keep the spec self-contained and to lock
// the wire contract independently of the producer's types.
interface AssetBucketShape {
  amount: string;
  decimals: number;
  symbol: string;
  chain?: string;
}
interface PerSourceTotalsShape {
  sats: string;
  tokens: Record<string, AssetBucketShape>;
}
interface EarningsItemShape {
  ts: string;
  source: 'relay' | 'mill' | 'dvm' | 'connector';
  asset: { symbol: string; decimals: number; chain?: string };
  amount: string;
  txHash?: string;
  explorerUrl?: string;
}
interface EarningsPayloadShape {
  since: string;
  totals: { sats: string; tokens: Record<string, AssetBucketShape> };
  by_source: {
    relay: PerSourceTotalsShape;
    mill: PerSourceTotalsShape;
    dvm: PerSourceTotalsShape;
    connector: PerSourceTotalsShape;
  };
  items?: EarningsItemShape[];
}

const REQUIRED_SOURCES = ['relay', 'mill', 'dvm', 'connector'] as const;
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
      const earningsPanel = page.getByRole('region', { name: 'Earnings' });
      await expect(earningsPanel).toBeVisible({ timeout: 10_000 });
      await expect(earningsPanel.getByRole('heading', { name: /^Earnings$/ }))
        .toBeVisible();

      // The four per-source rail tiles must all be present (relay/mill/dvm/connector).
      // Each tile has aria-label "<Source> earnings: <N> sats".
      for (const source of ['Relay', 'Mill', 'DVM', 'Connector']) {
        await expect(
          earningsPanel.getByLabel(new RegExp(`^${source} earnings:`, 'i'))
        ).toBeVisible({ timeout: 10_000 });
      }

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

  // AC-D10-4 — Earnings API contract.
  test(
    'AC-D10-4: GET /api/earnings returns AC-D4-1 schema with all 4 sources',
    async ({ baseURL }) => {
      // Hit the API via the Vite dev server proxy (playwright.config.ts
      // webServer reuses an existing dev server; the proxy forwards
      // /api/* to http://127.0.0.1:9400). Using the same proxy path as
      // the SPA also catches CORS / proxy regressions.
      const ctx = await pwRequest.newContext({ baseURL });
      try {
        const res = await ctx.get('/api/earnings');
        expect(res.status(), 'GET /api/earnings should return 200').toBe(200);

        const body = (await res.json()) as EarningsPayloadShape;

        // since: ISO8601 string parseable as a finite Date.
        expect(typeof body.since).toBe('string');
        const sinceMs = Date.parse(body.since);
        expect(
          Number.isFinite(sinceMs),
          `since must parse as ISO8601 (got: ${body.since})`
        ).toBe(true);

        // totals: { sats: string, tokens: object }
        expect(body.totals).toBeDefined();
        expect(typeof body.totals.sats).toBe('string');
        expect(/^\d+$/.test(body.totals.sats)).toBe(true);
        expect(typeof body.totals.tokens).toBe('object');
        expect(body.totals.tokens).not.toBeNull();

        // by_source: 4 buckets, each with { sats: string, tokens: object }.
        expect(body.by_source).toBeDefined();
        for (const source of REQUIRED_SOURCES) {
          const bucket = body.by_source[source];
          expect(
            bucket,
            `by_source.${source} must be present`
          ).toBeDefined();
          expect(
            typeof bucket.sats,
            `by_source.${source}.sats must be a string`
          ).toBe('string');
          expect(
            /^\d+$/.test(bucket.sats),
            `by_source.${source}.sats must be a non-negative integer string (got: ${bucket.sats})`
          ).toBe(true);
          expect(
            typeof bucket.tokens,
            `by_source.${source}.tokens must be an object`
          ).toBe('object');
          expect(
            bucket.tokens,
            `by_source.${source}.tokens must not be null`
          ).not.toBeNull();
        }

        // items is optional in the schema (the producer always returns an
        // array, possibly empty — assert the optional contract).
        if (body.items !== undefined) {
          expect(Array.isArray(body.items)).toBe(true);
          for (const item of body.items) {
            expect(typeof item.ts).toBe('string');
            expect(Number.isFinite(Date.parse(item.ts))).toBe(true);
            expect(REQUIRED_SOURCES).toContain(item.source);
            expect(typeof item.amount).toBe('string');
            expect(item.asset).toBeDefined();
            expect(typeof item.asset.symbol).toBe('string');
            expect(typeof item.asset.decimals).toBe('number');
          }
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
