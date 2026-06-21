/**
 * supported-tokens tests — the per-chain (token, scale) catalog + the
 * resolve/validate logic the operator's settlement selection flows through.
 */

import { describe, it, expect } from 'vitest';
import {
  listSupportedSettlementAssets,
  resolveTownSettlementAsset,
  UnsupportedSettlementError,
} from './supported-tokens.js';
import { getDefaultConfig } from './index.js';
import type { HubConfig } from './schema.js';

/** A config whose only supported chains are the ones we add explicitly. */
function withChainProviders(
  providers: HubConfig['chainProviders']
): HubConfig {
  return {
    ...getDefaultConfig(),
    network: 'custom',
    chainProviders: providers,
  };
}

const EVM = {
  chainType: 'evm' as const,
  chainId: 'evm:base:8453',
  rpcUrl: 'https://mainnet.base.org',
  registryAddress: '0x0000000000000000000000000000000000000001',
  tokenAddress: '0x0000000000000000000000000000000000000002',
};
const SOL = {
  chainType: 'solana' as const,
  chainId: 'solana:devnet',
  rpcUrl: 'https://api.devnet.solana.com',
  programId: 'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG',
};
const MINA = {
  chainType: 'mina' as const,
  chainId: 'mina:devnet',
  graphqlUrl: 'https://example/graphql',
  zkAppAddress: 'B62qExample',
};

describe('listSupportedSettlementAssets', () => {
  it('EVM chain → USDC(6) + ETH(18)', () => {
    const assets = listSupportedSettlementAssets(withChainProviders([EVM]));
    expect(assets).toEqual([
      {
        chainId: 'evm:base:8453',
        chainType: 'evm',
        assetCode: 'USDC',
        assetScale: 6,
        native: false,
      },
      {
        chainId: 'evm:base:8453',
        chainType: 'evm',
        assetCode: 'ETH',
        assetScale: 18,
        native: true,
      },
    ]);
  });

  it('Solana chain → USDC(6) + SOL(9)', () => {
    const assets = listSupportedSettlementAssets(withChainProviders([SOL]));
    expect(assets.map((a) => `${a.assetCode}/${a.assetScale}`)).toEqual([
      'USDC/6',
      'SOL/9',
    ]);
  });

  it('Mina chain → MINA(9) ONLY (no USDC)', () => {
    const assets = listSupportedSettlementAssets(withChainProviders([MINA]));
    expect(assets).toEqual([
      {
        chainId: 'mina:devnet',
        chainType: 'mina',
        assetCode: 'MINA',
        assetScale: 9,
        native: true,
      },
    ]);
  });

  it('surfaces settlement-complete PRESET chains for network=testnet (no chains add)', () => {
    const cfg: HubConfig = { ...getDefaultConfig(), network: 'testnet' };
    const ids = new Set(
      listSupportedSettlementAssets(cfg).map((a) => a.chainId)
    );
    // testnet is settlement-complete on Solana + Mina devnet (and EVM Sepolia).
    expect([...ids].some((id) => id.startsWith('evm:'))).toBe(true);
    expect(ids.has('solana:devnet')).toBe(true);
    expect(ids.has('mina:devnet')).toBe(true);
    // Mina advertises MINA only.
    const minaAssets = listSupportedSettlementAssets(cfg).filter(
      (a) => a.chainId === 'mina:devnet'
    );
    expect(minaAssets.map((a) => a.assetCode)).toEqual(['MINA']);
  });

  it('mainnet has no settlement-ready chains (contracts not deployed)', () => {
    const cfg: HubConfig = { ...getDefaultConfig(), network: 'mainnet' };
    expect(listSupportedSettlementAssets(cfg)).toEqual([]);
  });
});

describe('resolveTownSettlementAsset', () => {
  it('defaults to USDC on the first supported chain when nothing selected', () => {
    const r = resolveTownSettlementAsset(withChainProviders([EVM]), {});
    expect(r).toMatchObject({ assetCode: 'USDC', assetScale: 6 });
  });

  it('selects the native token when asked (ETH on EVM)', () => {
    const r = resolveTownSettlementAsset(withChainProviders([EVM]), {
      settlementChainId: 'evm:base:8453',
      assetCode: 'eth',
    });
    expect(r).toMatchObject({ assetCode: 'ETH', assetScale: 18 });
  });

  it('Mina defaults to (and only allows) MINA', () => {
    const r = resolveTownSettlementAsset(withChainProviders([MINA]), {
      settlementChainId: 'mina:devnet',
    });
    expect(r).toMatchObject({ assetCode: 'MINA', assetScale: 9 });
  });

  it('rejects USDC on Mina (native-only) with a helpful error', () => {
    expect(() =>
      resolveTownSettlementAsset(withChainProviders([MINA]), {
        settlementChainId: 'mina:devnet',
        assetCode: 'USDC',
      })
    ).toThrow(UnsupportedSettlementError);
  });

  it('rejects an unsupported chain, listing the supported ones', () => {
    expect(() =>
      resolveTownSettlementAsset(withChainProviders([EVM]), {
        settlementChainId: 'evm:polygon:137',
      })
    ).toThrow(/Unsupported settlement chain/);
  });

  it('returns undefined when the deployment has no supported chains', () => {
    expect(
      resolveTownSettlementAsset(withChainProviders([]), {})
    ).toBeUndefined();
  });
});
