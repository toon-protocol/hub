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
  // >=3.3.2 through 3.9.10 — see packages/sdk/CONNECTOR_MIGRATION.md). Digest
  // resolved via `docker buildx imagetools inspect` for tag 3.9.10 (manifest-index
  // digest). To bump: see CONNECTOR_RELEASE_CONTRACT.md.
  'ghcr.io/toon-protocol/connector@sha256:97d4db77ce6bfa163542ab895f90d056f7cbe9696cde4f0999dd495eb8e04a4d';

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
