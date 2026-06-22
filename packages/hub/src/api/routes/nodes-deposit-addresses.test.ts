/**
 * Tests for GET /nodes/:nodeId/deposit-addresses (AC-4, Story 21.11).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerNodeRoutes } from './nodes.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { getDefaultConfig } from '../../config/defaults.js';

const MOCK_MILL_KEYS = {
  nostrPubkey: 'a'.repeat(64),
  nostrSecretKey: new Uint8Array(32),
  evmAddress: '0xDeadBeef0000000000000000000000000000dEaD',
  evmPrivateKey: new Uint8Array(32),
  nostrDerivationPath: "m/44'/1237'/1'/0/0",
  evmDerivationPath: "m/44'/60'/1'/0/0",
  solanaAddress: '5TLLZ7DYbJm9DKGnePGCKMbKYDPuMwvMxjvPhQMjFNkU',
  minaAddress: 'deadbeef'.repeat(8),
};

const MOCK_TOWN_KEYS = {
  nostrPubkey: 'b'.repeat(64),
  nostrSecretKey: new Uint8Array(32),
  evmAddress: '0xCafeBabe0000000000000000000000000000CAFE',
  evmPrivateKey: new Uint8Array(32),
  nostrDerivationPath: "m/44'/1237'/0'/0/0",
  evmDerivationPath: "m/44'/60'/0'/0/0",
};

class MockOrchestrator {
  async status() {
    return [];
  }
  async getNodeHealthEndpoint() {
    return 'http://127.0.0.1:3200';
  }
  async getContainerStats() {
    return null;
  }
  on() {
    return this;
  }
  off() {
    return this;
  }
}

class MockWalletManager {
  getNodeKeys(type: string) {
    if (type === 'mill') return MOCK_MILL_KEYS;
    if (type === 'town') return MOCK_TOWN_KEYS;
    if (type === 'dvm') return MOCK_TOWN_KEYS;
    throw new Error('wallet_not_initialized');
  }
  listKeys() {
    return [];
  }
}

class MockWalletManagerNoInit {
  getNodeKeys() {
    throw new Error('Wallet not initialized');
  }
  listKeys() {
    return [];
  }
}

class MockConnectorAdmin {
  async getMetrics() {
    return {
      aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 },
      peers: [],
    };
  }
  async getPeers() {
    return [];
  }
  async getPacketLog() {
    return [];
  }
}

function buildDeps(
  wallet: MockWalletManager | MockWalletManagerNoInit
): ApiDeps {
  return {
    configPath: '/tmp/test.yaml',
    config: getDefaultConfig(),
    orchestrator: new MockOrchestrator() as unknown as DockerOrchestrator,
    wallet: wallet as unknown as WalletManager,
    connectorAdmin: new MockConnectorAdmin() as unknown as ConnectorAdminClient,
  };
}

describe('GET /nodes/:nodeId/deposit-addresses (AC-4, Story 21.11)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
  });

  it('mill returns evm + solana + mina families', async () => {
    registerNodeRoutes(app, buildDeps(new MockWalletManager()));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/mill/deposit-addresses',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.chains).toHaveLength(3);
    const families = body.chains.map((c: { family: string }) => c.family);
    expect(families).toContain('evm');
    expect(families).toContain('solana');
    expect(families).toContain('mina');
    const evmEntry = body.chains.find(
      (c: { family: string }) => c.family === 'evm'
    );
    expect(evmEntry.address).toBe(MOCK_MILL_KEYS.evmAddress);
    const solEntry = body.chains.find(
      (c: { family: string }) => c.family === 'solana'
    );
    expect(solEntry.address).toBe(MOCK_MILL_KEYS.solanaAddress);
  });

  it('town returns evm-only', async () => {
    registerNodeRoutes(app, buildDeps(new MockWalletManager()));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/town/deposit-addresses',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.chains).toHaveLength(1);
    expect(body.chains[0].family).toBe('evm');
    expect(body.chains[0].address).toBe(MOCK_TOWN_KEYS.evmAddress);
  });

  it('dvm returns evm-only', async () => {
    registerNodeRoutes(app, buildDeps(new MockWalletManager()));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/dvm/deposit-addresses',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.chains).toHaveLength(1);
    expect(body.chains[0].family).toBe('evm');
  });

  it('returns 404 for unknown nodeId', async () => {
    registerNodeRoutes(app, buildDeps(new MockWalletManager()));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/unknown/deposit-addresses',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('unknown_node');
  });

  it('returns 503 when wallet not initialized', async () => {
    registerNodeRoutes(app, buildDeps(new MockWalletManagerNoInit()));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/mill/deposit-addresses',
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe('wallet_not_initialized');
  });

  it('multi-instance: dev-mill-01 resolves to mill keys', async () => {
    const orch = {
      async status() {
        return [
          { name: 'dev-mill-01', type: 'mill', state: 'running' },
          { name: 'dev-mill-02', type: 'mill', state: 'running' },
        ];
      },
      async getNodeHealthEndpoint() {
        return 'http://127.0.0.1:3200';
      },
      async getContainerStats() {
        return null;
      },
      on() {
        return this;
      },
      off() {
        return this;
      },
    };
    const deps: ApiDeps = {
      configPath: '/tmp/test.yaml',
      config: getDefaultConfig(),
      orchestrator: orch as unknown as DockerOrchestrator,
      wallet: new MockWalletManager() as unknown as WalletManager,
      connectorAdmin:
        new MockConnectorAdmin() as unknown as ConnectorAdminClient,
    };
    registerNodeRoutes(app, deps);

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/dev-mill-01/deposit-addresses',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.chains).toHaveLength(3);
  });
});
