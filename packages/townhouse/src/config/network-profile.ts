/**
 * Single entry point for turning a Townhouse config into a resolved
 * {@link NetworkProfile}, used by every consumer — the apex connector
 * (hs-config-writer), the node-container env overlay (nodes-lifecycle), the
 * compose `.env` writer (env-writer), and the `/api/network` route — so the
 * apex and its children always agree.
 *
 * Precedence (highest first):
 *   1. explicit non-empty `config.chainProviders` → used for BOTH apex and
 *      children (an operator who ran `chains add` gets those on every node).
 *   2. `config.network` (`mainnet`/`testnet`/`devnet`/`custom`), with
 *      `config.endpoints` URLs threaded through for the `custom` mode.
 *
 * When `config.network` is unset we default to {@link DEFAULT_NETWORK} =
 * `'testnet'` — the lowest settlement-complete tier (Base Sepolia registry +
 * TokenNetwork, Solana devnet program, Mina devnet zkApp). Mainnet is NOT used
 * as the default because TOON's settlement contracts are not deployed there yet
 * (`base-mainnet` preset has empty registry/tokenNetwork addresses), so an unset
 * network would otherwise resolve to a node with no settlement chain that
 * silently degrades to relay-only / "DEVELOPMENT MODE". Operators who explicitly
 * want mainnet must set `network: mainnet` (and accept relay-only until contracts
 * ship); `init` warns loudly in that case.
 */

import {
  resolveNetworkProfile,
  type NetworkProfile,
  type ChainProviderConfigEntry,
} from '@toon-protocol/core';
import type { TownhouseConfig } from './schema.js';

/**
 * Default network tier when `config.network` is unset. `'testnet'` is the
 * lowest settlement-complete tier — choosing it (over `'mainnet'`, whose TOON
 * contracts are not deployed) means a node provisioned without an explicit
 * `--network` points at a real settlement-ready chain instead of silently
 * degrading to relay-only / dev mode.
 */
export const DEFAULT_NETWORK = 'testnet' as const;

/**
 * Resolve the effective network profile for a config.
 *
 * @param config - The Townhouse config (`network`, `akash`, `chainProviders`).
 * @param keyId - Settlement signing key for connector `chainProviders` entries
 *   (apex only). Omit for the node-env path, which carries no secrets.
 */
export function resolveConfigNetworkProfile(
  config: TownhouseConfig,
  keyId?: string
): NetworkProfile {
  // Explicit chainProviders win for apex AND children (precedence consistency).
  if (config.chainProviders && config.chainProviders.length > 0) {
    return resolveNetworkProfile('custom', {
      keyId,
      customProviders: config.chainProviders as ChainProviderConfigEntry[],
    });
  }
  return resolveNetworkProfile(config.network ?? DEFAULT_NETWORK, {
    keyId,
    endpoints: config.endpoints,
  });
}
