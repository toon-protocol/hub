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
  // v3.9.2 — fixes Mina settlement-side proof encoding (#90). The settlement
  // executor's `JSON.parse(proof)` failed when the proof arrived base64-encoded
  // instead of as a JSON string; 3.9.2 normalizes the encoding so Mina claims
  // verify through to on-chain settle. Builds on 3.9.1's #88 fix
  // (SettlementExecutor now resolves the settlement chain for dynamic anonymous
  // HS peers) and 3.9.1's blockchain-typed inbound claim validation
  // (validateClaimMessage switches on claim.blockchain → validateEVMClaim /
  // validateSolanaClaim / validateMinaClaim). validateSolanaClaim accepts
  // { blockchain:'solana', programId, channelAccount (base58), nonce,
  // transferredAmount, signature, signerPublicKey (base58), cluster? }. No
  // breaking changes to the SDK/admin contract within 3.x (verified >=3.3.2
  // through 3.9.2 — see packages/sdk/CONNECTOR_MIGRATION.md). Digest resolved
  // via `docker buildx imagetools inspect` for tag 3.9.2 (manifest-index
  // digest). To bump: see CONNECTOR_RELEASE_CONTRACT.md.
  'ghcr.io/toon-protocol/connector@sha256:9f55d55db02a5c6a4c5b0989cd30005e30c53d3119d00698facc3cb2d6d20ff0';

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
