/**
 * Tests for resolveConfigNetworkProfile — the precedence + akash mapping that
 * keeps the apex and child nodes in agreement.
 */
import { describe, it, expect } from 'vitest';
import { resolveConfigNetworkProfile } from './network-profile.js';
import { getDefaultConfig } from './defaults.js';
import type { TownhouseConfig, ChainProviderEntry } from './schema.js';

function cfg(over: Partial<TownhouseConfig> = {}): TownhouseConfig {
  return { ...getDefaultConfig(), ...over };
}

describe('resolveConfigNetworkProfile', () => {
  it('defaults (no network) → mainnet Base node env', () => {
    const p = resolveConfigNetworkProfile(cfg());
    expect(p.nodeEnv.EVM_CHAIN).toBe('base-mainnet');
  });

  it('custom + endpoints → akash-anvil + operator URLs reach the node env', () => {
    const p = resolveConfigNetworkProfile(
      cfg({
        network: 'custom',
        endpoints: {
          evmUrl: 'https://anvil.akash',
          solUrl: 'https://sol.akash',
        },
      })
    );
    expect(p.nodeEnv.EVM_CHAIN).toBe('akash-anvil');
    expect(p.nodeEnv.EVM_CHAIN_ID).toBe('31338');
    expect(p.nodeEnv.EVM_RPC_URL).toBe('https://anvil.akash');
    expect(p.nodeEnv.SOLANA_RPC_URL).toBe('https://sol.akash');
    expect(p.status.evm).toBe('configured');
  });

  it('PRECEDENCE: explicit chainProviders win for node env even when network is set', () => {
    // The earlier bug: chainProviders reached the apex but nodes still got the
    // network-default env. Now explicit providers drive the node env too.
    const providers: ChainProviderEntry[] = [
      {
        chainType: 'evm',
        chainId: 'evm:8453',
        rpcUrl: 'https://my-akash-rpc.example',
        registryAddress: '0xReg',
        tokenAddress: '0xUSDC',
        keyId: '0xkey',
      },
    ];
    const p = resolveConfigNetworkProfile(
      cfg({ network: 'mainnet', chainProviders: providers })
    );
    // Not the mainnet Base default — the operator's explicit RPC.
    expect(p.nodeEnv.EVM_RPC_URL).toBe('https://my-akash-rpc.example');
    expect(p.nodeEnv.EVM_CHAIN_ID).toBe('8453');
  });
});
