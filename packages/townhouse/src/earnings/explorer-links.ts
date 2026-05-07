/**
 * Block-explorer URL templating from `deploy/akash/leases.json` (Story D4).
 *
 * Takes a chain discriminator + txHash and returns the operator-facing
 * explorer URL the dashboard renders. Shape of `leases.json` is intentionally
 * narrow + tolerant — see `presets/demo.ts` for the broader read surface.
 *
 * Resolution rules (AC-D4-3):
 *   - EVM (chain==='evm'): `${blockscout.url}/tx/${txHash}` when present.
 *   - Solana (chain==='solana'): prefer self-hosted `${solana_explorer.url}/tx/${signature}`
 *     when the lease is up; otherwise fall back to public Solana Explorer with
 *     `?cluster=custom&customUrl=${rpcUrl}` so the explorer points at our RPC.
 *   - When `leases.json` is missing or has nothing usable for the chain, we
 *     return `undefined`. Callers MUST omit the link rather than render a
 *     broken one.
 *
 * @module
 * @since D4
 */

import { existsSync, readFileSync } from 'node:fs';

import type { SettlementChain } from '@toon-protocol/mill';

/**
 * Subset of `deploy/akash/leases.json` that this module reads. The full file
 * (emitted by `scripts/akash-deploy.sh`) has more fields; we only need the
 * URLs here, so the type is narrow + tolerant.
 *
 * The presence of an entry is a deployment marker — `otterscan` (preferred)
 * or `blockscout` present means the EVM explorer lease is up,
 * `solana_explorer` present means the self-hosted Solana explorer lease is up.
 */
export interface AkashLeasesForExplorer {
  /** Anvil JSON-RPC lease — used as Solana Explorer customUrl fallback ONLY when `chain==='solana'` is impossible. */
  anvil?: { url?: string };
  /** Blockscout (EVM) explorer lease — legacy. Path-routed: `${url}/tx/<hash>`. */
  blockscout?: { url?: string };
  /**
   * Otterscan (EVM) explorer lease — current default. Hash-routed:
   * `${url}/#/tx/<hash>`. Preferred over `blockscout` when both are present.
   */
  otterscan?: { url?: string };
  /** Solana JSON-RPC lease — used as `customUrl` when the public explorer fallback path is taken. */
  solana?: { url?: string };
  /** Self-hosted Solana Explorer lease. Preferred over public when present. */
  solana_explorer?: { url?: string };
}

/**
 * Public Solana Explorer base URL. Used as the fallback when the operator
 * has not deployed a self-hosted explorer. `?cluster=custom&customUrl=…`
 * pins the explorer to the operator's RPC so it can resolve devnet/Anvil
 * transactions that mainnet doesn't know about.
 */
export const PUBLIC_SOLANA_EXPLORER = 'https://explorer.solana.com';

/**
 * Read `leases.json` from disk. Returns `null` if the path is unset, missing,
 * or unparseable. Callers treat `null` as "no leases available — no
 * explorer links to render".
 *
 * The function is intentionally permissive: a malformed leases.json should
 * never crash the earnings aggregator, and operators running on local
 * devnets without a `deploy/akash/leases.json` file should see the dashboard
 * work cleanly (just without deeplinks).
 */
export function loadLeases(
  leasesPath: string | null | undefined
): AkashLeasesForExplorer | null {
  if (!leasesPath) return null;
  if (!existsSync(leasesPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(leasesPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as AkashLeasesForExplorer;
  } catch {
    return null;
  }
}

/**
 * Strip a single trailing slash from a base URL — so that
 * `${base}/tx/${txHash}` doesn't produce `…//tx/…`. Keeps the input intact
 * if it has no trailing slash.
 */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Compute the block-explorer URL for a settled transaction.
 *
 * Returns `undefined` (NOT a placeholder string) when no explorer is
 * resolvable — the dashboard MUST omit the link rather than render a
 * broken one. This is the AC-D4-3 contract.
 *
 * @param chain - Chain family discriminator from the SettlementEvent.
 * @param txHash - On-chain transaction identifier (EVM 0x-hex, Solana base58).
 * @param leases - Parsed leases.json or `null` if unavailable.
 */
export function buildExplorerUrl(
  chain: SettlementChain,
  txHash: string,
  leases: AkashLeasesForExplorer | null
): string | undefined {
  if (!txHash) return undefined;

  if (chain === 'evm') {
    // Prefer Otterscan (current default) over legacy Blockscout. Otterscan
    // uses a hash router; Blockscout is path-routed.
    const otterscan = leases?.otterscan?.url;
    if (typeof otterscan === 'string' && otterscan.length > 0) {
      return `${trimTrailingSlash(otterscan)}/#/tx/${txHash}`;
    }
    const blockscout = leases?.blockscout?.url;
    if (typeof blockscout === 'string' && blockscout.length > 0) {
      return `${trimTrailingSlash(blockscout)}/tx/${txHash}`;
    }
    // No EVM explorer lease → omit the link entirely (AC-D4-3 case 2).
    // We deliberately do NOT fall back to a public mainnet explorer for EVM
    // because an Anvil devnet txHash would 404 there and confuse the demo
    // audience more than no link at all.
    return undefined;
  }

  if (chain === 'solana') {
    const selfHosted = leases?.solana_explorer?.url;
    if (typeof selfHosted === 'string' && selfHosted.length > 0) {
      return `${trimTrailingSlash(selfHosted)}/tx/${txHash}`;
    }
    // Fall back to the public explorer pinned to our custom RPC when the
    // RPC lease is present. Without an RPC lease, the public explorer can't
    // resolve devnet signatures, so omit.
    const rpc = leases?.solana?.url;
    if (typeof rpc === 'string' && rpc.length > 0) {
      const customUrl = encodeURIComponent(rpc);
      return `${PUBLIC_SOLANA_EXPLORER}/tx/${txHash}?cluster=custom&customUrl=${customUrl}`;
    }
    return undefined;
  }

  // Exhaustiveness — if a new SettlementChain lands and isn't wired here,
  // the type-check fails and this branch never runs.
  const _exhaustive: never = chain;
  void _exhaustive;
  return undefined;
}
