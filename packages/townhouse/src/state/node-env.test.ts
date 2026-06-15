/**
 * node-env tests — assembleNodeEnv operator/negotiation injection + the
 * resolvePublicBtpUrl precedence used for the town's kind:10032.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  assembleNodeEnv,
  resolvePublicBtpUrl,
  type AssembleNodeEnvParams,
} from './node-env.js';
import { getDefaultConfig } from '../config/index.js';
import type { TownhouseConfig } from '../config/schema.js';

function baseParams(
  over: Partial<AssembleNodeEnvParams> = {}
): AssembleNodeEnvParams {
  return {
    type: 'town',
    nostrSecretKeyHex: '11'.repeat(32),
    nostrPubkey: 'a'.repeat(64),
    evmPrivateKeyHex: '22'.repeat(32),
    mnemonic: 'test mnemonic',
    apexEvmAddress: '0x' + 'a'.repeat(40),
    config: getDefaultConfig(),
    ...over,
  };
}

function withTown(
  over: Partial<TownhouseConfig['nodes']['town']>
): TownhouseConfig {
  const base = getDefaultConfig();
  return {
    ...base,
    // Explicit EVM provider → deterministic supported set (USDC + ETH) for the
    // asset derivation, independent of network-preset resolution.
    network: 'custom',
    chainProviders: [
      {
        chainType: 'evm',
        chainId: 'evm:base:8453',
        rpcUrl: 'https://mainnet.base.org',
        registryAddress: '0x0000000000000000000000000000000000000001',
        tokenAddress: '0x0000000000000000000000000000000000000002',
      },
    ],
    nodes: { ...base.nodes, town: { ...base.nodes.town, ...over } },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('assembleNodeEnv — town negotiation values', () => {
  it('injects PUBLIC_BTP_URL, FEE_PER_EVENT, and the derived USDC asset', () => {
    // getDefaultConfig() resolves to mainnet → EVM (Base/Arbitrum) supported.
    const config = withTown({ feePerEvent: 1000, assetCode: 'USDC' });
    const env = assembleNodeEnv(
      baseParams({ type: 'town', config, publicBtpUrl: 'wss://abc.anyone/btp' })
    );
    expect(env['PUBLIC_BTP_URL']).toBe('wss://abc.anyone/btp');
    expect(env['FEE_PER_EVENT']).toBe('1000');
    expect(env['ASSET_CODE']).toBe('USDC');
    expect(env['ASSET_SCALE']).toBe('6'); // derived, not from config
    expect(env['TOWN_SECRET_KEY']).toBe('11'.repeat(32));
  });

  it('derives the native asset (ETH/18) when assetCode=ETH on an EVM chain', () => {
    const config = withTown({ assetCode: 'ETH' });
    const env = assembleNodeEnv(baseParams({ type: 'town', config }));
    expect(env['ASSET_CODE']).toBe('ETH');
    expect(env['ASSET_SCALE']).toBe('18');
  });

  it('defaults the asset to USDC/6 when no token is selected', () => {
    const env = assembleNodeEnv(
      baseParams({ type: 'town', config: withTown({}) })
    );
    // No publicBtpUrl / fee provided → omitted; asset defaults to USDC.
    expect(env).not.toHaveProperty('PUBLIC_BTP_URL');
    expect(env).not.toHaveProperty('FEE_PER_EVENT');
    expect(env['ASSET_CODE']).toBe('USDC');
    expect(env['ASSET_SCALE']).toBe('6');
  });

  it('does not inject town vars for non-town node types', () => {
    const config = withTown({ feePerEvent: 1000 });
    const env = assembleNodeEnv(
      baseParams({ type: 'dvm', config, publicBtpUrl: 'wss://x/btp' })
    );
    expect(env).not.toHaveProperty('PUBLIC_BTP_URL');
    expect(env).not.toHaveProperty('FEE_PER_EVENT');
    expect(env).not.toHaveProperty('ASSET_CODE');
  });
});

describe('resolvePublicBtpUrl', () => {
  it('uses transport.externalUrl override, normalised to /btp', () => {
    const base = getDefaultConfig();
    const config: TownhouseConfig = {
      ...base,
      transport: { ...base.transport, externalUrl: 'wss://op.example' },
    };
    expect(resolvePublicBtpUrl(config)).toBe('wss://op.example/btp');
  });

  it('keeps an externalUrl that already ends in /btp', () => {
    const base = getDefaultConfig();
    const config: TownhouseConfig = {
      ...base,
      transport: { ...base.transport, externalUrl: 'wss://op.example/btp' },
    };
    expect(resolvePublicBtpUrl(config)).toBe('wss://op.example/btp');
  });

  it('builds wss://<hostname>/btp whenever a .anyone hostname is resolved', () => {
    const base = getDefaultConfig();
    const config: TownhouseConfig = {
      ...base,
      transport: { mode: 'hs', externalUrl: 'auto' },
    };
    expect(resolvePublicBtpUrl(config, 'abc.anyone')).toBe(
      'wss://abc.anyone/btp'
    );
  });

  it('prefers the resolved hostname even when config.mode is still "direct"', () => {
    // Regression (live E2E): `hs up` does not rewrite config.transport.mode, so
    // a hidden-service apex carries mode:'direct' in config.yaml. The presence
    // of a host.json hostname must still yield the .anyone URL, not loopback.
    const config = getDefaultConfig(); // mode: 'direct'
    expect(resolvePublicBtpUrl(config, 'abc.anyone')).toBe(
      'wss://abc.anyone/btp'
    );
  });

  it('HS config with no resolved hostname yet returns undefined', () => {
    const base = getDefaultConfig();
    const config: TownhouseConfig = {
      ...base,
      transport: { mode: 'hs', externalUrl: 'auto' },
    };
    expect(resolvePublicBtpUrl(config, undefined)).toBeUndefined();
  });

  it('direct mode with no hostname falls back to the loopback dial URL', () => {
    const config = getDefaultConfig(); // mode: 'direct'
    expect(resolvePublicBtpUrl(config)).toBe('ws://127.0.0.1:3000/btp');
  });
});
