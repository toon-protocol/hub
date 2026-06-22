/**
 * Tests for resolveConfigNetworkProfile — the precedence + akash mapping that
 * keeps the apex and child nodes in agreement.
 */
import { describe, it, expect } from 'vitest';
import { resolveConfigNetworkProfile } from './network-profile.js';
import { getDefaultConfig } from './defaults.js';
import type { HubConfig, ChainProviderEntry } from './schema.js';

function cfg(over: Partial<HubConfig> = {}): HubConfig {
  return { ...getDefaultConfig(), ...over };
}

describe('resolveConfigNetworkProfile', () => {
  it('defaults (no network) → settlement-complete testnet Base node env', () => {
    // Regression: an unset network must NOT resolve to base-mainnet (which has
    // no deployed TOON settlement contracts and silently degrades the node to
    // relay-only / DEVELOPMENT MODE). It defaults to the settlement-ready
    // testnet tier (Base Sepolia) so a provisioned node points at a real chain.
    const p = resolveConfigNetworkProfile(cfg());
    expect(p.nodeEnv.EVM_CHAIN).toBe('base-sepolia');
    expect(p.nodeEnv.EVM_CHAIN_ID).toBe('84532');
  });

  it('apex providers for unset network are settlement-complete (testnet)', () => {
    // With a keyId (the apex path) the default tier must emit real
    // chainProviders + report evm:configured — the whole point of the fix.
    const p = resolveConfigNetworkProfile(cfg(), '0xkey');
    expect(p.status.evm).toBe('configured');
    expect(p.chainProviders.length).toBeGreaterThan(0);
  });

  it('explicit network=mainnet → relay-only (no EVM settlement)', () => {
    // Operators can still opt into mainnet, but it is honestly relay-only until
    // TOON contracts ship there.
    const p = resolveConfigNetworkProfile(cfg({ network: 'mainnet' }), '0xkey');
    expect(p.nodeEnv.EVM_CHAIN).toBe('base-mainnet');
    expect(p.status.evm).toBe('unconfigured');
  });

  it('custom + endpoints → anvil (31337) + operator URLs reach the node env', () => {
    const p = resolveConfigNetworkProfile(
      cfg({
        network: 'custom',
        endpoints: {
          evmUrl: 'https://anvil.akash',
          solUrl: 'https://sol.akash',
        },
      })
    );
    expect(p.nodeEnv.EVM_CHAIN).toBe('anvil');
    expect(p.nodeEnv.EVM_CHAIN_ID).toBe('31337');
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
