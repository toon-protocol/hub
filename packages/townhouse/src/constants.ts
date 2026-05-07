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
 * Default connector Docker image tag — single source of truth for the workspace.
 *
 * To bump: update this constant, run `pnpm --filter @toon-protocol/townhouse test contract-canary`,
 * then `pnpm --filter @toon-protocol/townhouse test:canary`. See packages/sdk/CONNECTOR_MIGRATION.md
 * for the full checklist and breaking-changes history.
 */
export const DEFAULT_CONNECTOR_IMAGE = 'ghcr.io/toon-protocol/connector:3.4.1';

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
