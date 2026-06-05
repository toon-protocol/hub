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
  // v3.9.1 — fixes inbound claim validation to dispatch by blockchain type.
  // validateClaimMessage now switches on claim.blockchain and routes to
  // validateEVMClaim / validateSolanaClaim / validateMinaClaim. 3.9.0 ran the EVM
  // validator unconditionally, so a Solana claim's base58 channelAccount was
  // rejected with F06 "Invalid channelId format (expected 0x-prefixed 64-char
  // hex)". validateSolanaClaim accepts { blockchain:'solana', programId,
  // channelAccount (base58), nonce, transferredAmount, signature,
  // signerPublicKey (base58), cluster? }. Builds on 3.9.0's Solana + Mina
  // settlement wiring (#86); EVM settlement unchanged. No breaking changes to the
  // SDK/admin contract within 3.x (verified >=3.3.2 through 3.9.1 — see
  // packages/sdk/CONNECTOR_MIGRATION.md). Digest resolved via
  // `docker buildx imagetools inspect` for tag 3.9.1. To bump: see
  // CONNECTOR_RELEASE_CONTRACT.md.
  'ghcr.io/toon-protocol/connector@sha256:a53fa02372203d31044564245d28d5ab9fc0e08c753c75deb573a5248d1a221b';

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
