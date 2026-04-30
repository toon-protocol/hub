/**
 * Tests for GET /nodes/:nodeId/jobs/recent (AC-6, Story 21.12)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerNodeRoutes } from './nodes.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { getDefaultConfig } from '../../config/defaults.js';
import type { JobsRecentPayload } from '../types.js';

// ── Mock helpers ──────────────────────────────────────────────────────────────

class MockDockerOrchestrator {
  private healthUrl: string;

  constructor(healthUrl = 'http://localhost:28400') {
    this.healthUrl = healthUrl;
  }

  on(_event: string, _cb: () => void): this { return this; }
  off(_event: string, _cb: () => void): this { return this; }

  async status() {
    return [
      { name: 'townhouse-dev-dvm-01', type: 'dvm', state: 'running', startedAt: new Date().toISOString() },
    ];
  }

  async addNode() {}
  async removeNode() {}
  async regenerateConnectorConfig() {}

  async getNodeHealthEndpoint(_nodeId: string, _type: string): Promise<string> {
    return this.healthUrl;
  }
}

class MockConnectorAdminClient {
  private peers: { id: string; ilpAddresses: string[] }[] = [];
  private packets: { ts: number; ilpAddressFrom: string; ilpAddressTo: string; amount: string; result: 'fulfill' | 'reject' | 'timeout' }[] = [];
  private shouldFail = false;
  private endpointNotFound = false;

  setPeers(peers: { id: string; ilpAddresses: string[] }[]) {
    this.peers = peers;
  }

  setPackets(packets: { ts: number; ilpAddressFrom: string; ilpAddressTo: string; amount: string; result: 'fulfill' | 'reject' | 'timeout' }[]) {
    this.packets = packets;
  }

  setFail(fail: boolean) { this.shouldFail = fail; }
  setEndpointNotFound(v: boolean) { this.endpointNotFound = v; }

  async getPeers() {
    if (this.shouldFail) throw new Error('connector down');
    return this.peers;
  }

  async getPacketLog() {
    if (this.shouldFail) throw new Error('connector down');
    if (this.endpointNotFound) {
      const e = new Error('not found') as NodeJS.ErrnoException;
      e.code = 'ConnectorEndpointNotFound';
      throw e;
    }
    return this.packets;
  }

  async getMetrics() {
    return { uptimeSeconds: 0, aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 }, peers: [], timestamp: '' };
  }
}

// ── DVM health mock response ──────────────────────────────────────────────────

const mockDvmHealth = {
  status: 'ok',
  version: '1.0.0',
  nodePubkey: 'a'.repeat(64),
  uptimeSec: 60,
  handlerKinds: [5094, 5250],
  kindPricing: { '5094': '10', '5250': '10000' },
  basePricePerByte: '10',
  jobsRecent: {
    total: 5,
    byKind: [{ kind: 5094, count: 3 }, { kind: 5250, count: 2 }],
    byStatus: { processing: 1, success: 3, error: 1, partial: 0 },
  },
};

// ── Test setup ────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let connectorAdmin: MockConnectorAdminClient;
let orchestrator: MockDockerOrchestrator;

beforeEach(async () => {
  connectorAdmin = new MockConnectorAdminClient();
  orchestrator = new MockDockerOrchestrator();

  connectorAdmin.setPeers([
    { id: 'townhouse-dev-dvm-01', ilpAddresses: ['g.test.dvm-01'] },
  ]);
  connectorAdmin.setPackets([
    { ts: Date.now() - 1000, ilpAddressFrom: 'g.test.client', ilpAddressTo: 'g.test.dvm-01', amount: '100', result: 'fulfill' },
    { ts: Date.now() - 2000, ilpAddressFrom: 'g.test.client', ilpAddressTo: 'g.test.dvm-01', amount: '200', result: 'fulfill' },
  ]);

  // Mock global fetch for health endpoint
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/health')) {
      return {
        ok: true,
        json: async () => mockDvmHealth,
      };
    }
    return { ok: false, status: 404 };
  }));

  const config = getDefaultConfig();
  config.nodes.dvm.enabled = true;

  const deps: ApiDeps = {
    configPath: '/tmp/test-config.yaml',
    config,
    orchestrator: orchestrator as unknown as DockerOrchestrator,
    wallet: { listKeys: () => [], getNodeKeys: () => ({ nostrPubkey: 'a'.repeat(64), evmAddress: '0x1', nostrSecretKey: new Uint8Array(32) }) } as unknown as WalletManager,
    connectorAdmin: connectorAdmin as unknown as ConnectorAdminClient,
  };

  app = Fastify();
  registerNodeRoutes(app, deps);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /nodes/:nodeId/jobs/recent', () => {
  it('happy path returns count, volume, byKind, byStatus', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-dvm-01/jobs/recent',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as JobsRecentPayload;
    expect(typeof body.count).toBe('number');
    expect(typeof body.volume).toBe('string');
    expect(Array.isArray(body.byKind)).toBe(true);
    expect(typeof body.byStatus.processing).toBe('number');
    expect(typeof body.byStatus.success).toBe('number');
  });

  it('byStatus comes from DVM health proxy', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-dvm-01/jobs/recent',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as JobsRecentPayload;
    expect(body.byStatus.processing).toBe(1);
    expect(body.byStatus.success).toBe(3);
    expect(body.byStatus.error).toBe(1);
    expect(body.byStatus.partial).toBe(0);
  });

  it('unknown nodeId returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nodes/unknown-node/jobs/recent',
    });

    expect(res.statusCode).toBe(404);
  });

  it('type !== dvm returns 404 with jobs_only_for_dvm', async () => {
    // Add a mill instance
    connectorAdmin.setPeers([
      { id: 'townhouse-dev-mill-01', ilpAddresses: ['g.test.mill-01'] },
    ]);
    const orchWithMill = {
      ...orchestrator,
      status: async () => [
        { name: 'townhouse-dev-mill-01', type: 'mill', state: 'running' },
      ],
    };

    const config = getDefaultConfig();
    const deps: ApiDeps = {
      configPath: '/tmp/test2.yaml',
      config,
      orchestrator: orchWithMill as unknown as DockerOrchestrator,
      wallet: { listKeys: () => [], getNodeKeys: () => ({ nostrPubkey: 'a'.repeat(64), evmAddress: '0x1', nostrSecretKey: new Uint8Array(32) }) } as unknown as WalletManager,
      connectorAdmin: connectorAdmin as unknown as ConnectorAdminClient,
    };
    const app2 = Fastify();
    registerNodeRoutes(app2, deps);
    await app2.ready();

    const res = await app2.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-mill-01/jobs/recent',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe('jobs_only_for_dvm');

    await app2.close();
  });

  it('windowSec=abc returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-dvm-01/jobs/recent?windowSec=abc',
    });

    expect(res.statusCode).toBe(400);
  });

  it('windowSec=0 returns 400 (below minimum)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-dvm-01/jobs/recent?windowSec=0',
    });

    expect(res.statusCode).toBe(400);
  });

  it('windowSec=3601 returns 400 (above maximum)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-dvm-01/jobs/recent?windowSec=3601',
    });

    expect(res.statusCode).toBe(400);
  });

  it('connector down returns 503', async () => {
    connectorAdmin.setFail(true);

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-dvm-01/jobs/recent',
    });

    expect(res.statusCode).toBe(503);
  });

  it('health fetch fail returns zero byStatus', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-dvm-01/jobs/recent',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as JobsRecentPayload;
    expect(body.byStatus.processing).toBe(0);
    expect(body.byStatus.success).toBe(0);
  });

  it('connector endpoint not found returns 503 with connector_endpoint_not_found', async () => {
    // Connector v3.3.3 omits GET /packets — the admin client raises an
    // error with code='ConnectorEndpointNotFound', and the route surfaces
    // a 503 with that body so the dashboard can prompt for an upgrade.
    connectorAdmin.setEndpointNotFound(true);

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-dvm-01/jobs/recent',
    });

    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: string; message?: string };
    expect(body.error).toBe('connector_endpoint_not_found');
    expect(body.message).toMatch(/CONNECTOR_MIGRATION/);
  });

  it('windowSec=301 returns 400 (above DVM counter window)', async () => {
    // The DVM in-memory counter is fixed at 5 minutes; rejecting >300
    // prevents mixing windows across response fields.
    const res = await app.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-dvm-01/jobs/recent?windowSec=301',
    });
    expect(res.statusCode).toBe(400);
  });

  it('empty packet log returns count=0 from health', async () => {
    connectorAdmin.setPackets([]);

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/townhouse-dev-dvm-01/jobs/recent',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as JobsRecentPayload;
    // count comes from DVM health jobsRecent.total = 5
    expect(body.count).toBe(5);
    expect(body.volume).toBe('0');
  });
});
