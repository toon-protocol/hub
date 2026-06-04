/**
 * Local-Docker HS Solana paid-earnings smoke gate (Phase-2 Stage 2c).
 *
 * Sibling of `local-docker-hs-paid-earnings-smoke.test.ts`, for the Solana
 * settlement leg: a `solana:devnet`-denominated publish through the apex should
 * be ACCEPTED by the connector (real on-chain channel + connector-format claim)
 * and credit apex earnings, settling to the apex's Solana recipient ATA.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  STAGE-2 CLIENT GATE — RESOLVED
 * ════════════════════════════════════════════════════════════════════════════
 * The Stage-2 blocker (the toon-client could not produce a settleable Solana
 * claim) is closed across two PRs:
 *
 *   - #105 (Stage 2b): `OnChainChannelClient.openSolanaChannel` now opens a REAL
 *     on-chain channel at the connector-parity PDA
 *     (`[b"channel", min_pubkey, max_pubkey, token_mint]`) and the Solana claim
 *     carries `channelAccount` (the base58 PDA) with the signature over the
 *     connector's 48-byte message — not the old local SHA-256 channel id.
 *
 *   - Stage 2c (this PR): the toon-client ENTRYPOINT negotiates `solana:devnet`
 *     (multi-chain), derives EVM + Solana from a single mnemonic so the funded
 *     account, the channel keypair, and the claim-signing key match, and supplies
 *     the Solana program / token mint / apex recipient.
 *
 * The two source-assertion guards below now verify the RESOLVED state (the
 * client references PDA derivation + emits `channelAccount`). They flip the test
 * to fail loudly if a regression reverts the client to the stub.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Live-loop gating:
 *   E2E_SOLANA=1 RUN_LOCAL_HS_E2E=1 bash scripts/townhouse-e2e-local-hs.sh up --local
 *   RUN_LOCAL_HS_E2E=1 RUN_SOLANA_LOOP=1 NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *     pnpm --filter @toon-protocol/townhouse test:integration -- \
 *     local-docker-hs-solana-paid-earnings-smoke
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { balanceProofHashSolana, base58Encode } from '@toon-protocol/core';

import { isTruthyEnv } from './_test-helpers.js';

// ── Gate ─────────────────────────────────────────────────────────────────────

const RUN_GATE = isTruthyEnv(process.env['RUN_LOCAL_HS_E2E']);
const RUN_SOLANA_LOOP = isTruthyEnv(process.env['RUN_SOLANA_LOOP']);
const SKIP_DOCKER = isTruthyEnv(process.env['SKIP_DOCKER']);
// The live loop is additionally gated by RUN_SOLANA_LOOP because it needs
// E2E_SOLANA=1 infra (apex Solana key + funded ATAs + Solana chainProvider).
const shouldRunLiveLoop = RUN_GATE && RUN_SOLANA_LOOP && !SKIP_DOCKER;

const thisFile = fileURLToPath(import.meta.url);
const REPO_ROOT = join(thisFile, '..', '..', '..', '..', '..');

// ── Constants ────────────────────────────────────────────────────────────────

const EXPECTED_FEE = 1_000_000n; // 1 USDC at scale=6
const TOLERANCE = 10_000n;
const CLIENT_URL = 'http://127.0.0.1:29200';
const EARNINGS_URL = 'http://127.0.0.1:28090/api/earnings';
const CLIENT_CONTAINER = 'toon-client-e2e';

const TOWNHOUSE_HOME =
  process.env['TOWNHOUSE_HOME'] ||
  join(process.env['HOME'] || '/root', '.townhouse-e2e');

// ── Source-assertion guards (always run; no Docker, no infra) ────────────────
//
// These encode the RESOLVED Stage-2 client gate: the client now opens a real
// PDA-backed channel and emits `channelAccount`. They fail loudly on regression.

describe('Stage-2 Solana settlement gate (RESOLVED — client opens real PDA + connector-format claim)', () => {
  const clientChannelSrcPath = join(
    REPO_ROOT,
    'packages',
    'client',
    'src',
    'channel',
    'OnChainChannelClient.ts'
  );
  const clientSignerSrcPath = join(
    REPO_ROOT,
    'packages',
    'client',
    'src',
    'signing',
    'solana-signer.ts'
  );

  it('client openSolanaChannel derives the on-chain PDA (no longer a local SHA-256 stub)', () => {
    if (!existsSync(clientChannelSrcPath)) {
      console.warn(
        `[solana-gate] client source not found at ${clientChannelSrcPath} — skipping source assertion`
      );
      return;
    }
    const src = readFileSync(clientChannelSrcPath, 'utf-8');
    // Resolved witness: openSolanaChannel now opens a real on-chain channel via
    // the connector-parity opener (openSolanaChannelOnChain) rather than hashing
    // a local seed.
    expect(
      src.includes('openSolanaChannelOnChain'),
      'openSolanaChannel should call the on-chain opener (connector-parity PDA). ' +
        'If this fails, the client may have regressed to the SHA-256 stub.'
    ).toBe(true);
  });

  it('client Solana claim carries channelAccount (connector-required PDA)', () => {
    if (!existsSync(clientSignerSrcPath)) {
      console.warn(
        `[solana-gate] client signer source not found at ${clientSignerSrcPath} — skipping source assertion`
      );
      return;
    }
    const src = readFileSync(clientSignerSrcPath, 'utf-8');
    expect(
      src.includes('channelAccount'),
      'client Solana claim builder should emit channelAccount (the base58 PDA the connector verifies against)'
    ).toBe(true);
  });

  it('balanceProofHashSolana is deterministic over (channelId, amount, nonce, recipient) — parity primitive', () => {
    const recipient = base58Encode(new Uint8Array(32).fill(7));
    const h1 = balanceProofHashSolana('0xabc', 1_000_000n, 1n, recipient);
    const h2 = balanceProofHashSolana('0xabc', 1_000_000n, 1n, recipient);
    expect(h1).toEqual(h2);
    expect(h1.length).toBe(32);
    const h3 = balanceProofHashSolana('0xdef', 1_000_000n, 1n, recipient);
    expect(h3).not.toEqual(h1);
  });
});

// ── Helpers (mirrored from the EVM smoke) ────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { budgetMs?: number; label?: string } = {}
): Promise<Response> {
  const { budgetMs = 15_000, label, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(budgetMs) });
  } catch (e) {
    throw new Error(
      `[fetch ${label ?? url}] failed within ${budgetMs}ms: ${(e as Error).message}`
    );
  }
}

async function fetchEarnings(
  label = 'GET /api/earnings'
): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(EARNINGS_URL, { budgetMs: 10_000, label });
  if (!res.ok) throw new Error(`[${label}] HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function normPeerId(s: string): string {
  return s.replace(/^0x/i, '').toLowerCase();
}

// Solana claims credit by the client's Solana pubkey (base58). Match inbound
// claims for that peer with the expected amount within tolerance, since the
// test start.
function findInboundClaimForSolPeer(
  earnings: Record<string, unknown>,
  solPeer: string,
  expectedAmount: bigint,
  tolerance: bigint,
  sinceMs: number
): Record<string, unknown> | null {
  const claims = earnings['recentClaims'] as
    | Record<string, unknown>[]
    | undefined;
  if (!claims) return null;
  const lo = expectedAmount - tolerance;
  const hi = expectedAmount + tolerance;
  for (const c of claims) {
    const cPeer = typeof c['peerId'] === 'string' ? c['peerId'] : '';
    // Solana peer ids are base58 pubkeys; compare case-sensitively but also
    // tolerate a 0x-normalised form just in case the surface lowercases.
    if (cPeer !== solPeer && normPeerId(cPeer) !== normPeerId(solPeer))
      continue;
    if (c['direction'] !== 'inbound') continue;
    const cAmt = typeof c['amount'] === 'string' ? c['amount'] : null;
    if (!cAmt) continue;
    const at = typeof c['at'] === 'string' ? Date.parse(c['at']) : NaN;
    if (!Number.isFinite(at) || at < sinceMs) continue;
    let amt: bigint;
    try {
      amt = BigInt(cAmt);
    } catch {
      continue;
    }
    if (amt >= lo && amt <= hi) return c;
  }
  return null;
}

async function captureLogsOnFailure(
  tag: string,
  data: Record<string, unknown>
): Promise<void> {
  const logDir = join(
    process.cwd(),
    'e2e-local-hs-logs',
    `${Date.now()}-${tag}`
  );
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'data.json'), JSON.stringify(data, null, 2));
    console.log(`[local-hs-solana] failure logs written to ${logDir}`);
  } catch (e) {
    console.warn(
      `[local-hs-solana] captureLogsOnFailure: ${(e as Error).message}`
    );
  }
}

// ── Live Solana loop (gated by RUN_LOCAL_HS_E2E + RUN_SOLANA_LOOP) ───────────

describe.skipIf(!shouldRunLiveLoop)(
  'local-Docker HS Solana paid-earnings smoke (live; requires E2E_SOLANA infra)',
  () => {
    let apexHostname: string;
    let podSolAddr: string;
    let bSecretKey: Uint8Array;
    let testStartMs = Date.now();
    let publishBody: Record<string, unknown> = {};

    beforeAll(async () => {
      const hostJsonPath = join(TOWNHOUSE_HOME, 'host.json');
      if (!existsSync(hostJsonPath)) {
        throw new Error(
          `${hostJsonPath} missing — orchestrator did not bring up apex.\n` +
            `  Run: E2E_SOLANA=1 bash scripts/townhouse-e2e-local-hs.sh up --local`
        );
      }
      const hostJson = JSON.parse(readFileSync(hostJsonPath, 'utf-8')) as {
        hostname: string;
      };
      apexHostname = hostJson.hostname;
      expect(apexHostname).toMatch(/^[a-z2-7]{55,57}\.(anyone|anon)$/);

      // Verify client up + Solana-funded.
      const res = await fetchWithTimeout(`${CLIENT_URL}/healthz`, {
        budgetMs: 5_000,
        label: '/healthz',
      });
      if (!res.ok) throw new Error(`client /healthz HTTP ${res.status}`);
      const healthz = (await res.json()) as {
        anyoneReady: boolean;
        solAddr: string;
        balances: { sol: number };
      };
      if (!healthz.anyoneReady) {
        throw new Error(
          `Client anyoneReady=false. Inspect: docker logs ${CLIENT_CONTAINER} | tail -50`
        );
      }
      podSolAddr = healthz.solAddr;
      expect(podSolAddr.length).toBeGreaterThan(0);
      expect(healthz.balances.sol).toBeGreaterThan(0);
      console.log(`[local-hs-solana] client SOL=${podSolAddr}`);

      bSecretKey = generateSecretKey();
      getPublicKey(bSecretKey); // touch — keeps parity with the EVM smoke
      testStartMs = Date.now();
    }, 120_000);

    it('Solana leg: paid publish ACCEPTED + credits apex earnings within tolerance', async () => {
      expect(podSolAddr).toBeTruthy();
      const sinceMs = testStartMs;

      const event: NostrEvent = finalizeEvent(
        {
          kind: 1,
          content: `local-hs solana smoke @ ${new Date().toISOString()}`,
          tags: [['t', 'local-hs-solana-smoke']],
          created_at: Math.floor(Date.now() / 1000),
        },
        bSecretKey
      );
      const reqBody = { event, targetHostname: apexHostname };

      let publishRes: Response | null = null;
      let publishBodyText = '';
      const publishStart = Date.now();
      const RETRY_BUDGET_MS = 270_000;
      const PER_ATTEMPT_BUDGET_MS = 90_000;

      for (
        let attempt = 1;
        Date.now() - publishStart < RETRY_BUDGET_MS;
        attempt++
      ) {
        const attemptStart = Date.now();
        try {
          publishRes = await fetchWithTimeout(`${CLIENT_URL}/publish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(reqBody),
            budgetMs: PER_ATTEMPT_BUDGET_MS,
            label: `POST /publish (solana) attempt ${attempt}`,
          });
          publishBodyText = await publishRes.text();
          try {
            publishBody = JSON.parse(publishBodyText) as Record<
              string,
              unknown
            >;
          } catch {
            /* keep raw */
          }
          console.log(
            `[local-hs-solana] attempt=${attempt} status=${publishRes.status} ` +
              `body=${publishBodyText.slice(0, 200)}`
          );
          if (publishRes.status === 202) break;
          if (
            publishRes.status >= 400 &&
            publishRes.status < 500 &&
            publishBody['retryable'] !== true
          )
            break;
        } catch (err) {
          console.log(
            `[local-hs-solana] attempt=${attempt} fetch error: ${(err as Error).message}`
          );
          if (Date.now() - attemptStart >= 5_000) break;
        }
        await sleep(5_000);
      }

      if (!publishRes || publishRes.status !== 202) {
        await captureLogsOnFailure('solana-publish-failed', {
          publishBody,
          publishBodyText,
          podSolAddr,
        });
        throw new Error(
          `Solana publish NOT accepted: status=${publishRes?.status}, ` +
            `body=${publishBodyText.slice(0, 300)} — the connector rejected the ` +
            `Solana claim (check channel PDA / signer membership / funding).`
        );
      }

      // Accepted: wire-shape assertions.
      expect(publishBody['eventId']).toBe(event.id);

      // Poll earnings for the inbound Solana credit.
      const pollDeadline = Date.now() + 90_000;
      let postEarnings: Record<string, unknown> | null = null;
      let matchedClaim: Record<string, unknown> | null = null;
      while (Date.now() < pollDeadline) {
        try {
          postEarnings = await fetchEarnings('post-publish (solana)');
          matchedClaim = findInboundClaimForSolPeer(
            postEarnings,
            podSolAddr,
            EXPECTED_FEE,
            TOLERANCE,
            sinceMs
          );
          if (matchedClaim) break;
        } catch (e) {
          console.warn(
            `[local-hs-solana] earnings fetch failed: ${(e as Error).message}`
          );
        }
        await sleep(3_000);
      }

      if (!matchedClaim) {
        await captureLogsOnFailure('solana-credit-not-found', {
          publishBody,
          postEarnings,
          podSolAddr,
          expectedFee: EXPECTED_FEE.toString(),
        });
        throw new Error(
          `Solana publish ACCEPTED (202) but no inbound credit found for ` +
            `peer=${podSolAddr} amount≈${EXPECTED_FEE}±${TOLERANCE} after ${sinceMs}. ` +
            `recentClaims: ${JSON.stringify(postEarnings?.['recentClaims']).slice(0, 500)}`
        );
      }

      const matchedAmount = BigInt(matchedClaim['amount'] as string);
      expect(matchedAmount).toBeGreaterThanOrEqual(EXPECTED_FEE - TOLERANCE);
      expect(matchedAmount).toBeLessThanOrEqual(EXPECTED_FEE + TOLERANCE);
      expect(matchedClaim['direction']).toBe('inbound');
      console.log(
        `[local-hs-solana] SOLANA CREDIT LANDED: ${JSON.stringify(matchedClaim).slice(0, 300)}`
      );
    }, 420_000);
  }
);
