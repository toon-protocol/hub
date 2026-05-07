/**
 * Tests for GET /nodes/:nodeId/swaps/recent (AC-3, Story 21.11).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerNodeRoutes } from './nodes.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { getDefaultConfig } from '../../config/defaults.js';

class MockOrchestrator {
  private statusEntries: { name: string; type: string; state: string }[] = [
    { name: 'mill', type: 'mill', state: 'running' },
  ];
  setStatus(entries: { name: string; type: string; state: string }[]) {
    this.statusEntries = entries;
  }
  async status() {
    return this.statusEntries;
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
  getNodeKeys() {
    return {
      evmAddress: '0x1234',
      nostrPubkey: 'a'.repeat(64),
      nostrSecretKey: new Uint8Array(32),
      evmPrivateKey: new Uint8Array(32),
      nostrDerivationPath: '',
      evmDerivationPath: '',
    };
  }
  listKeys() {
    return [];
  }
}

class MockConnectorAdmin {
  private packets: {
    ilpAddressFrom: string;
    ilpAddressTo: string;
    amount: string;
    ts: number;
  }[] = [];
  private fail = false;
  private failWithCode: string | null = null;
  private peers: {
    id: string;
    ilpAddresses: string[];
    connected: boolean;
  }[] = [{ id: 'mill', ilpAddresses: ['test.mill'], connected: true }];

  setPackets(packets: typeof this.packets) {
    this.packets = packets;
  }
  setFail(f: boolean) {
    this.fail = f;
  }
  setFailWithCode(code: string) {
    this.failWithCode = code;
  }
  setPeers(p: typeof this.peers) {
    this.peers = p;
  }

  async getMetrics() {
    return {
      aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 },
      peers: [],
    };
  }

  async getPeers() {
    return this.peers;
  }

  async getPacketLog(_filter: unknown) {
    if (this.failWithCode) {
      const err = new Error('endpoint not found') as Error & { code?: string };
      err.code = this.failWithCode;
      throw err;
    }
    if (this.fail) throw new Error('connector unavailable');
    return this.packets;
  }
}

function buildDeps(
  connectorAdmin: MockConnectorAdmin,
  orchestrator: MockOrchestrator = new MockOrchestrator()
): ApiDeps {
  return {
    configPath: '/tmp/test.yaml',
    config: getDefaultConfig(),
    orchestrator: orchestrator as unknown as DockerOrchestrator,
    wallet: new MockWalletManager() as unknown as WalletManager,
    connectorAdmin: connectorAdmin as unknown as ConnectorAdminClient,
  };
}

describe('GET /nodes/:nodeId/swaps/recent (AC-3, Story 21.11)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns count + volume + byPair from packet log', async () => {
    const admin = new MockConnectorAdmin();
    admin.setPackets([
      {
        ilpAddressFrom: 'test.sender',
        ilpAddressTo: 'test.mill',
        amount: '1000000',
        ts: Date.now(),
      },
      {
        ilpAddressFrom: 'test.sender',
        ilpAddressTo: 'test.mill',
        amount: '2000000',
        ts: Date.now(),
      },
      {
        ilpAddressFrom: 'test.other',
        ilpAddressTo: 'test.mill',
        amount: '500000',
        ts: Date.now(),
      },
    ]);
    registerNodeRoutes(app, buildDeps(admin));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/mill/swaps/recent',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(3);
    expect(body.volume).toBe('3500000');
    expect(body.byPair).toHaveLength(2);
    const senderPair = body.byPair.find((p: { pair: string }) =>
      p.pair.startsWith('test.sender')
    );
    expect(senderPair.count).toBe(2);
    expect(senderPair.volume).toBe('3000000');
  });

  it('returns zeros for empty packet log window', async () => {
    const admin = new MockConnectorAdmin();
    admin.setPackets([]);
    registerNodeRoutes(app, buildDeps(admin));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/mill/swaps/recent',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(body.volume).toBe('0');
    expect(body.byPair).toHaveLength(0);
  });

  it('returns 400 for windowSec out of range', async () => {
    const admin = new MockConnectorAdmin();
    registerNodeRoutes(app, buildDeps(admin));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/mill/swaps/recent?windowSec=9999',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for windowSec in scientific notation (1e10)', async () => {
    const admin = new MockConnectorAdmin();
    registerNodeRoutes(app, buildDeps(admin));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/mill/swaps/recent?windowSec=1e10',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_window_sec');
  });

  it('returns 503 when connector unavailable', async () => {
    const admin = new MockConnectorAdmin();
    admin.setFail(true);
    registerNodeRoutes(app, buildDeps(admin));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/mill/swaps/recent',
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 503 with endpoint-not-found when connector lacks the endpoint', async () => {
    const admin = new MockConnectorAdmin();
    admin.setFailWithCode('ConnectorEndpointNotFound');
    registerNodeRoutes(app, buildDeps(admin));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/mill/swaps/recent',
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe('connector_endpoint_not_found');
  });

  it('scopes packet log per nodeId for multi-instance setups', async () => {
    const admin = new MockConnectorAdmin();
    admin.setPeers([
      { id: 'dev-mill-01', ilpAddresses: ['test.mill-01'], connected: true },
      { id: 'dev-mill-02', ilpAddresses: ['test.mill-02'], connected: true },
    ]);
    let lastIlpFilter: string | undefined;
    admin.getPacketLog = async (filter: { ilpAddress?: string }) => {
      lastIlpFilter = filter.ilpAddress;
      return [];
    };

    const orch = new MockOrchestrator();
    orch.setStatus([
      { name: 'dev-mill-01', type: 'mill', state: 'running' },
      { name: 'dev-mill-02', type: 'mill', state: 'running' },
    ]);

    registerNodeRoutes(app, buildDeps(admin, orch));

    await app.inject({ method: 'GET', url: '/nodes/dev-mill-01/swaps/recent' });
    expect(lastIlpFilter).toBe('test.mill-01');

    await app.inject({ method: 'GET', url: '/nodes/dev-mill-02/swaps/recent' });
    expect(lastIlpFilter).toBe('test.mill-02');
  });

  it('returns empty result when peer is not registered yet (boot race)', async () => {
    const admin = new MockConnectorAdmin();
    admin.setPeers([]); // No mill peer registered.

    registerNodeRoutes(app, buildDeps(admin));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/mill/swaps/recent',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(body.volume).toBe('0');
    expect(body.byPair).toHaveLength(0);
  });

  it('returns 404 when nodeId resolves to a non-mill type', async () => {
    const admin = new MockConnectorAdmin();
    const orch = new MockOrchestrator();
    orch.setStatus([{ name: 'town', type: 'town', state: 'running' }]);

    registerNodeRoutes(app, buildDeps(admin, orch));

    const res = await app.inject({
      method: 'GET',
      url: '/nodes/town/swaps/recent',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('swaps_only_for_mill');
  });
});
