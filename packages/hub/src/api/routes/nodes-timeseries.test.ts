/**
 * GET /nodes/:type/packets/timeseries tests (AC: #3 — story 21.10, Task 2.4).
 *
 * Tests:
 *   - success: returns bucketed timeseries from packet log
 *   - unknown type → 404
 *   - unsupported bucket size → 400
 *   - connector-down / endpoint-not-found → 503
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerNodeRoutes } from './nodes.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import type { PacketLogEntry, PacketLogFilter } from '../../connector/types.js';
import { getDefaultConfig } from '../../config/defaults.js';

// ── Stubs ─────────────────────────────────────────────────────────────────────

class StubOrchestrator extends EventEmitter {
  async status() {
    return [];
  }
  async getContainerStats() {
    return null;
  }
  async getNodeRelayEndpoint() {
    return 'ws://localhost:7100';
  }
}

class StubConnectorAdmin {
  public packets: PacketLogEntry[] = [];
  public shouldFail = false;
  public shouldReturn404 = false;
  public lastFilter: PacketLogFilter = {};

  async getMetrics() {
    return {
      uptimeSeconds: 0,
      aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 },
      peers: [],
      timestamp: new Date().toISOString(),
    };
  }

  async getPeers() {
    return [
      {
        id: 'town',
        connected: true,
        ilpAddresses: ['g.toon.town.01'],
        routeCount: 1,
      },
      {
        id: 'mill',
        connected: true,
        ilpAddresses: ['g.toon.mill.01'],
        routeCount: 1,
      },
      {
        id: 'dvm',
        connected: true,
        ilpAddresses: ['g.toon.dvm.01'],
        routeCount: 1,
      },
    ];
  }

  async getPacketLog(_filter: PacketLogFilter = {}): Promise<PacketLogEntry[]> {
    this.lastFilter = _filter;
    if (this.shouldReturn404) {
      const err = new Error('Connector does not expose GET /packets');
      (err as NodeJS.ErrnoException).code = 'ConnectorEndpointNotFound';
      throw err;
    }
    if (this.shouldFail) {
      throw new Error('connector down');
    }
    return this.packets;
  }
}

class StubWallet {
  listKeys() {
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPacketEntry(ts: number): PacketLogEntry {
  return {
    ts,
    ilpAddressFrom: 'g.toon.town',
    ilpAddressTo: 'g.toon.mill',
    amount: '1000',
    result: 'fulfill',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /nodes/:type/packets/timeseries', () => {
  let app: FastifyInstance;
  let connector: StubConnectorAdmin;
  let url: string;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    connector = new StubConnectorAdmin();

    const deps: ApiDeps = {
      configPath: '/tmp/test.yaml',
      config: getDefaultConfig(),
      orchestrator: new StubOrchestrator() as unknown as DockerOrchestrator,
      wallet: new StubWallet() as unknown as WalletManager,
      connectorAdmin: connector as unknown as ConnectorAdminClient,
    };
    registerNodeRoutes(app, deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it('success — returns bucketed timeseries from packet log', async () => {
    const now = Date.now();
    const hourMs = 60 * 60_000;
    const bucketTs1 = Math.floor(now / hourMs) * hourMs;
    const bucketTs0 = bucketTs1 - hourMs;

    connector.packets = [
      buildPacketEntry(bucketTs0 + 1000),
      buildPacketEntry(bucketTs0 + 2000),
      buildPacketEntry(bucketTs1 + 500),
    ];

    const res = await fetch(`${url}/nodes/town/packets/timeseries?bucket=hour`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      buckets: { ts: number; count: number }[];
    };
    expect(body).toHaveProperty('buckets');
    expect(Array.isArray(body.buckets)).toBe(true);

    const b0 = body.buckets.find((b) => b.ts === bucketTs0);
    const b1 = body.buckets.find((b) => b.ts === bucketTs1);
    expect(b0?.count).toBe(2);
    expect(b1?.count).toBe(1);
  });

  it('returns empty buckets when connector returns no packets', async () => {
    connector.packets = [];
    const res = await fetch(`${url}/nodes/town/packets/timeseries`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { buckets: unknown[] };
    expect(body.buckets).toEqual([]);
  });

  it('unknown type → 404', async () => {
    const res = await fetch(`${url}/nodes/unknown/packets/timeseries`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown_node_type');
  });

  it('unsupported bucket size → 400', async () => {
    const res = await fetch(`${url}/nodes/town/packets/timeseries?bucket=week`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unsupported_bucket');
  });

  it('connector endpoint not found → 503 with helpful message (AC #3 / Task 2.2)', async () => {
    connector.shouldReturn404 = true;
    const res = await fetch(`${url}/nodes/town/packets/timeseries`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('connector_endpoint_not_found');
    expect(body.message).toMatch(/CONNECTOR_MIGRATION/);
  });

  it('connector down → 503', async () => {
    connector.shouldFail = true;
    const res = await fetch(`${url}/nodes/town/packets/timeseries`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('connector_unavailable');
  });

  it('accepts mill and dvm types', async () => {
    connector.packets = [];
    const resM = await fetch(`${url}/nodes/mill/packets/timeseries`);
    expect(resM.status).toBe(200);
    const resD = await fetch(`${url}/nodes/dvm/packets/timeseries`);
    expect(resD.status).toBe(200);
  });

  it('filters packet log by ILP address resolved from peers (AC #3)', async () => {
    connector.packets = [buildPacketEntry(Date.now())];
    const res = await fetch(`${url}/nodes/town/packets/timeseries`);
    expect(res.status).toBe(200);
    // Route should have called getPacketLog with the ILP address from getPeers()
    expect(connector.lastFilter.ilpAddress).toBe('g.toon.town.01');
  });

  it('falls back to unfiltered log when peers unavailable (ilpAddress undefined)', async () => {
    // Simulate getPeers returning no entry for the type
    const origGetPeers = connector.getPeers.bind(connector);
    connector.getPeers = async () => [];
    connector.packets = [buildPacketEntry(Date.now())];
    const res = await fetch(`${url}/nodes/town/packets/timeseries`);
    expect(res.status).toBe(200);
    expect(connector.lastFilter.ilpAddress).toBeUndefined();
    connector.getPeers = origGetPeers;
  });
});
