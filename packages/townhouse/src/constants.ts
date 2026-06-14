/**
 * Shared constants for Townhouse package.
 *
 * Single source of truth for values used across multiple modules
 * (orchestrator, config-generator, CLI).
 */

/** Container name prefix for all Townhouse-managed Docker containers */
export const CONTAINER_PREFIX = 'townhouse-';

/** Internal BTP port exposed by node containers (Docker-internal only) */
export const NODE_BTP_PORT = 3000;

/**
 * Default connector Docker image — digest-pinned per CONNECTOR_RELEASE_CONTRACT.md.
 *
 * To bump: capture a new digest by running the Story 45.1 publish workflow
 * against the desired connector tag, copy the resulting image-manifest.json
 * connector entry's digest, and update this constant + the contract canary
 * fixture. See packages/sdk/CONNECTOR_RELEASE_CONTRACT.md for the full bump
 * checklist + breaking-changes history.
 *
 * To read the human-readable tag for log output, consult dist/image-manifest.json:
 *   manifest.images.connector.tag
 */
export const DEFAULT_CONNECTOR_IMAGE =
  // v3.10.4 — connector#137 (non-EVM inbound claim validator: Solana Ed25519 /
  // Mina verification wired to the BTP server) + connector#136 (dynamic-HS-peer
  // settlement: peerIdToChainMap populated via registerPeerChain), closing
  // toon#213 and unblocking Solana + Mina pay-to-write for dynamic HS apexes.
  // Validated live: bumping a running apex 3.10.3→3.10.4 made dynamic-HS Solana
  // and Mina on-chain settlement work end-to-end. Builds on:
  // v3.10.3 — connector#133 Mina claimFromChannel balance-conservation fix
  // (#134 + #135 test follow-up). For an inbound unidirectional Mina claim the
  // provider built the co-signed claim with balanceB=0, but the on-chain
  // PaymentChannel.claimFromChannel circuit asserts balanceA + balanceB ==
  // depositTotal and verifies both signatures over Poseidon([balanceA,balanceB,
  // salt]); balanceB=0 violated conservation → PROOF_GENERATION_FAILED before any
  // tx. 3.10.2 derives balanceB = depositTotal − balanceA from the public
  // on-chain depositTotal (3.10.3 hardens the integration tests). This is the
  // connector half of the LAST Mina publish-settle blocker (#158): with it +
  // the client conserved-balanceB signing fix, a Mina-settled publish drives
  // claimFromChannel to an on-chain landing (nonceField 0→1, proven live).
  // Patch bump — no SDK/admin contract change vs 3.10.1; bumped because townhouse
  // needs the conservation-correct settle behavior (CONNECTOR_RELEASE_CONTRACT.md
  // patch-bump exception).
  // v3.10.1 — connector#132 settlement claim-chain routing fix. The
  // settlement-executor was routing Solana/Mina settle by a stale EVM channel
  // instead of by the claim's own chain, so non-EVM publish-settle mis-routed
  // to the EVM path. 3.10.1 selects the settlement chain from the inbound
  // claim's `blockchain` (claim-driven) with guards. This is the connector half
  // of #159 (Solana publish-settle proven on-chain; unblocks the Mina #158 /
  // mill #157 town-side fixes for end-to-end validation). Patch bump — no
  // SDK/admin contract change vs 3.10.0; bumped because townhouse needs the
  // fixed (non-EVM-misrouting) settlement behavior per
  // CONNECTOR_RELEASE_CONTRACT.md's patch-bump exception.
  // v3.10.0 — Story 34.4 fund-custody zkApp bundle (#130/#131, closes #134). The
  // connector now bundles the Story 34.4 `PaymentChannel` zkApp (FUND CUSTODY on
  // deposit + FUND DISTRIBUTION on settle: the zkApp account escrows the deposit
  // and `settle()` drains balanceB→participantB / balanceA→participantA). Its
  // compiled verification key is byte-identical to the zkApp our harness deploys
  // (VK hash 21482326729342759163995140331524541410906862862696135294081643945442581537217),
  // so connector-driven `claimFromChannel`/`settle` proofs verify against the
  // deployed contract. Minor bump; SDK/admin contract unchanged within 3.x.
  // v3.9.13 — #128 openChannel deploy/initialize split. The zkApp openChannel
  // path was combining contract deploy + initialize into one tx; 3.9.13 splits
  // them so the on-chain channel opens cleanly.
  // v3.9.12 — #126 zkApp tx fee + balance conservation. The apex's
  // `claimFromChannel` settlement tx was broadcast with NO fee (failed at
  // `Insufficient fee`); 3.9.12 sets the zkApp tx fee AND guards balance
  // conservation (rejects a claim whose transferred amount would violate
  // deposit-total conservation). Together with 3.9.13 the on-chain Mina
  // claimFromChannel tx broadcasts and LANDS (zkApp nonce/balanceCommitment
  // advance) — completing the non-EVM pay-to-write settle loop.
  // v3.9.11 — #123 apex co-signs signatureB. `claimFromChannel` previously
  // reused the client's signatureA as signatureB, so the on-chain dual-party
  // verification reverted at `participant B signature verification failed`. With
  // 3.9.11 the connector co-signs signatureB with the apex Mina key, so both
  // signature checks pass and the on-chain Mina claimFromChannel tx lands
  // (zkApp nonce/balanceCommitment advance). This was the LAST Mina blocker.
  // v3.9.10 — #121 claimFromChannel signatureA wrapper. `claimFromChannel` now
  // accepts the `signBalanceProof` wrapper ({commitment,signature:{r,s},...}) as
  // `signatureA` (was: INVALID_PARAMETERS "Invalid signatureA" — wrapper vs bare
  // {r,s} mismatch threw before any tx). This is the LAST Mina settle blocker:
  // with it the connector submits the on-chain Mina claimFromChannel tx and the
  // zkApp nonce/balanceCommitment advance.
  // v3.9.9 — #118 advancing-claims acceptance in verifyBalanceProof. Resolves the
  // nonce tension that blocked the Mina settle leg: the claim nonce was required to
  // EQUAL the on-chain nonce, but `claimFromChannel` needs the claim to ADVANCE the
  // channel (nonce > on-chain). 3.9.9 makes verifyBalanceProof accept advancing
  // claims, so the connector can auto-drive `claimFromChannel` on a Mina publish.
  // v3.9.8 — #117 Mina settlement-trigger fix. `CLAIM_RECEIVED` now emits the real
  // `transferredAmount` (was hardcoded `BigInt(0)`), so the settlement-threshold
  // check actually fires for Mina, triggering claimFromChannel().
  // Together 3.9.8 + 3.9.9 complete the connector-driven on-chain Mina settle.
  // v3.9.7 — #114 inbound Mina claimFromChannel + #84 dual-party. Enables the
  // on-chain `claimFromChannel` for externally-opened (inbound) channels, fixing
  // the `_participantCache` miss (ACCOUNT_NOT_FOUND) + off-chain/on-chain
  // proof-message mismatch that blocked the Mina settle leg in 3.9.6; also closes
  // #98/#84 (dual-party). This completes the full non-EVM on-chain settle
  // (CLAIM_FROM_CHANNEL + SETTLE_CHANNEL) for BOTH Solana and Mina.
  // Builds on the 3.9.6 chain:
  //   #94 (3.9.4) — Solana Ed25519 precompile / on-chain message reconstruction.
  //   #95 (3.9.4) — Mina getChannelState missing setActiveInstance.
  //   #98 (3.9.5) — Mina balance-proof commitment was compared against the zkApp
  //                 address; fixed to compare the on-chain `balanceCommitment`.
  //   #99 (3.9.5) — Solana CLAIM_FROM_CHANNEL fee-payer decoupled from the claiming
  //                 participant so the connector can unilaterally redeem a
  //                 peer-signed inbound claim.
  //   3.9.6 — connector-CI fix only (no runtime change vs 3.9.5).
  //   #114 (3.9.7) — on-chain claimFromChannel enabled for inbound channels.
  // Builds on 3.9.3's Solana settle-executor channel-lookup fix (#92), 3.9.2's Mina
  // settlement-side proof-encoding fix (#90), 3.9.1's #88 fix (SettlementExecutor
  // resolves the settlement chain for dynamic anonymous HS peers), and 3.9.1's
  // blockchain-typed inbound claim validation (validateClaimMessage switches on
  // claim.blockchain → validateEVMClaim / validateSolanaClaim / validateMinaClaim).
  // validateSolanaClaim accepts { blockchain:'solana', programId, channelAccount
  // (base58), nonce, transferredAmount, signature, signerPublicKey (base58),
  // cluster? }. No breaking changes to the SDK/admin contract within 3.x (verified
  // >=3.3.2 through 3.10.3 — see packages/sdk/CONNECTOR_MIGRATION.md). Digest
  // resolved via `docker buildx imagetools inspect` for tag 3.10.3 (manifest-index
  // digest). To bump: see CONNECTOR_RELEASE_CONTRACT.md.
  'ghcr.io/toon-protocol/connector@sha256:48d2160e4479aae068ebd8b735a0a063995f1f2f17308c847f3a9b6cc57b1de4';

