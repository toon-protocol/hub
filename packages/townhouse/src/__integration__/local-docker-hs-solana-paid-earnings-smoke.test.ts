/**
 * Local-Docker HS Solana paid-earnings smoke gate (Phase-2 Stage 2).
 *
 * Sibling of `local-docker-hs-paid-earnings-smoke.test.ts`, for the Solana
 * settlement leg: a `solana:devnet`-denominated publish through the apex should
 * credit apex earnings and settle on-chain to the apex's Solana recipient ATA.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠️  STAGE-2 GATE — THE FULL SOLANA LOOP DOES NOT SETTLE YET (KNOWN BLOCKER)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The make-or-break gate for Stage 2 (client channel-id derivation must match
 * the connector's PDA derivation) FAILS. Two independent divergences block a
 * settleable client-issued Solana claim:
 *
 *   1. MISSING channelAccount. The connector's SolanaClaimMessage REQUIRES a
 *      base58 on-chain PDA in `claim.channelAccount` (validated, then looked up
 *      on-chain via getChannelState; the signature is verified against it). The
 *      toon-client's SolanaSigner.buildClaimMessage emits a `0x…` SHA-256
 *      `channelId` and NO `channelAccount`.
 *
 *   2. WRONG signed message. The client signs the canonical balance proof over
 *      its locally-derived SHA-256 `channelId`
 *      (OnChainChannelClient.openSolanaChannel: SHA-256 of
 *      `channel:<key>:<peer>:<ts>`), while the connector verifies the signature
 *      over `claim.channelAccount` (the real base58 PDA). Even if the field were
 *      populated with the true PDA, the signature would not verify.
 *
 * Root cause: OnChainChannelClient.openSolanaChannel is a lazy stub that never
 * opens an on-chain Solana payment-channel PDA — it just hashes a local id. The
 * connector's SolanaPaymentChannelSDK.deriveChannelPDA derives a REAL PDA from
 * `[b"channel", min_pubkey, max_pubkey, token_mint]` and the channel must exist
 * on-chain for claimFromChannel to succeed.
 *
 * Resolution requires CLIENT-SIDE work (open a real PDA-backed channel + carry
 * `channelAccount` + sign over the PDA), tracked as a Stage-2 follow-up. The
 * live loop below is therefore SKIPPED by default; the unit assertions encode
 * the gate so this test flips to actionable the moment the client is fixed.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Live-loop gating (when unblocked):
 *   E2E_SOLANA=1 RUN_LOCAL_HS_E2E=1 bash scripts/townhouse-e2e-local-hs.sh up
 *   RUN_LOCAL_HS_E2E=1 RUN_SOLANA_LOOP=1 NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *     pnpm --filter @toon-protocol/townhouse test:integration -- \
 *     local-docker-hs-solana-paid-earnings-smoke
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceProofHashSolana, base58Encode } from '@toon-protocol/core';

import { isTruthyEnv } from './_test-helpers.js';

// ── Gate ─────────────────────────────────────────────────────────────────────

const RUN_GATE = isTruthyEnv(process.env['RUN_LOCAL_HS_E2E']);
const RUN_SOLANA_LOOP = isTruthyEnv(process.env['RUN_SOLANA_LOOP']);
const SKIP_DOCKER = isTruthyEnv(process.env['SKIP_DOCKER']);
// The live loop is additionally gated by RUN_SOLANA_LOOP because the client
// cannot yet produce a settleable Solana claim (see the GATE banner above).
const shouldRunLiveLoop = RUN_GATE && RUN_SOLANA_LOOP && !SKIP_DOCKER;

const thisFile = fileURLToPath(import.meta.url);
const REPO_ROOT = join(thisFile, '..', '..', '..', '..', '..');

// ── Gate documentation (always runs; no Docker, no infra) ────────────────────
//
// These assertions are a REGRESSION GUARD that records the Stage-2 client gate.
// They read the client source so a future client fix (real PDA + channelAccount
// + sign-over-PDA) makes them fail loudly, signalling that the live loop below
// can be enabled.

describe('Stage-2 Solana settlement gate (client ↔ connector divergence)', () => {
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

  it('client OnChainChannelClient.openSolanaChannel is still a non-PDA stub (BLOCKER)', () => {
    if (!existsSync(clientChannelSrcPath)) {
      // The client package may not be present in every consumer checkout; the
      // gate is documented in the banner regardless.
      console.warn(
        `[solana-gate] client source not found at ${clientChannelSrcPath} — skipping source assertion`
      );
      return;
    }
    const src = readFileSync(clientChannelSrcPath, 'utf-8');

    // BLOCKER witness: derives the channel id from a SHA-256 of a local seed
    // string rather than deriving the on-chain PDA from
    // [b"channel", min_pubkey, max_pubkey, token_mint].
    expect(
      src.includes("crypto.subtle.digest('SHA-256', channelSeed)"),
      'openSolanaChannel still hashes a local seed instead of deriving the on-chain PDA — the loop cannot settle. ' +
        'If this assertion fails, the client may now open a real PDA-backed channel; re-validate the Stage-2 loop ' +
        'and enable RUN_SOLANA_LOOP.'
    ).toBe(true);

    // It must NOT yet derive a real PDA (the connector SDK uses
    // findProgramDerivedAddressSync / deriveChannelPDA).
    expect(
      src.includes('deriveChannelPDA') ||
        src.includes('findProgramDerivedAddressSync'),
      'openSolanaChannel now references PDA derivation — the Stage-2 client gate may be resolved; re-validate the loop.'
    ).toBe(false);
  });

  it('client Solana claim carries channelId but NOT the connector-required channelAccount (BLOCKER)', () => {
    if (!existsSync(clientSignerSrcPath)) {
      console.warn(
        `[solana-gate] client signer source not found at ${clientSignerSrcPath} — skipping source assertion`
      );
      return;
    }
    const src = readFileSync(clientSignerSrcPath, 'utf-8');

    // The connector's SolanaClaimMessage requires `channelAccount` (a base58
    // PDA). The client claim builder emits `channelId` and omits `channelAccount`.
    expect(
      /channelId:\s*proof\.channelId/.test(src),
      'client still emits channelId (not channelAccount) in the Solana claim'
    ).toBe(true);
    expect(
      src.includes('channelAccount'),
      'client now emits channelAccount — the Stage-2 client gate may be resolved; re-validate the loop.'
    ).toBe(false);
  });

  it('balanceProofHashSolana is deterministic over (channelId, amount, nonce, recipient) — parity primitive', () => {
    // Sanity witness that the shared canonical hash primitive (used by client,
    // mill, and the connector/SDK verifier) is stable. This is the piece that
    // IS correct (PR #100 parity); the gate is the *channel id*, not the hash.
    const recipient = base58Encode(new Uint8Array(32).fill(7));
    const h1 = balanceProofHashSolana('0xabc', 1_000_000n, 1n, recipient);
    const h2 = balanceProofHashSolana('0xabc', 1_000_000n, 1n, recipient);
    expect(h1).toEqual(h2);
    expect(h1.length).toBe(32);
    // Different channel id ⇒ different hash (proves channelId is bound into the
    // signed message — which is exactly why the client/connector channel-id
    // divergence breaks signature verification).
    const h3 = balanceProofHashSolana('0xdef', 1_000_000n, 1n, recipient);
    expect(h3).not.toEqual(h1);
  });
});

// ── Live Solana loop (gated + skipped until the client gate is resolved) ─────

describe.skipIf(!shouldRunLiveLoop)(
  'local-Docker HS Solana paid-earnings smoke (live; requires E2E_SOLANA + client PDA fix)',
  () => {
    it('Solana leg: paid publish settles + credits apex earnings (BLOCKED — see gate banner)', () => {
      // Intentionally fails fast with the blocker context if someone force-enables
      // RUN_SOLANA_LOOP before the client gate is resolved, rather than silently
      // asserting a settlement that cannot happen.
      throw new Error(
        'Stage-2 Solana loop is BLOCKED: the toon-client cannot produce a settleable ' +
          'Solana claim (no on-chain PDA / missing channelAccount / signs over the ' +
          'wrong channel id). Resolve the client-side PDA channel work before enabling ' +
          'RUN_SOLANA_LOOP. See the GATE banner at the top of this file.'
      );
    });
  }
);
