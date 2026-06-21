/**
 * Unit Tests: ConnectorConfigGenerator (Story 21.3)
 *
 * Test IDs map to test-design-epic-21.md scenarios T-016, T-019.
 *
 * These tests verify:
 * - AC #1: Connector config generated from Hub config
 * - AC #5: ATOR transport toggle
 */

import { describe, it, expect } from 'vitest';

import type { HubConfig } from '../config/schema.js';
import { getDefaultConfig } from '../config/defaults.js';
import { ConnectorConfigGenerator } from './config-generator.js';
import type { PeerEntry } from './types.js';

/**
 * Factory: creates a HubConfig with selected nodes enabled.
 */
function configWithNodes(
  enabled: ('town' | 'mill' | 'dvm')[],
  overrides: Partial<HubConfig> = {}
): HubConfig {
  const config = getDefaultConfig();
  for (const node of enabled) {
    config.nodes[node].enabled = true;
  }
  return { ...config, ...overrides };
}

describe('ConnectorConfigGenerator', () => {
  // ── T-016: Connector config generated with correct peer list for active nodes ──

  describe('generate() — peer list generation (T-016)', () => {
    it('generates peer list with Town only when only Town is active', () => {
      const config = configWithNodes(['town']);
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.peers).toHaveLength(1);
      expect(result.peers[0]).toMatchObject({
        id: 'town',
        relation: 'child',
        btpUrl: 'btp+ws://hub-town:3000',
        assetCode: 'USD',
        assetScale: 6,
      });
    });

    it('generates peer list with Mill only when only Mill is active', () => {
      const config = configWithNodes(['mill']);
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['mill']);

      expect(result.peers).toHaveLength(1);
      expect(result.peers[0]).toMatchObject({
        id: 'mill',
        relation: 'child',
        btpUrl: 'btp+ws://hub-mill:3000',
        assetCode: 'USD',
        assetScale: 6,
      });
    });

    it('generates peer list with all three nodes when all are active', () => {
      const config = configWithNodes(['town', 'mill', 'dvm']);
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town', 'mill', 'dvm']);

      expect(result.peers).toHaveLength(3);
      const peerIds = result.peers.map((p: PeerEntry) => p.id);
      expect(peerIds).toContain('town');
      expect(peerIds).toContain('mill');
      expect(peerIds).toContain('dvm');
    });

    it('generates empty peer list when no nodes are active', () => {
      const config = configWithNodes([]);
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate([]);

      expect(result.peers).toHaveLength(0);
    });

    it('only includes nodes in the activeNodes list, ignoring enabled config', () => {
      // Config has all nodes enabled, but only town is in activeNodes
      const config = configWithNodes(['town', 'mill', 'dvm']);
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.peers).toHaveLength(1);
      expect(result.peers[0].id).toBe('town');
    });

    it('uses correct BTP URL format for Docker networking', () => {
      const config = configWithNodes(['town', 'mill', 'dvm']);
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town', 'mill', 'dvm']);

      const townPeer = result.peers.find((p: PeerEntry) => p.id === 'town');
      const millPeer = result.peers.find((p: PeerEntry) => p.id === 'mill');
      const dvmPeer = result.peers.find((p: PeerEntry) => p.id === 'dvm');

      expect(townPeer?.btpUrl).toBe('btp+ws://hub-town:3000');
      expect(millPeer?.btpUrl).toBe('btp+ws://hub-mill:3000');
      expect(dvmPeer?.btpUrl).toBe('btp+ws://hub-dvm:3000');
    });
  });

  describe('generate() — base config fields', () => {
    it('sets adminPort from connector config', () => {
      const config = configWithNodes(['town']);
      config.connector.adminPort = 9401;
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.adminPort).toBe(9401);
    });

    it('sets ilpAddress to default g.townhouse', () => {
      const config = configWithNodes(['town']);
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.ilpAddress).toBe('g.townhouse');
    });
  });

  // ── T-019: ATOR toggle ──

  describe('generate() — ATOR transport config (T-019)', () => {
    it('includes SOCKS proxy when transport mode is hs', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      config.transport.socksProxy = 'socks5h://proxy.ator.io:9050';
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.transport.mode).toBe('hs');
      expect(result.transport.socksProxy).toBe('socks5h://proxy.ator.io:9050');
    });

    it('uses default ATOR proxy when mode is hs but socksProxy not set', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      // No socksProxy set
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.transport.mode).toBe('hs');
      expect(result.transport.socksProxy).toBe('socks5h://proxy.ator.io:9050');
    });

    it('does not include socksProxy when transport mode is direct', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'direct';
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.transport.mode).toBe('direct');
      expect(result.transport.socksProxy).toBeUndefined();
    });
  });

  // ── Environment variable serialization ──

  describe('toEnvVars() — env var serialization (T-016)', () => {
    it('serializes config to CONNECTOR_ADMIN_PORT env var', () => {
      const config = configWithNodes(['town']);
      config.connector.adminPort = 9401;
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const envVars = generator.toEnvVars(runtimeConfig);

      expect(envVars['CONNECTOR_ADMIN_PORT']).toBe('9401');
    });

    it('serializes config to CONNECTOR_ILP_ADDRESS env var', () => {
      const config = configWithNodes(['town']);
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const envVars = generator.toEnvVars(runtimeConfig);

      expect(envVars['CONNECTOR_ILP_ADDRESS']).toBe('g.townhouse');
    });

    it('serializes peer list to CONNECTOR_PEERS as JSON', () => {
      const config = configWithNodes(['town', 'mill']);
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town', 'mill']);
      const envVars = generator.toEnvVars(runtimeConfig);

      const peers = JSON.parse(envVars['CONNECTOR_PEERS']);
      expect(peers).toHaveLength(2);
      expect(peers[0].id).toBe('town');
      expect(peers[1].id).toBe('mill');
    });

    it('serializes TRANSPORT_MODE env var', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'direct';
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const envVars = generator.toEnvVars(runtimeConfig);

      expect(envVars['TRANSPORT_MODE']).toBe('direct');
    });

    it('includes SOCKS_PROXY env var when transport mode is hs', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      config.transport.socksProxy = 'socks5h://proxy.ator.io:9050';
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const envVars = generator.toEnvVars(runtimeConfig);

      expect(envVars['SOCKS_PROXY']).toBe('socks5h://proxy.ator.io:9050');
    });

    it('does not include SOCKS_PROXY env var when transport mode is direct', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'direct';
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const envVars = generator.toEnvVars(runtimeConfig);

      expect(envVars['SOCKS_PROXY']).toBeUndefined();
    });
  });

  describe('toEnvArray() — string[] format for dockerode', () => {
    it('converts env vars Record to KEY=VALUE string array', () => {
      const config = configWithNodes(['town']);
      config.connector.adminPort = 9401;
      config.transport.mode = 'direct';
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const envArray = generator.toEnvArray(runtimeConfig);

      expect(envArray).toContain('CONNECTOR_ADMIN_PORT=9401');
      expect(envArray).toContain('CONNECTOR_ILP_ADDRESS=g.townhouse');
      expect(envArray).toContain('TRANSPORT_MODE=direct');
      expect(
        envArray.some((e: string) => e.startsWith('CONNECTOR_PEERS='))
      ).toBe(true);
    });

    it('returns string[] compatible with dockerode Env option', () => {
      const config = configWithNodes(['town']);
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const envArray = generator.toEnvArray(runtimeConfig);

      // Every entry must be a string matching KEY=VALUE format
      for (const entry of envArray) {
        expect(entry).toMatch(/^[A-Z_]+=.+$/);
      }
    });
  });

  // ── Hidden-service config (Story 35.5 connector contract) ──

  describe('generate() — hidden service surface', () => {
    it('passes through hiddenService when transport.mode is hs', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      config.transport.hiddenService = {
        dir: '/var/lib/anon/hs',
        port: 3000,
      };
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.transport.hiddenService).toEqual({
        dir: '/var/lib/anon/hs',
        port: 3000,
      });
    });

    it('passes through externalUrl when set explicitly', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      config.transport.externalUrl = 'wss://known.anyone/btp';
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.transport.externalUrl).toBe('wss://known.anyone/btp');
    });
  });

  describe('toEnvVars() — hidden service env vars', () => {
    it('emits TRANSPORT_HIDDEN_SERVICE_DIR + PORT when hiddenService is set', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      config.transport.hiddenService = {
        dir: '/var/lib/anon/hs',
        port: 3000,
      };
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const envVars = generator.toEnvVars(runtimeConfig);

      expect(envVars['TRANSPORT_HIDDEN_SERVICE_DIR']).toBe('/var/lib/anon/hs');
      expect(envVars['TRANSPORT_HIDDEN_SERVICE_PORT']).toBe('3000');
    });

    it('does not emit hidden-service env vars when hiddenService unset', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'direct';
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const envVars = generator.toEnvVars(runtimeConfig);

      expect(envVars['TRANSPORT_HIDDEN_SERVICE_DIR']).toBeUndefined();
      expect(envVars['TRANSPORT_HIDDEN_SERVICE_PORT']).toBeUndefined();
    });
  });

  describe('toYaml() — connector wire-format translation', () => {
    // Important: the connector's YAML schema uses transport.type (not .mode)
    // and expects a discriminated union with 'direct' | 'socks5'. The
    // previous shape (mode: 'hs') was silently ignored by the connector,
    // which defaulted to direct. These tests pin the post-fix wire format.

    it('emits transport.type=direct for mode=direct', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'direct';
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const yaml = generator.toYaml(runtimeConfig);

      expect(yaml).toMatch(/transport:\s*\n\s+type:\s*direct/);
      expect(yaml).not.toMatch(/socksProxy/);
    });

    it('emits type=socks5 + externalUrl + managed=false for hs + externalUrl', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      config.transport.socksProxy = 'socks5h://proxy.ator.io:9050';
      config.transport.externalUrl = 'wss://operator.example/btp';
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const yaml = generator.toYaml(runtimeConfig);

      expect(yaml).toMatch(/type:\s*socks5/);
      expect(yaml).toMatch(/socksProxy:\s*socks5h:\/\/proxy\.ator\.io:9050/);
      expect(yaml).toMatch(/externalUrl:\s*wss:\/\/operator\.example\/btp/);
      expect(yaml).toMatch(/managed:\s*false/);
      expect(yaml).not.toMatch(/managedOptions/);
    });

    it('emits managed=true + managedOptions + externalUrl=auto for hs + hiddenService', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      config.transport.socksProxy = 'socks5h://127.0.0.1:9050';
      config.transport.hiddenService = {
        dir: '/var/lib/anon/hs',
        port: 3000,
      };
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const yaml = generator.toYaml(runtimeConfig);

      expect(yaml).toMatch(/type:\s*socks5/);
      expect(yaml).toMatch(/externalUrl:\s*auto/);
      expect(yaml).toMatch(/managed:\s*true/);
      expect(yaml).toMatch(/managedOptions:/);
      expect(yaml).toMatch(/hiddenServiceDir:\s*\/var\/lib\/anon\/hs/);
      expect(yaml).toMatch(/hiddenServicePort:\s*3000/);
    });

    it('forwards hiddenService timeouts into managedOptions when set', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      config.transport.hiddenService = {
        dir: '/var/lib/anon/hs',
        port: 3000,
        startupTimeoutMs: 90000,
        stopTimeoutMs: 15000,
      };
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const yaml = generator.toYaml(runtimeConfig);

      expect(yaml).toMatch(/startupTimeoutMs:\s*90000/);
      expect(yaml).toMatch(/stopTimeoutMs:\s*15000/);
    });

    it('honors explicit hiddenService.externalUrl (operator override of "auto")', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      config.transport.externalUrl = 'wss://forced.anyone/btp';
      config.transport.hiddenService = {
        dir: '/var/lib/anon/hs',
        port: 3000,
      };
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const yaml = generator.toYaml(runtimeConfig);

      // managed=true (HS is set) BUT externalUrl is the explicit value, not 'auto'
      expect(yaml).toMatch(/managed:\s*true/);
      expect(yaml).toMatch(/externalUrl:\s*wss:\/\/forced\.anyone\/btp/);
      expect(yaml).not.toMatch(/externalUrl:\s*auto/);
    });
  });

  // ── chainProviders emission (Epic 47 BUG-1 product fix, D2) ──────────────
  describe('toYaml() — chainProviders emission (Epic 47 BUG-1)', () => {
    it('omits chainProviders when config.chainProviders is undefined', () => {
      const config = configWithNodes(['town']);
      // chainProviders intentionally not set
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const yaml = generator.toYaml(runtimeConfig);

      expect(yaml).not.toMatch(/^chainProviders:/m);
    });

    it('omits chainProviders when config.chainProviders is an empty array', () => {
      const config = configWithNodes(['town'], { chainProviders: [] });
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const yaml = generator.toYaml(runtimeConfig);

      expect(yaml).not.toMatch(/^chainProviders:/m);
    });

    it('emits chainProviders block when configured', () => {
      const config = configWithNodes(['town'], {
        chainProviders: [
          {
            chainType: 'evm',
            chainId: 'evm:base:31337',
            rpcUrl: 'http://127.0.0.1:8545',
            registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
            tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
            keyId:
              '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
          },
        ],
      });
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const yaml = generator.toYaml(runtimeConfig);

      expect(yaml).toMatch(/^chainProviders:/m);
      expect(yaml).toMatch(/chainType:\s*evm/);
      expect(yaml).toMatch(/chainId:\s*evm:base:31337/);
      expect(yaml).toMatch(/rpcUrl:\s*http:\/\/127\.0\.0\.1:8545/);
      expect(yaml).toMatch(
        /registryAddress:.*0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512/
      );
      expect(yaml).toMatch(
        /tokenAddress:.*0x5FbDB2315678afecb367f032d93F642f64180aa3/
      );
      expect(yaml).toMatch(
        /keyId:.*0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6/
      );
    });

    it('emits a Solana chainProvider with programId (not registry/token)', () => {
      const config = configWithNodes(['town'], {
        chainProviders: [
          {
            chainType: 'solana',
            chainId: 'solana:devnet',
            rpcUrl: 'https://api.devnet.solana.com',
            wsUrl: 'wss://api.devnet.solana.com',
            programId: 'PpayMENtCha1Ne1Program111111111111111111111',
            tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            keyId: 'solana-treasury',
          },
        ],
      });
      const generator = new ConnectorConfigGenerator(config);
      const yaml = generator.toYaml(generator.generate(['town']));

      expect(yaml).toMatch(/chainType:\s*solana/);
      expect(yaml).toMatch(/chainId:\s*solana:devnet/);
      expect(yaml).toMatch(
        /programId:\s*PpayMENtCha1Ne1Program111111111111111111111/
      );
      expect(yaml).toMatch(/wsUrl:\s*wss:\/\/api\.devnet\.solana\.com/);
      expect(yaml).toMatch(
        /tokenMint:\s*EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/
      );
      // EVM-only fields must NOT appear for a Solana entry.
      expect(yaml).not.toMatch(/registryAddress:/);
      expect(yaml).not.toMatch(/tokenAddress:/);
    });

    it('emits a Mina chainProvider with graphqlUrl + zkAppAddress', () => {
      const config = configWithNodes(['town'], {
        chainProviders: [
          {
            chainType: 'mina',
            chainId: 'mina:devnet',
            graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
            zkAppAddress:
              'B62qpayMENtCha1Ne1zkApp1111111111111111111111111111111',
          },
        ],
      });
      const generator = new ConnectorConfigGenerator(config);
      const yaml = generator.toYaml(generator.generate(['town']));

      expect(yaml).toMatch(/chainType:\s*mina/);
      expect(yaml).toMatch(/chainId:\s*mina:devnet/);
      expect(yaml).toMatch(/graphqlUrl:/);
      expect(yaml).toMatch(
        /zkAppAddress:\s*B62qpayMENtCha1Ne1zkApp1111111111111111111111111111111/
      );
      expect(yaml).not.toMatch(/rpcUrl:/);
      expect(yaml).not.toMatch(/registryAddress:/);
    });

    it('emits multiple chainProviders entries as a list', () => {
      const config = configWithNodes(['town'], {
        chainProviders: [
          {
            chainType: 'evm',
            chainId: 'evm:base:31337',
            rpcUrl: 'http://127.0.0.1:8545',
            registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
            tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
            keyId:
              '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
          },
          {
            chainType: 'evm',
            chainId: 'evm:base:8453',
            rpcUrl: 'https://mainnet.base.org',
            registryAddress: '0xaaaa1725E7734CE288F8367e1Bb143E90bb3F0512',
            tokenAddress: '0xbbbbb2315678afecb367f032d93F642f64180aa3',
            keyId:
              '0xccccc118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
          },
        ],
      });
      const generator = new ConnectorConfigGenerator(config);
      const runtimeConfig = generator.generate(['town']);
      const yaml = generator.toYaml(runtimeConfig);

      // Both chainIds appear; YAML list rendering has at least two `chainType:` keys.
      const chainTypeOccurrences = (yaml.match(/chainType:/g) ?? []).length;
      expect(chainTypeOccurrences).toBe(2);
      expect(yaml).toMatch(/chainId:\s*evm:base:31337/);
      expect(yaml).toMatch(/chainId:\s*evm:base:8453/);
    });

    it('omits settlementOptions when not configured on an EVM provider', () => {
      const config = configWithNodes(['town'], {
        chainProviders: [
          {
            chainType: 'evm',
            chainId: 'evm:base:31337',
            rpcUrl: 'http://127.0.0.1:8545',
            registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
            tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
            keyId:
              '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
          },
        ],
      });
      const generator = new ConnectorConfigGenerator(config);
      const yaml = generator.toYaml(generator.generate(['town']));

      expect(yaml).not.toMatch(/settlementOptions:/);
    });

    it('passes through settlementOptions.threshold on an EVM provider so the connector lowers its global settlement threshold (non-EVM SETTLE fix)', () => {
      const config = configWithNodes(['town'], {
        chainProviders: [
          {
            chainType: 'evm',
            chainId: 'evm:base:31337',
            rpcUrl: 'http://127.0.0.1:8545',
            registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
            tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
            keyId:
              '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
            settlementOptions: {
              threshold: '1',
              settlementTimeoutSecs: 86400,
              initialDepositMultiplier: 2,
            },
          },
        ],
      });
      const generator = new ConnectorConfigGenerator(config);
      const yaml = generator.toYaml(generator.generate(['town']));

      expect(yaml).toMatch(/settlementOptions:/);
      // threshold below the 1_000_000 per-publish fee → a single paid publish
      // crosses the connector's `cumulativeAmount > threshold` trigger.
      expect(yaml).toMatch(/threshold:\s*['"]?1['"]?/);
      expect(yaml).toMatch(/settlementTimeoutSecs:\s*86400/);
      expect(yaml).toMatch(/initialDepositMultiplier:\s*2/);
    });

    it('does not emit settlementOptions for Solana/Mina providers (connector reads threshold only from EVM)', () => {
      const config = configWithNodes(['town'], {
        chainProviders: [
          {
            chainType: 'solana',
            chainId: 'solana:devnet',
            rpcUrl: 'https://api.devnet.solana.com',
            programId: 'PpayMENtCha1Ne1Program111111111111111111111',
            tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          },
        ],
      });
      const generator = new ConnectorConfigGenerator(config);
      const yaml = generator.toYaml(generator.generate(['town']));

      expect(yaml).toMatch(/chainType:\s*solana/);
      expect(yaml).not.toMatch(/settlementOptions:/);
    });
  });
});
