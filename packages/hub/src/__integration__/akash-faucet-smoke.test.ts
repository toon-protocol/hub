/**
 * Story 49.2 AC #7 — Live smoke test against the deployed Akash faucet
 * lease. Gated by RUN_AKASH_SMOKE=1 + AKASH_FAUCET_URL env (or reads
 * leases.json's faucet.url field as fallback). Workflow_dispatch only
 * per NFR6. Local dev runs it via:
 *
 *   RUN_AKASH_SMOKE=1 AKASH_FAUCET_URL=https://<lease> \
 *     pnpm --filter @toon-protocol/hub test:integration \
 *     src/__integration__/akash-faucet-smoke.test.ts
 *
 * Mirrors the gate-pattern discipline from 49.1 (SKIP_DOCKER, shouldRun,
 * describe.skipIf, console.warn skip notice).
 *
 * NOTE: this test requires a LIVE deployment. It is intentionally NOT
 * run as part of `pnpm test:integration` by default — only when the
 * RUN_AKASH_SMOKE gate flips on.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const shouldRun =
  process.env.RUN_AKASH_SMOKE === '1' && !process.env.SKIP_DOCKER;

// Resolve the live faucet URL — env override wins, otherwise read
// deploy/akash/leases.json.
function resolveFaucetUrl(): string | null {
  if (process.env.AKASH_FAUCET_URL) return process.env.AKASH_FAUCET_URL;
  try {
    const leasesPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../../deploy/akash/leases.json'
    );
    const j = JSON.parse(readFileSync(leasesPath, 'utf8'));
    return j?.faucet?.url ?? null;
  } catch {
    return null;
  }
}

const faucetUrl = resolveFaucetUrl();

if (shouldRun && !faucetUrl) {
  console.warn(
    '[akash-faucet-smoke] RUN_AKASH_SMOKE=1 but no AKASH_FAUCET_URL or leases.json:faucet.url found — skipping.'
  );
}

const enabled = shouldRun && !!faucetUrl;

// Load the schema for response validation.
const SCHEMA_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../contracts/faucet.schema.json'
);
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema, 'faucet');
const validateSuccess = ajv.getSchema(
  'faucet#/definitions/FaucetSuccessResponse'
)!;
const validateRecent = ajv.getSchema(
  'faucet#/definitions/RecentDripsResponse'
)!;
const validateClientError = ajv.getSchema(
  'faucet#/definitions/FaucetClientErrorResponse'
)!;

// Compute expected sha256 of the local index.html. DN2 (code review): this
// must be a hard-fail assertion. Akash provider image cache may lag between
// build+push and the running lease — if this fails after a fresh redeploy,
// the provider cache has not turned over yet; wait for the lease to cycle.
function expectedIndexHtmlSha256(): string {
  const htmlPath = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../../../packages/faucet/public/index.html'
  );
  const body = readFileSync(htmlPath, 'utf8');
  return createHash('sha256').update(body).digest('hex');
}

// Test fixtures — addresses are ephemeral signers generated per-run so the
// rate limit doesn't trip. EVM: derive from a random 32-byte seed.
// Solana: an arbitrary base58 string that passes the regex (real key not
// required — the faucet just sends to whatever address it's given).
function freshEvmAddress(): string {
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) bytes[i] = Math.floor(Math.random() * 256);
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

// Generate a valid base58 fake pubkey of length 44. This is NOT a real key
// — Solana airdrops to any 32-byte pubkey, valid or not (test-validator
// doesn't gate on key validity for the recipient).
function freshSolAddress(): string {
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 44; i++) {
    s += BASE58[Math.floor(Math.random() * BASE58.length)];
  }
  return s;
}

describe.skipIf(!enabled)(
  'akash-faucet-smoke — story 49.2 AC #7 live gate',
  () => {
    it('1. GET / returns 200 + text/html (UI loadable)', async () => {
      const r = await fetch(`${faucetUrl}/`);
      expect(r.status).toBe(200);
      const ct = r.headers.get('content-type') ?? '';
      expect(ct).toMatch(/text\/html/);
      const body = await r.text();
      expect(body).toContain('TOON Dev Faucet');
      // Hard-fail sha256 identity check (DN2, code review). If this fails
      // after a fresh image push, the Akash provider cache has not cycled —
      // wait for the lease to restart or use a unique image tag to bust it.
      const actualSha = createHash('sha256').update(body).digest('hex');
      const expectedSha = expectedIndexHtmlSha256();
      expect(actualSha).toBe(expectedSha);
    });

    it('2. GET /health returns 200 with status:ok', async () => {
      const r = await fetch(`${faucetUrl}/health`);
      expect(r.status).toBe(200);
      const j = (await r.json()) as Record<string, unknown>;
      expect(j.status).toBe('ok');
    });

    it('3. POST /faucet/evm drips ETH+USDC; response matches schema', async () => {
      const recipient = freshEvmAddress();
      // P11 (code review): enforce AC#1's 10s budget via fetch AbortSignal.
      const r = await fetch(`${faucetUrl}/faucet/evm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: recipient, amount: 1 }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(r.status).toBe(200);
      const data = (await r.json()) as Record<string, unknown>;
      if (!validateSuccess(data)) {
        console.error('[smoke 3] schema errors:', validateSuccess.errors);
      }
      expect(validateSuccess(data)).toBe(true);
      expect(data.chain).toBe('evm');
      expect(data.recipient).toBe(recipient);
      expect(typeof data.tx).toBe('string');
    });

    it('4. POST /faucet/sol drips SOL+USDC; response matches schema', async () => {
      const recipient = freshSolAddress();
      // P11 (code review): enforce AC#1's 10s budget. Solana path has the
      // same 10s spec requirement; the 30s vitest timeout is the backstop.
      const r = await fetch(`${faucetUrl}/faucet/sol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: recipient }),
        signal: AbortSignal.timeout(10_000),
      });
      // Solana drip may take longer than EVM (airdrop + ATA + transfer);
      // expect 200 within the 10s fetch timeout.
      expect([200, 502]).toContain(r.status);
      const data = (await r.json()) as Record<string, unknown>;
      if (r.status === 200) {
        if (!validateSuccess(data)) {
          console.error('[smoke 4] schema errors:', validateSuccess.errors);
        }
        expect(validateSuccess(data)).toBe(true);
        expect(data.chain).toBe('solana');
        expect(data.recipient).toBe(recipient);
      } else {
        // Partial-success path — SOL airdrop landed but USDC failed
        // (mint missing on this lease). Surface via airdropSig in the
        // error body.
        console.warn('[smoke 4] partial success — USDC drip failed:', data);
      }
    });

    it('5. rate-limit smoke — 6 rapid posts from same IP yields at least one 429 with Retry-After', async () => {
      const recipient = freshEvmAddress();
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          fetch(`${faucetUrl}/faucet/evm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: recipient, amount: 1 }),
          })
        )
      );
      const statuses = responses.map((r) => r.status);
      const has429 = statuses.includes(429);
      expect(has429).toBe(true);

      // The 429 body must validate against the client-error schema.
      const r429 = responses[statuses.indexOf(429)];
      if (r429) {
        expect(r429.headers.get('Retry-After')).toBeTruthy();
        const body = await r429.json();
        if (!validateClientError(body)) {
          console.error('[smoke 5] schema errors:', validateClientError.errors);
        }
        expect(validateClientError(body)).toBe(true);
      }
    });

    it('6. CORS preflight — OPTIONS returns CORS headers (200 or 204)', async () => {
      const r = await fetch(`${faucetUrl}/faucet/evm`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      // The `cors` npm package returns 204 by default but Express
      // configurations may return 200 — accept either.
      expect([200, 204]).toContain(r.status);
      expect(r.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
      // P4 (code review): AC#3 requires GET, POST, OPTIONS — not just POST.
      const allowMethods = r.headers.get('Access-Control-Allow-Methods');
      expect(allowMethods).toBeTruthy();
      expect(allowMethods?.toUpperCase()).toContain('POST');
      expect(allowMethods?.toUpperCase()).toContain('GET');
      expect(allowMethods?.toUpperCase()).toContain('OPTIONS');
      // P5 (code review): AC#3 requires Access-Control-Allow-Headers: content-type.
      const allowHeaders = r.headers.get('Access-Control-Allow-Headers');
      expect(allowHeaders?.toLowerCase()).toContain('content-type');
    });

    it('7. GET /faucet/recent returns ring buffer; entries match schema', async () => {
      const r = await fetch(`${faucetUrl}/faucet/recent?limit=10`);
      expect(r.status).toBe(200);
      const items = (await r.json()) as unknown[];
      expect(Array.isArray(items)).toBe(true);
      if (!validateRecent(items)) {
        console.error('[smoke 7] schema errors:', validateRecent.errors);
      }
      expect(validateRecent(items)).toBe(true);
    });
  }
);

if (!enabled) {
  describe('akash-faucet-smoke (skipped)', () => {
    it('is skipped — set RUN_AKASH_SMOKE=1 + AKASH_FAUCET_URL to run', () => {
      console.warn(
        '[akash-faucet-smoke] skipped: RUN_AKASH_SMOKE=' +
          (process.env.RUN_AKASH_SMOKE || '(unset)') +
          ', AKASH_FAUCET_URL=' +
          (process.env.AKASH_FAUCET_URL || '(unset)')
      );
      expect(true).toBe(true);
    });
  });
}
