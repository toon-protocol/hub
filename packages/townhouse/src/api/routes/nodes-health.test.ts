/**
 * Tests for GET /nodes/:nodeId/health proxy endpoint (AC-2, Story 21.11).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerNodeRoutes } from './nodes.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { getDefaultConfig } from '../../config/defaults.js';

const MILL_HEALTH_PAYLOAD = {
  status: 'ok',
  version: '1.0.0',
  nodePubkey: 'a'.repeat(64),
  swapPairsCount: 1,
  chains: ['evm'],
  uptimeSec: 60,
  inventory: { 'evm:8453': '1000000' },
  swapPairs: [
    {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:8453' },
      to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
      rate: '1.0',
    },
  ],
  inventoryAvailable: { 'evm:8453': '500000' },
};

class MockOrchestrator {
  private healthEndpoint: string;
  private shouldFailInspect: boolean;

  constructor(endpoint = 'http://127.0.0.1:9999', failInspect = false) {
    this.healthEndpoint = endpoint;
    this.shouldFailInspect = failInspect;
  }

  async status() {
    return [
      { name: 'mill', type: 'mill', state: 'running', startedAt: new Date().toISOString() },
    ];
  }

  async getNodeHealthEndpoint(_nodeId: string, _type: string): Promise<string> {
    if (this.shouldFailInspect) throw new Error('Docker unavailable');
    return this.healthEndpoint;
  }

  async getContainerStats() { return null; }
  on() { return this; }
  off() { return this; }
}

class MockWalletManager {
  getNodeKeys() { return { evmAddress: '0x1234', nostrPubkey: 'a'.repeat(64), nostrSecretKey: new Uint8Array(32), evmPrivateKey: new Uint8Array(32), nostrDerivationPath: '', evmDerivationPath: '' }; }
  listKeys() { return []; }
}

class MockConnectorAdmin {
  async getMetrics() { return { aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 }, peers: [] }; }
  async getPeers() { return []; }
  async getPacketLog() { return []; }
}

function buildDeps(orchestrator: MockOrchestrator): ApiDeps {
  return {
    configPath: '/tmp/test.yaml',
    config: getDefaultConfig(),
    orchestrator: orchestrator as unknown as DockerOrchestrator,
    wallet: new MockWalletManager() as unknown as WalletManager,
    connectorAdmin: new MockConnectorAdmin() as unknown as ConnectorAdminClient,
  };
}

describe('GET /nodes/:nodeId/health (AC-2, Story 21.11)', () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    app = Fastify();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it('proxies mill health response verbatim on success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => MILL_HEALTH_PAYLOAD,
    });

    const deps = buildDeps(new MockOrchestrator('http://127.0.0.1:3200'));
    registerNodeRoutes(app, deps);

    const res = await app.inject({ method: 'GET', url: '/nodes/mill/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(Array.isArray(body.swapPairs)).toBe(true);
    expect(body.inventoryAvailable).toBeDefined();
  });

  it('returns 503 when container fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));

    const deps = buildDeps(new MockOrchestrator('http://127.0.0.1:3200'));
    registerNodeRoutes(app, deps);

    const res = await app.inject({ method: 'GET', url: '/nodes/mill/health' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe('node_unreachable');
  });

  it('returns 503 when fetch returns non-ok status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    const deps = buildDeps(new MockOrchestrator('http://127.0.0.1:3200'));
    registerNodeRoutes(app, deps);

    const res = await app.inject({ method: 'GET', url: '/nodes/mill/health' });
    expect(res.statusCode).toBe(503);
  });

  it('returns 404 for unknown node id', async () => {
    const deps = buildDeps(new MockOrchestrator());
    registerNodeRoutes(app, deps);

    const res = await app.inject({ method: 'GET', url: '/nodes/unknown/health' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('unknown_node');
  });

  it('returns cached payload within TTL window', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => MILL_HEALTH_PAYLOAD,
    });

    const deps = buildDeps(new MockOrchestrator('http://127.0.0.1:3200'));
    registerNodeRoutes(app, deps);

    // First request populates cache
    await app.inject({ method: 'GET', url: '/nodes/mill/health' });
    // Second request should hit cache (fetch only called once)
    const res = await app.inject({ method: 'GET', url: '/nodes/mill/health' });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('scopes cache and endpoint per nodeId for multi-instance', async () => {
    // Mock orchestrator with two mill instances.
    const multiOrch = {
      async status() {
        return [
          { name: 'dev-mill-01', type: 'mill', state: 'running', startedAt: new Date().toISOString() },
          { name: 'dev-mill-02', type: 'mill', state: 'running', startedAt: new Date().toISOString() },
        ];
      },
      async getNodeHealthEndpoint(nodeId: string, _type: string): Promise<string> {
        return nodeId === 'dev-mill-01' ? 'http://127.0.0.1:3201' : 'http://127.0.0.1:3202';
      },
      async getContainerStats() { return null; },
      on() { return this; },
      off() { return this; },
    };

    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({ ...MILL_HEALTH_PAYLOAD, nodePubkey: url }),
    }));

    const deps = buildDeps(multiOrch as unknown as MockOrchestrator);
    registerNodeRoutes(app, deps);

    const res1 = await app.inject({ method: 'GET', url: '/nodes/dev-mill-01/health' });
    const res2 = await app.inject({ method: 'GET', url: '/nodes/dev-mill-02/health' });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    // Different endpoints fetched — cache must be per-instance, not per-type.
    expect(JSON.parse(res1.body).nodePubkey).toBe('http://127.0.0.1:3201/health');
    expect(JSON.parse(res2.body).nodePubkey).toBe('http://127.0.0.1:3202/health');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
