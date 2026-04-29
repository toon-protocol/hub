/**
 * Unit Tests: ConnectorConfigGenerator (Story 21.3)
 *
 * Test IDs map to test-design-epic-21.md scenarios T-016, T-019.
 *
 * These tests verify:
 * - AC #1: Connector config generated from Townhouse config
 * - AC #5: ATOR transport toggle
 */

import { describe, it, expect } from 'vitest';

import type { TownhouseConfig } from '../config/schema.js';
import { getDefaultConfig } from '../config/defaults.js';
import { ConnectorConfigGenerator } from './config-generator.js';
import type { PeerEntry } from './types.js';

/**
 * Factory: creates a TownhouseConfig with selected nodes enabled.
 */
function configWithNodes(
  enabled: ('town' | 'mill' | 'dvm')[],
  overrides: Partial<TownhouseConfig> = {}
): TownhouseConfig {
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
        btpUrl: 'btp+ws://townhouse-town:3000',
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
        btpUrl: 'btp+ws://townhouse-mill:3000',
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

      expect(townPeer?.btpUrl).toBe('btp+ws://townhouse-town:3000');
      expect(millPeer?.btpUrl).toBe('btp+ws://townhouse-mill:3000');
      expect(dvmPeer?.btpUrl).toBe('btp+ws://townhouse-dvm:3000');
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
    it('includes SOCKS proxy when transport mode is ator', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'ator';
      config.transport.socksProxy = 'socks5h://proxy.ator.io:9050';
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.transport.mode).toBe('ator');
      expect(result.transport.socksProxy).toBe('socks5h://proxy.ator.io:9050');
    });

    it('uses default ATOR proxy when mode is ator but socksProxy not set', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'ator';
      // No socksProxy set
      const generator = new ConnectorConfigGenerator(config);
      const result = generator.generate(['town']);

      expect(result.transport.mode).toBe('ator');
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

    it('includes SOCKS_PROXY env var when transport mode is ator', () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'ator';
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
});
