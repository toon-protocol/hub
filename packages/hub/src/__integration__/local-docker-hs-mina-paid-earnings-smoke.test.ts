/**
 * Local-Docker HS Mina paid-earnings smoke gate (Phase-2 Stage 3).
 *
 * Sibling of the EVM + Solana paid-earnings smokes, for the Mina settlement leg.
 * A `mina:devnet`-denominated publish through the apex SHOULD eventually be
 * ACCEPTED by the connector (zkApp channel verified on-chain) and credit apex
 * earnings — the same milestone Solana reached.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  STAGE-3 CLIENT GATE — RESOLVED at claim-validation + FULFILL (#88 settle gate)
 * ════════════════════════════════════════════════════════════════════════════
 * The client's Mina claim path now MATCHES connector 3.9.0's `MinaClaimMessage`
 * contract, so a Mina-denominated paid publish is ACCEPTED at the connector's
 * `validateClaimMessage` PREPARE gate and the apex FULFILLs to town (HTTP 202).
 * The three former divergences are closed:
 *
 *   1. WIRE SHAPE. `MinaSigner.buildClaimMessage` now emits the connector's
 *      required `{ zkAppAddress, tokenId, balanceCommitment, proof (base64),
 *      salt, nonce }` (+ `blockchain:'mina'`, `network:'devnet'`). Optional
 *      `balanceB`/`signatureB` are omitted (the apex-as-recipient single
 *      direction is accepted with party-A only).
 *
 *   2. COMMITMENT / SIGNED MESSAGE. The client now reproduces
 *      `MinaPaymentChannelSDK.signBalanceProof` exactly — a Pallas Schnorr
 *      signature (devnet prefix) over `[ Poseidon([balanceA, balanceB, salt]),
 *      Field(nonce), Poseidon(PublicKey.fromBase58(zkAppAddress).x) ]`, decoded
 *      to the o1js `{r,s}` JSON form. Verified field-by-field against the
 *      connector's o1js `Signature.fromJSON({r,s}).verify` (client unit tests).
 *      The Mill↔sender swap-format `balanceProofFieldsMina` is left untouched
 *      (separate payment-channel path, mirroring the Solana #105 separation).
 *
 *   3. ON-CHAIN CHANNEL. `OnChainChannelClient.openMinaChannel` now returns the
 *      DEPLOYED zkApp B62 address as the channel id (the same address the e2e
 *      harness deploys + advertises), so `getChannelState(zkAppAddress)` resolves
 *      to the externally-opened on-chain channel.
 *
 * ⚠️ CONNECTOR 3.9.0 PROOF-ENCODING BUG (documented): `validateMinaClaim`
 * requires `proof` to be base64 (`/^[A-Za-z0-9+/]+=*$/`), but the connector's own
 * producer (`per-packet-claim-service`) and consumer (`verifyBalanceProof` →
 * `JSON.parse(proof)`) treat `proof` as RAW JSON. The client base64-encodes the
 * proof so it PASSES the PREPARE gate (the FULFILL-deciding path); the
 * settlement-side `JSON.parse` then fails on the base64 — but that is post-FULFILL
 * and, for non-EVM dynamic HS peers, gated by connector#88 regardless.
 *
 * ⚠️ #88 SETTLE GATE (unchanged): on-chain SETTLE (CLAIM/SETTLE tx) for ALL
 * non-EVM dynamic HS peers throws `No chain configured for peer` — the same gate
 * Solana hits. Success here = claim ACCEPTED + FULFILL (HTTP 202) with a Mina
 * claim; on-chain settlement is the connector#88 follow-up.
 *
 * The source-assertion guards below ENCODE the resolved contract. They run with
 * no Docker + no infra and fail loudly if the client's Mina claim regresses away
 * from the connector contract.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Live-loop gating (FULFILL milestone; on-chain settle is #88-gated):
 *   E2E_MINA=1 RUN_LOCAL_HS_E2E=1 bash scripts/hub-e2e-local-hs.sh up --local
 *   RUN_LOCAL_HS_E2E=1 RUN_MINA_LOOP=1 NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *     pnpm --filter @toon-protocol/hub test:integration -- \
 *     local-docker-hs-mina-paid-earnings-smoke
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

import {
  isTruthyEnv,
  isDirectTransport,
  resolveApexTarget,
} from './_test-helpers.js';

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
  join(process.env['HOME'] || '/root', '.hub-e2e');

// ── Source-assertion guards (always run; no Docker, no infra) ────────────────
//
// These encode the RESOLVED Stage-3 client contract: the client's Mina claim
// path now matches connector 3.9.0's MinaClaimMessage contract. Each guard
// asserts the resolved witness so a regression away from the contract fails
// loudly (no Docker / no infra required).

describe('Stage-3 Mina settlement gate (RESOLVED — client Mina claim matches connector contract)', () => {
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

  it('client openMinaChannel returns the deployed zkApp address as the channel id (no synthetic SHA-256 stub)', () => {
    if (!existsSync(clientChannelSrcPath)) {
      console.warn(
        `[mina-gate] client source not found at ${clientChannelSrcPath} — skipping source assertion`
      );
      return;
    }
    const src = readFileSync(clientChannelSrcPath, 'utf-8');
    const idx = src.indexOf('private async openMinaChannel');
    expect(
      idx,
      'openMinaChannel should exist in OnChainChannelClient'
    ).toBeGreaterThanOrEqual(0);
    const body = src.slice(idx, idx + 1400);
    // RESOLVED witness: no synthetic SHA-256 channel id; the channel id IS the
    // deployed zkApp address (what getChannelState(zkAppAddress) resolves).
    expect(
      body.includes("crypto.subtle.digest('SHA-256'") ||
        body.includes('crypto.subtle.digest("SHA-256"'),
      'openMinaChannel must NO LONGER derive a synthetic SHA-256 channel id'
    ).toBe(false);
    expect(
      body.includes('this.minaConfig.zkAppAddress') &&
        body.includes('channelId: zkAppAddress'),
      'openMinaChannel must return the deployed zkApp B62 address as the channel id'
    ).toBe(true);
  });

  it('client Mina claim emits the connector-required zkAppAddress/tokenId/balanceCommitment/proof/salt', () => {
    if (!existsSync(clientSignerSrcPath)) {
      console.warn(
        `[mina-gate] client signer source not found at ${clientSignerSrcPath} — skipping source assertion`
      );
      return;
    }
    const src = readFileSync(clientSignerSrcPath, 'utf-8');
    // Isolate the CLAIM-OBJECT LITERAL only (between `const claim` and
    // `return claim`) so the function signature can't false-match.
    const start = src.indexOf('const claim');
    const end = src.indexOf('return claim', start);
    expect(
      start,
      'mina-signer should declare `const claim`'
    ).toBeGreaterThanOrEqual(0);
    expect(end, 'mina-signer should `return claim`').toBeGreaterThan(start);
    const claimLiteral = src.slice(start, end);

    // RESOLVED witnesses: all connector-required MinaClaimMessage keys present.
    for (const key of [
      'zkAppAddress:',
      'tokenId:',
      'balanceCommitment:',
      'proof:',
      'salt:',
      'nonce:',
    ]) {
      expect(
        claimLiteral.includes(key),
        `connector 3.9.0 MinaClaimMessage requires \`${key}\` on the client claim`
      ).toBe(true);
    }
    // The old swap-format `commitment:` key must be GONE.
    expect(
      /\bcommitment:/.test(claimLiteral),
      'client Mina claim must no longer emit the swap-format `commitment` key'
    ).toBe(false);
  });

  // ── Harness guard: deterministic zkApp deploy under o1js 2.14 ───────────────
  // The deploy script (scripts/deploy-mina-zkapp.ts) must keep three fixes that
  // were required to deploy the payment-channel zkApp on the lightnet under o1js
  // 2.14 (proven live: tx included in block, account on-chain, idempotent):
  //
  //   1. o1js + the CJS-compiled `@toon-protocol/mina-zkapp` must load through
  //      ONE shared o1js module instance — resolved via `createRequire` (CJS),
  //      NOT a bare ESM `import('o1js')`. The ESM/CJS split gives each build its
  //      own `activeInstance`, so `setActiveInstance` on the ESM instance leaves
  //      the zkApp's CJS instance unset → `Must call Mina.setActiveInstance
  //      first` at deploy (the exact 2.14 failure this guards against).
  //   2. The lightnet accounts-manager `/acquire-account` is HTTP GET (POST →
  //      "Method Not Allowed" on `compatible-latest-lightnet`).
  //   3. The deploy transaction must set an explicit fee (the implicit/zero
  //      default is rejected with "Insufficient fee").
  it('deploy-mina-zkapp.ts keeps the o1js-2.14 deploy fixes (CJS require, GET acquire, explicit fee)', () => {
    const deployScriptPath = join(REPO_ROOT, 'scripts', 'deploy-mina-zkapp.ts');
    if (!existsSync(deployScriptPath)) {
      console.warn(
        `[mina-gate] deploy script not found at ${deployScriptPath} — skipping source assertion`
      );
      return;
    }
    const src = readFileSync(deployScriptPath, 'utf-8');

    // (1) Shared module instance: createRequire(CJS), not a bare ESM import.
    expect(
      src.includes('createRequire'),
      'deploy script must resolve o1js via createRequire (CJS) so it shares the ' +
        'active Mina instance with the CJS-compiled @toon-protocol/mina-zkapp'
    ).toBe(true);
    expect(
      /await import\(\s*['"]o1js['"]\s*\)/.test(src),
      'deploy script must NOT load o1js via a bare ESM `import("o1js")` — that ' +
        'creates a separate activeInstance from the zkApp (the setActiveInstance bug)'
    ).toBe(false);

    // (2) accounts-manager acquire is GET.
    const acquireIdx = src.indexOf('/acquire-account');
    expect(
      acquireIdx,
      'deploy script should call the accounts-manager /acquire-account'
    ).toBeGreaterThanOrEqual(0);
    const acquireBlock = src.slice(acquireIdx - 200, acquireIdx + 200);
    expect(
      /method:\s*['"]POST['"]/.test(acquireBlock),
      'accounts-manager /acquire-account must be GET, not POST'
    ).toBe(false);

    // (3) explicit fee on the deploy transaction. Match the actual call
    // (`Mina.transaction(`), not the prose mentions in the comment block.
    const txIdx = src.indexOf('Mina.transaction(');
    expect(
      txIdx,
      'deploy script should build a Mina.transaction(...)'
    ).toBeGreaterThanOrEqual(0);
    expect(
      /\bfee:/.test(src.slice(txIdx, txIdx + 200)),
      'deploy transaction must set an explicit fee (implicit default → "Insufficient fee")'
    ).toBe(true);
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
// EXPECTED OUTCOME (client claim now matches the connector contract): the Mina
// claim is ACCEPTED at validateClaimMessage and the apex FULFILLs to town —
// HTTP 202. On-chain SETTLE is the connector#88 follow-up (gated for all non-EVM
// dynamic HS peers; surfaces post-FULFILL as `No chain configured for peer`).
// This block asserts the FULFILL milestone + captures connector log evidence.

describe.skipIf(!shouldRunLiveLoop)(
  'local-Docker HS Mina paid-earnings smoke (live; requires E2E_MINA infra)',
  () => {
    let apexHostname: string;
    let podMinaAddr: string | undefined;
    let bSecretKey: Uint8Array;

    beforeAll(async () => {
      // HS reads the published .anon from host.json; direct (TRANSPORT=direct /
      // DIRECT_BTP=1) uses a placeholder the client ignores (env-driven routing).
      const target = resolveApexTarget(() => {
        const hostJsonPath = join(TOWNHOUSE_HOME, 'host.json');
        if (!existsSync(hostJsonPath)) {
          throw new Error(
            `${hostJsonPath} missing — orchestrator did not bring up apex.\n` +
              `  Run: E2E_MINA=1 bash scripts/hub-e2e-local-hs.sh up --local`
          );
        }
        const hostJson = JSON.parse(readFileSync(hostJsonPath, 'utf-8')) as {
          hostname: string;
        };
        return hostJson.hostname;
      });
      apexHostname = target.targetHostname;
      if (target.mode === 'hs') {
        expect(apexHostname).toMatch(/^[a-z2-7]{55,57}\.(anyone|anon)$/);
      }

      const res = await fetchWithTimeout(`${CLIENT_URL}/healthz`, {
        budgetMs: 5_000,
        label: '/healthz',
      });
      if (!res.ok) throw new Error(`client /healthz HTTP ${res.status}`);
      const healthz = (await res.json()) as {
        anyoneReady: boolean;
        minaAddr?: string;
      };
      // anyoneReady gates the SOCKS/anon path only — direct mode has no anon
      // daemon (the client dials APEX_BTP_URL directly).
      if (!isDirectTransport() && !healthz.anyoneReady) {
        throw new Error(
          `Client anyoneReady=false. Inspect: docker logs ${CLIENT_CONTAINER} | tail -50`
        );
      }
      podMinaAddr = healthz.minaAddr;
      bSecretKey = generateSecretKey();
    }, 120_000);

    it('Mina leg: publish is ACCEPTED at claim validation + FULFILLs (HTTP 202); on-chain settle is #88-gated', async () => {
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

      // MILESTONE: the client claim now matches the connector contract, so a 202
      // (claim ACCEPTED at validateClaimMessage + apex FULFILL to town) is the
      // expected outcome. On-chain settlement is the connector#88 follow-up and
      // surfaces post-FULFILL (it does NOT affect this 202). Capture evidence
      // either way for inspection (connector + town logs alongside).
      await captureLogsOnFailure('mina-publish-result', {
        status: publishRes.status,
        bodyText,
        podMinaAddr,
      });

      // Assert the FULFILL milestone. If this is not 202, inspect the connector
      // log for `inbound_claim_invalid_structure` (a wire-shape regression) or
      // `no settlement provider registered` (the apex Mina provider was not
      // wired by the E2E_MINA harness).
      expect(publishRes.status).toBe(202);
    }, 180_000);
  }
);
