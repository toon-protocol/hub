import type { ChainProviderEntry, TownhouseConfig } from './schema.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONNECTOR_IMAGE } from '../constants.js';

/**
 * Default chain-provider entry for HS-mode boots without explicit config.
 *
 * These are dev-Anvil deterministic addresses paired with a dead RPC URL —
 * the connector's settlement subsystem (AccountManager + ClaimReceiver)
 * initializes successfully (SQLite-backed) even when the RPC never resolves,
 * because the chain calls are lazy and the failure path is non-fatal.
 *
 * The single concrete value-add: with these defaults present, the connector
 * wires the ClaimReceiver into the AdminServer at boot and
 * `GET /admin/earnings.json` returns 200 instead of 503 (Epic 47 BUG-1).
 *
 * Production operators override this in `config.yaml`:
 *
 *   chainProviders:
 *     - chainType: evm
 *       chainId: evm:base:8453     # Base mainnet
 *       rpcUrl: https://mainnet.base.org
 *       registryAddress: 0x…
 *       tokenAddress: 0x…
 *       keyId: 0x…                 # operator-managed key
 */
export const DEFAULT_HS_CHAIN_PROVIDERS: readonly ChainProviderEntry[] = [
  Object.freeze({
    chainType: 'evm',
    chainId: 'evm:base:31337',
    rpcUrl: 'http://127.0.0.1:19999',
    registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    keyId: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  }),
] as const;

/**
 * Sensible default configuration. All nodes disabled by default —
 * operator must explicitly enable what they want to run.
 */
export function getDefaultConfig(): TownhouseConfig {
  return {
    nodes: {
      town: { enabled: false },
      mill: { enabled: false },
      dvm: { enabled: false },
    },
    wallet: {
      encrypted_path: join(homedir(), '.townhouse', 'wallet.enc'),
    },
    connector: {
      image: DEFAULT_CONNECTOR_IMAGE,
      adminPort: 9401,
    },
    transport: {
      mode: 'direct',
    },
    api: {
      port: 9400,
      host: '127.0.0.1',
    },
    logging: {
      level: 'info',
    },
  };
}
