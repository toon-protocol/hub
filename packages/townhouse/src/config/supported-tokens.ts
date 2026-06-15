/**
 * Supported settlement (chain, token) catalog for the town's kind:10032
 * negotiation values.
 *
 * The protocol settles in the chain's NATIVE token AND (on EVM/Solana) USDC:
 *   - EVM  (Base / Arbitrum): USDC (scale 6)  +  ETH  (scale 18, native)
 *   - Solana:                 USDC (scale 6)  +  SOL  (scale 9, native)
 *   - Mina (devnet):          MINA (scale 9, native) ONLY — no USDC token; the
 *                             connectors support only native MINA for now.
 *
 * The set of *supported chains* for a deployment is the chains its apex can
 * actually settle on — the resolved network profile (mainnet/testnet/devnet
 * presets) UNION any operator `chainProviders` from `townhouse chains add`. We
 * reuse @toon-protocol/core for USDC constants + profile resolution rather than
 * duplicating a catalog that would drift from the connector/SDK source of truth.
 * The native-token scales (ETH 18, SOL 9, MINA 9) are protocol facts encoded
 * here (wei / lamports / nanomina base units).
 */

import { USDC_SYMBOL, USDC_DECIMALS } from '@toon-protocol/core';
import type { TownhouseConfig } from './schema.js';
import { resolveConfigNetworkProfile } from './network-profile.js';

export type ChainFamily = 'evm' | 'solana' | 'mina';

/** One selectable settlement asset on a specific chain. */
export interface SupportedSettlementAsset {
  /** Canonical chain id, e.g. 'evm:base:8453' | 'solana:devnet' | 'mina:devnet'. */
  chainId: string;
  chainType: ChainFamily;
  /** Asset code advertised in kind:10032 (USDC | ETH | SOL | MINA). */
  assetCode: string;
  /** Asset scale / decimals (USDC 6, ETH 18, SOL 9, MINA 9). */
  assetScale: number;
  /** True for the chain's native gas token (ETH/SOL/MINA), false for USDC. */
  native: boolean;
}

/** Native gas token per chain family (wei/lamports/nanomina base units). */
const NATIVE_ASSET: Record<
  ChainFamily,
  { assetCode: string; assetScale: number }
> = {
  evm: { assetCode: 'ETH', assetScale: 18 },
  solana: { assetCode: 'SOL', assetScale: 9 },
  mina: { assetCode: 'MINA', assetScale: 9 },
};

/** The assets settleable on a chain family, in preference order (stable first). */
function assetsForFamily(
  family: ChainFamily
): { assetCode: string; assetScale: number; native: boolean }[] {
  if (family === 'mina') {
    // Mina devnet: native MINA only — connectors have no USDC support yet.
    return [{ ...NATIVE_ASSET.mina, native: true }];
  }
  // EVM / Solana: USDC stable first, then the native gas token.
  return [
    { assetCode: USDC_SYMBOL, assetScale: USDC_DECIMALS, native: false },
    { ...NATIVE_ASSET[family], native: true },
  ];
}

function chainFamilyOf(chainId: string): ChainFamily | undefined {
  if (chainId.startsWith('evm:')) return 'evm';
  if (chainId.startsWith('solana:')) return 'solana';
  if (chainId.startsWith('mina:')) return 'mina';
  return undefined;
}

/**
 * Enumerate the deployment's supported chain ids: operator-configured
 * `chainProviders` first (explicit intent), then the resolved network profile's
 * settlement-complete chains. Deduped, first-seen wins.
 */
function supportedChainIds(config: TownhouseConfig): string[] {
  const ids: string[] = [];
  for (const p of config.chainProviders ?? []) ids.push(p.chainId);
  try {
    // Pass a sentinel keyId so the profile emits chainProviders for the
    // settlement-complete preset tiers (testnet/devnet). Without a keyId the
    // profile returns none (it's the secret-free node-env path). We only read
    // chainId here — the sentinel is never used as a real signing key. Mainnet
    // stays empty by design (TOON settlement contracts aren't deployed there).
    const profile = resolveConfigNetworkProfile(config, 'enumerate-only');
    for (const p of profile.chainProviders) ids.push(p.chainId);
  } catch {
    // Profile resolution failure → fall back to explicit chainProviders only.
  }
  return [...new Set(ids)].filter((id) => chainFamilyOf(id) !== undefined);
}

/** Every selectable (chain, token) pair this deployment supports. */
export function listSupportedSettlementAssets(
  config: TownhouseConfig
): SupportedSettlementAsset[] {
  const out: SupportedSettlementAsset[] = [];
  for (const chainId of supportedChainIds(config)) {
    const family = chainFamilyOf(chainId);
    if (!family) continue;
    for (const a of assetsForFamily(family)) {
      out.push({ chainId, chainType: family, ...a });
    }
  }
  return out;
}

/** Error thrown when an operator selects an unsupported chain/asset. */
export class UnsupportedSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSettlementError';
  }
}

/**
 * Resolve + validate the town's advertised settlement asset from the operator's
 * selection (settlementChainId + optional assetCode), against the deployment's
 * supported set. Rules:
 *   - chainId, when given, must be a supported chain (else throws, listing them);
 *   - assetCode, when given, must be settleable on that chain (else throws,
 *     listing that chain's assets — e.g. Mina ⇒ MINA only);
 *   - assetCode omitted ⇒ the chain's default (USDC where supported, else native);
 *   - chainId omitted ⇒ the deployment's first supported chain is used for the
 *     default; returns undefined only when the deployment has no supported chains.
 * `assetScale` is always derived from the resolved asset (never operator-typed).
 */
export function resolveTownSettlementAsset(
  config: TownhouseConfig,
  selection: { settlementChainId?: string; assetCode?: string }
): SupportedSettlementAsset | undefined {
  const all = listSupportedSettlementAssets(config);
  if (all.length === 0) return undefined;

  const chainId = selection.settlementChainId ?? all[0]?.chainId;
  if (chainId === undefined) return undefined;

  const onChain = all.filter((a) => a.chainId === chainId);
  if (onChain.length === 0) {
    const chains = [...new Set(all.map((a) => a.chainId))].join(', ');
    throw new UnsupportedSettlementError(
      `Unsupported settlement chain '${chainId}'. This deployment supports: ${chains}. ` +
        `Add a chain with 'townhouse chains add' or change 'network', then retry.`
    );
  }

  if (selection.assetCode === undefined) {
    // Default: first listed (USDC where present, else the native token).
    return onChain[0];
  }

  const want = selection.assetCode.toUpperCase();
  const match = onChain.find((a) => a.assetCode.toUpperCase() === want);
  if (!match) {
    const assets = onChain.map((a) => a.assetCode).join(', ');
    throw new UnsupportedSettlementError(
      `Unsupported asset '${selection.assetCode}' on ${chainId}. Supported on this chain: ${assets}.`
    );
  }
  return match;
}
