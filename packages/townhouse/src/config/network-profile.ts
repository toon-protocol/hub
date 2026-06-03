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
 */

import {
  resolveNetworkProfile,
  type NetworkProfile,
  type ChainProviderConfigEntry,
} from '@toon-protocol/core';
import type { TownhouseConfig } from './schema.js';

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
  return resolveNetworkProfile(config.network ?? 'mainnet', {
    keyId,
    endpoints: config.endpoints,
  });
}
