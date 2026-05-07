/**
 * GET /nodes/:type/bandwidth tests (AC: #4 — story 21.10, Task 3.3).
 *
 * Tests:
 *   - success: returns bytesIn/bytesOut/sampleAt when container is running
 *   - container down: returns null
 *   - cache-hit: same payload returned within 5 s (no second call to dockerode)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import type Dockerode from 'dockerode';
import { registerNodeRoutes } from './nodes.js';
import type { ApiDeps, BandwidthPayload } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import type { BandwidthStats } from '../../docker/types.js';
import { getDefaultConfig } from '../../config/defaults.js';

// ── Stubs ─────────────────────────────────────────────────────────────────────

class StubOrchestrator extends EventEmitter {
  public statsMap = new Map<string, BandwidthStats | null>();
  public callCount = new Map<string, number>();

  async status() {
    return [];
  }

  async getNodeRelayEndpoint() {
    return 'ws://localhost:7100';
  }

  async getContainerStats(
    containerName: string
  ): Promise<BandwidthStats | null> {
    const count = this.callCount.get(containerName) ?? 0;
    this.callCount.set(containerName, count + 1);
    return this.statsMap.get(containerName) ?? null;
  }
}

class StubConnectorAdmin {
  async getMetrics() {
    return {
      uptimeSeconds: 0,
      aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 },
      peers: [],
      timestamp: new Date().toISOString(),
    };
  }

  async getPacketLog() {
    return [];
  }
}

class StubWallet {
  listKeys() {
    return [];
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /nodes/:type/bandwidth', () => {
  let app: FastifyInstance;
  let orchestrator: StubOrchestrator;
  let url: string;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    orchestrator = new StubOrchestrator();

    const deps: ApiDeps = {
      configPath: '/tmp/test.yaml',
      config: getDefaultConfig(),
      orchestrator: orchestrator as unknown as DockerOrchestrator,
      wallet: new StubWallet() as unknown as WalletManager,
      connectorAdmin:
        new StubConnectorAdmin() as unknown as ConnectorAdminClient,
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

  it('success — returns bytesIn/bytesOut/sampleAt when container is running', async () => {
    const now = Date.now();
    orchestrator.statsMap.set('townhouse-town', {
      bytesIn: 1024,
      bytesOut: 2048,
      sampleAt: now,
    });

    const res = await fetch(`${url}/nodes/town/bandwidth`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as BandwidthPayload;
    expect(body.bytesIn).toBe(1024);
    expect(body.bytesOut).toBe(2048);
    expect(body.sampleAt).toBe(now);
  });

  it('container not running — returns null body (HTTP 200 with null)', async () => {
    orchestrator.statsMap.set('townhouse-town', null);

    const res = await fetch(`${url}/nodes/town/bandwidth`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });

  it('unknown type → 404', async () => {
    const res = await fetch(`${url}/nodes/unknown/bandwidth`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown_node_type');
  });

  it('accepts all three node types', async () => {
    for (const type of ['town', 'mill', 'dvm']) {
      orchestrator.statsMap.set(`townhouse-${type}`, {
        bytesIn: 100,
        bytesOut: 200,
        sampleAt: Date.now(),
      });
      const res = await fetch(`${url}/nodes/${type}/bandwidth`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as BandwidthPayload;
      expect(body.bytesIn).toBe(100);
    }
  });
});

// ── Cache test (uses the real DockerOrchestrator getContainerStats logic) ─────

describe('DockerOrchestrator.getContainerStats — 5 s cache', () => {
  it('returns the same cached value within 5 s without calling dockerode again', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const mockContainer = {
      stats: async (_opts: { stream: boolean }) => {
        callCount++;
        return {
          networks: {
            eth0: { rx_bytes: 512, tx_bytes: 256 },
          },
        };
      },
    };

    const mockDocker = {
      getContainer: (_name: string) => mockContainer,
    };

    // Import DockerOrchestrator and test it directly
    const { DockerOrchestrator } = await import('../../docker/orchestrator.js');
    const { getDefaultConfig } = await import('../../config/defaults.js');
    const orch = new DockerOrchestrator(
      mockDocker as unknown as Dockerode,
      getDefaultConfig()
    );

    // First call — should call dockerode
    const first = await orch.getContainerStats('townhouse-town');
    expect(first).not.toBeNull();
    expect(first!.bytesIn).toBe(512);
    expect(first!.bytesOut).toBe(256);
    expect(callCount).toBe(1);

    // Second call within 5 s — should use cache
    const second = await orch.getContainerStats('townhouse-town');
    expect(second).toEqual(first);
    expect(callCount).toBe(1); // No second dockerode call

    // Advance time past 5 s
    vi.advanceTimersByTime(6_000);

    // Third call — cache expired, should call dockerode again
    const third = await orch.getContainerStats('townhouse-town');
    expect(third).not.toBeNull();
    expect(callCount).toBe(2);

    vi.useRealTimers();
  });
});
