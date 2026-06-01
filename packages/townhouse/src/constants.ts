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
  // v3.8.0 — latest published connector (Story 50.4 bump). Migrates local SQLite
  // from better-sqlite3 to libsql (toon-protocol/connector#79 — removes the
  // native-build failure on Node 24 that left the settlement/claim subsystem
  // silently un-wired → value-bearing packets auto-fulfilled instead of
  // claim-gated) AND makes inbound per-packet claim validation relation-aware
  // (toon-protocol/connector#78 — a child node now skips the inline-claim
  // requirement for PREPAREs forwarded from its parent, unblocking Story 50.3's
  // AC#1 kind:1 F06 "No payment channel claim attached" on the apex→child hop).
  // No breaking changes to the SDK/admin contract within 3.x (verified >=3.3.2
  // through 3.8.0 — see packages/sdk/CONNECTOR_MIGRATION.md). Digest resolved via
  // `docker buildx imagetools inspect` for tag 3.8.0. To bump: see
  // CONNECTOR_RELEASE_CONTRACT.md.
  'ghcr.io/toon-protocol/connector@sha256:3343c19649290043e521c81b467b7c6410b8eaedd76d48804ea9b6fc810cddb0';

/**
 * HD wallet account indices per node type (Story 21.4, D21-008).
 * BIP-44 paths: m/44'/{coin}'/ACCOUNT'/0/0
 */
export const ACCOUNT_INDEX_TOWN = 0;
export const ACCOUNT_INDEX_MILL = 1;
export const ACCOUNT_INDEX_DVM = 2;

/** BLS health port exposed by each node container type (internal Docker port). */
export const TOWN_HEALTH_PORT = 3100;
export const MILL_HEALTH_PORT = 3200;
export const DVM_HEALTH_PORT = 3400;
