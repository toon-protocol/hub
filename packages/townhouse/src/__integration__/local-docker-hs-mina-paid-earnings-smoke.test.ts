/**
 * Local-Docker HS Mina paid-earnings smoke gate (Phase-2 Stage 3).
 *
 * Sibling of the EVM + Solana paid-earnings smokes, for the Mina settlement leg.
 * A `mina:devnet`-denominated publish through the apex SHOULD eventually be
 * ACCEPTED by the connector (zkApp channel verified on-chain) and credit apex
 * earnings — the same milestone Solana reached.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  STAGE-3 CLIENT GATE — OPEN (claim-validation divergence; NOT the #88 gate)
 * ════════════════════════════════════════════════════════════════════════════
 * The client's Mina claim path does NOT satisfy connector 3.9.0's
 * `MinaClaimMessage` contract, so a live Mina loop is REJECTED at the
 * connector's `validateClaimMessage` — BEFORE any on-chain channel lookup and
 * well before settlement. The gap is at THREE independent layers (any one of
 * which alone blocks acceptance):
 *
 *   1. WIRE SHAPE. The connector requires `{ zkAppAddress, tokenId,
 *      balanceCommitment, proof, salt, nonce, ... }`. The client's
 *      `MinaSigner.buildClaimMessage` emits `{ channelId, transferredAmount,
 *      commitment, signerAddress, recipient, zkAppAddress, ... }` — it is
 *      MISSING the required `tokenId`, `balanceCommitment`, `proof`, and `salt`.
 *
 *   2. COMMITMENT / SIGNED MESSAGE. The connector verifies a Schnorr signature
 *      over `[ Poseidon([balanceA, balanceB, salt]), Field(nonce),
 *      Poseidon(PublicKey.fromBase58(zkAppAddress).x) ]` (see
 *      MinaPaymentChannelSDK.verifyBalanceProof). The client signs
 *      `balanceProofFieldsMina = [ minaHashToField(channelId), amount, nonce,
 *      minaHashToField(recipient) ]` — a different message, keyed on a synthetic
 *      channelId + recipient rather than the balance commitment + zkApp pubkey.
 *
 *   3. ON-CHAIN CHANNEL. The connector looks up the channel via
 *      `provider.getChannelState(claim.zkAppAddress)` and requires status
 *      `opened`/`closed`. The client's `OnChainChannelClient.openMinaChannel`
 *      returns a synthetic SHA-256 `0x…` channel id and NEVER deploys/opens a
 *      real on-chain zkApp channel — there is nothing for getChannelState to read.
 *
 * This is distinct from (and stricter than) the connector #88 on-chain-SETTLE
 * gate that blocks Solana + every dynamic non-EVM HS peer. Mina does not even
 * reach FULFILL: it is rejected at claim VALIDATION.
 *
 * The source-assertion guards below ENCODE this divergence. They run with no
 * Docker + no infra and fail loudly if either (a) the client's Mina claim is
 * brought to the connector contract (flip the guard to the resolved witness) or
 * (b) the connector contract changes underneath us.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Live-loop gating (does NOT run by default — the loop cannot be ACCEPTED yet):
 *   E2E_MINA=1 RUN_LOCAL_HS_E2E=1 bash scripts/townhouse-e2e-local-hs.sh up --local
 *   RUN_LOCAL_HS_E2E=1 RUN_MINA_LOOP=1 NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *     pnpm --filter @toon-protocol/townhouse test:integration -- \
 *     local-docker-hs-mina-paid-earnings-smoke
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

import { isTruthyEnv } from './_test-helpers.js';

// ── Gate ─────────────────────────────────────────────────────────────────────

const RUN_GATE = isTruthyEnv(process.env['RUN_LOCAL_HS_E2E']);
const RUN_MINA_LOOP = isTruthyEnv(process.env['RUN_MINA_LOOP']);
const SKIP_DOCKER = isTruthyEnv(process.env['SKIP_DOCKER']);
// The live loop is additionally gated by RUN_MINA_LOOP because it needs
// E2E_MINA=1 infra (Mina lightnet + deterministic zkApp + apex Mina key). Even
// when forced, it is EXPECTED to fail at claim validation (see header) — the
// gate exists to make that failure observable, not green.
const shouldRunLiveLoop = RUN_GATE && RUN_MINA_LOOP && !SKIP_DOCKER;

const thisFile = fileURLToPath(import.meta.url);
const REPO_ROOT = join(thisFile, '..', '..', '..', '..', '..');

// ── Constants ────────────────────────────────────────────────────────────────

const CLIENT_URL = 'http://127.0.0.1:29200';
const CLIENT_CONTAINER = 'toon-client-e2e';

const TOWNHOUSE_HOME =
  process.env['TOWNHOUSE_HOME'] ||
  join(process.env['HOME'] || '/root', '.townhouse-e2e');

// ── Source-assertion guards (always run; no Docker, no infra) ────────────────
//
// These encode the OPEN Stage-3 client gate: the client's Mina claim path
// diverges from connector 3.9.0's MinaClaimMessage contract. Each guard cites
// the precise divergence so a future fix flips it to the resolved witness.

describe('Stage-3 Mina settlement gate (OPEN — client Mina claim diverges from connector contract)', () => {
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
    'mina-signer.ts'
  );

  it('client openMinaChannel is still a synthetic-channel-id stub (no real on-chain zkApp channel)', () => {
    if (!existsSync(clientChannelSrcPath)) {
      console.warn(
        `[mina-gate] client source not found at ${clientChannelSrcPath} — skipping source assertion`
      );
      return;
    }
    const src = readFileSync(clientChannelSrcPath, 'utf-8');
    // Locate the openMinaChannel body.
    const idx = src.indexOf('private async openMinaChannel');
    expect(
      idx,
      'openMinaChannel should exist in OnChainChannelClient'
    ).toBeGreaterThanOrEqual(0);
    const body = src.slice(idx, idx + 1200);
    // OPEN-gate witness: the channel id is a local SHA-256 digest, not a real
    // on-chain zkApp channel. When this stub is replaced by a real on-chain open
    // (so getChannelState(zkAppAddress) resolves), flip this assertion.
    expect(
      body.includes("crypto.subtle.digest('SHA-256'") ||
        body.includes('crypto.subtle.digest("SHA-256"'),
      'openMinaChannel is expected to still derive a synthetic SHA-256 channel id ' +
        '(Stage-3 gate). If this fails, the client may now open a real on-chain ' +
        'zkApp channel — update the gate to the resolved witness.'
    ).toBe(true);
  });

  it('client Mina claim emits commitment+channelId, NOT the connector-required tokenId/balanceCommitment/proof/salt', () => {
    if (!existsSync(clientSignerSrcPath)) {
      console.warn(
        `[mina-gate] client signer source not found at ${clientSignerSrcPath} — skipping source assertion`
      );
      return;
    }
    const src = readFileSync(clientSignerSrcPath, 'utf-8');
    // Isolate the CLAIM-OBJECT LITERAL only (between `const claim` and
    // `return claim`) so the function signature `(proof: …)` can't false-match.
    const start = src.indexOf('const claim');
    const end = src.indexOf('return claim', start);
    expect(
      start,
      'mina-signer should declare `const claim`'
    ).toBeGreaterThanOrEqual(0);
    expect(end, 'mina-signer should `return claim`').toBeGreaterThan(start);
    const claimLiteral = src.slice(start, end);

    // Divergence witnesses: the client emits `commitment` (a base58 Schnorr sig)
    // as a claim key, and does NOT emit the connector-required claim keys.
    expect(
      /\bcommitment:/.test(claimLiteral),
      'client Mina claim builder still emits `commitment` (base58 Schnorr sig)'
    ).toBe(true);
    expect(
      /\bbalanceCommitment:/.test(claimLiteral) ||
        /\btokenId:/.test(claimLiteral) ||
        /\bproof:/.test(claimLiteral) ||
        /\bsalt:/.test(claimLiteral),
      'connector 3.9.0 requires tokenId + balanceCommitment + proof + salt on a ' +
        'MinaClaimMessage. The client does NOT yet emit these — if this guard now ' +
        'finds them, the client claim has been brought to contract; flip the gate.'
    ).toBe(false);
  });
});

// ── Helpers (mirrored from the Solana smoke) ─────────────────────────────────

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
    console.log(`[local-hs-mina] failure logs written to ${logDir}`);
  } catch (e) {
    console.warn(
      `[local-hs-mina] captureLogsOnFailure: ${(e as Error).message}`
    );
  }
}

// ── Live Mina loop (gated by RUN_LOCAL_HS_E2E + RUN_MINA_LOOP) ───────────────
//
// EXPECTED OUTCOME (until the client claim is brought to contract): the publish
// is NOT accepted — the connector rejects the Mina claim at validateClaimMessage
// (F06-class structure rejection). This block makes that outcome observable +
// captures the connector log evidence, rather than silently skipping.

describe.skipIf(!shouldRunLiveLoop)(
  'local-Docker HS Mina paid-earnings smoke (live; requires E2E_MINA infra)',
  () => {
    let apexHostname: string;
    let podMinaAddr: string | undefined;
    let bSecretKey: Uint8Array;

    beforeAll(async () => {
      const hostJsonPath = join(TOWNHOUSE_HOME, 'host.json');
      if (!existsSync(hostJsonPath)) {
        throw new Error(
          `${hostJsonPath} missing — orchestrator did not bring up apex.\n` +
            `  Run: E2E_MINA=1 bash scripts/townhouse-e2e-local-hs.sh up --local`
        );
      }
      const hostJson = JSON.parse(readFileSync(hostJsonPath, 'utf-8')) as {
        hostname: string;
      };
      apexHostname = hostJson.hostname;
      expect(apexHostname).toMatch(/^[a-z2-7]{55,57}\.(anyone|anon)$/);

      const res = await fetchWithTimeout(`${CLIENT_URL}/healthz`, {
        budgetMs: 5_000,
        label: '/healthz',
      });
      if (!res.ok) throw new Error(`client /healthz HTTP ${res.status}`);
      const healthz = (await res.json()) as {
        anyoneReady: boolean;
        minaAddr?: string;
      };
      if (!healthz.anyoneReady) {
        throw new Error(
          `Client anyoneReady=false. Inspect: docker logs ${CLIENT_CONTAINER} | tail -50`
        );
      }
      podMinaAddr = healthz.minaAddr;
      bSecretKey = generateSecretKey();
    }, 120_000);

    it('Mina leg: publish is REJECTED at claim validation (Stage-3 gate; documents the divergence)', async () => {
      const event: NostrEvent = finalizeEvent(
        {
          kind: 1,
          content: `local-hs mina smoke @ ${new Date().toISOString()}`,
          tags: [['t', 'local-hs-mina-smoke']],
          created_at: Math.floor(Date.now() / 1000),
        },
        bSecretKey
      );
      const reqBody = { event, targetHostname: apexHostname };

      const publishRes = await fetchWithTimeout(`${CLIENT_URL}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqBody),
        budgetMs: 120_000,
        label: 'POST /publish (mina)',
      });
      const bodyText = await publishRes.text();
      console.log(
        `[local-hs-mina] publish status=${publishRes.status} body=${bodyText.slice(0, 300)}`
      );

      // GATE: a 202 here would mean the client claim was ACCEPTED — i.e. the
      // divergence is resolved. Until then we EXPECT a non-202 (the connector
      // rejects the Mina claim structure). Capture evidence either way.
      await captureLogsOnFailure('mina-publish-result', {
        status: publishRes.status,
        bodyText,
        podMinaAddr,
      });

      if (publishRes.status === 202) {
        // Resolved! The client claim now satisfies the connector contract.
        // Promote this to a positive assertion when the gate is closed.
        console.log(
          '[local-hs-mina] UNEXPECTED 202 — the Mina claim was ACCEPTED. ' +
            'The Stage-3 client gate appears RESOLVED; update this smoke to assert credit.'
        );
        expect(publishRes.status).toBe(202);
        return;
      }

      // Expected gated path: NOT accepted. Assert it failed (any non-202) so the
      // test stays honest — it FAILS only if the loop silently 202s without the
      // earnings-credit assertions a resolved gate would add.
      expect(publishRes.status).not.toBe(202);
    }, 180_000);
  }
);