/**
 * Human-readable connector tag for the digest pinned in DEFAULT_CONNECTOR_IMAGE.
 *
 * This is the machine-readable counterpart to the `@sha256:` digest above. It
 * MUST stay in lockstep with BOTH:
 *   1. the `@sha256:<digest>` in DEFAULT_CONNECTOR_IMAGE (above), and
 *   2. `env.CONNECTOR_VERSION_DEFAULT` in
 *      `.github/workflows/publish-townhouse-images.yml`.
 *
 * The `connector-version-alignment.test.ts` source-level guard asserts (1) the
 * workflow env equals this tag and (2) DEFAULT_CONNECTOR_IMAGE is well-formed,
 * so a human bumping one but not the other fails CI at PR time — BEFORE a
 * release. (PR #165 drifted constants.ts to 3.10.3 while leaving the workflow
 * env at 3.10.0, hard-failing preflight and silently breaking the v0.17.4 and
 * v0.17.5 publishes.) The live tag↔digest resolution stays in the workflow's
 * preflight job (`docker buildx imagetools inspect`); this constant only guards
 * the SOURCE-level human drift. When bumping the connector: update the digest
 * above, this tag, AND the workflow env together.
 */
export const DEFAULT_CONNECTOR_TAG = '3.10.4';

/**
 * HD wallet account indices per node type (Story 21.4, D21-008).
 * BIP-44 paths: m/44'/{coin}'/ACCOUNT'/0/0
 */
export const ACCOUNT_INDEX_TOWN = 0;
export const ACCOUNT_INDEX_MILL = 1;
export const ACCOUNT_INDEX_DVM = 2;
/**
 * Apex (connector) settlement account. The apex is the parent connector
 * (`g.townhouse`) that signs settlement claims; its key is derived from the
 * operator mnemonic at this index so the operator never has to supply a raw
 * settlement key. Index 3 continues the town/mill/dvm sequence (and matches the
 * dev convention where the apex is Anvil account[3], 0x90F79bf6…).
 */
export const ACCOUNT_INDEX_APEX = 3;

/** BLS health port exposed by each node container type (internal Docker port). */
export const TOWN_HEALTH_PORT = 3100;
export const MILL_HEALTH_PORT = 3200;
export const DVM_HEALTH_PORT = 3400;
