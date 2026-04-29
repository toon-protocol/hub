/**
 * Connector Contract Canary — Townhouse-Side (Story 21.7.5)
 *
 * Stub-driven canary that fails fast (<500ms) when the connector admin API or
 * the env-var/peer-config contract drifts from what Townhouse expects.
 *
 * The shapes asserted here mirror the connector source-of-truth:
 *   - HealthStatus from `@toon-protocol/connector` packages/connector/src/http/types.ts
 *   - AdminMetricsJsonResponse and the GET /admin/peers handler from
 *     packages/connector/src/http/admin-api.ts
 *
 * Coverage:
 *   Admin API (ConnectorAdminClient):
 *     - getHealth()   → GET /health on healthCheckPort →
 *         { status: 'healthy'|'unhealthy'|'starting'|'degraded',
 *           uptime, peersConnected, totalPeers, timestamp, … }
 *     - getMetrics()  → GET /admin/metrics.json on adminApi.port →
 *         { uptimeSeconds, aggregate: {…}, peers: [{peerId, …}], timestamp }
 *     - getPeers()    → GET /admin/peers on adminApi.port →
 *         { nodeId, peerCount, connectedCount, peers: [{id, connected, …}] }
 *
 *   Each test asserts BOTH the path the client requests AND the shape it
 *   parses. A path drift (e.g. someone refactors `getMetrics` to call
 *   `/admin/metrics`) fails the canary just as loudly as a shape drift —
 *   that's the point of binding the stub to URL/method.
 *
 *   Config-generator env-var shape (ConnectorConfigGenerator):
 *     - Required keys always present for non-empty activeNodes
 *     - SOCKS_PROXY present iff transport.socksProxy is set
 *     - CONNECTOR_PEERS round-trips to PeerEntry[] with documented fields
 *     - toEnvArray() matches toEnvVars() round-tripped
 *
 * No Docker, no network. Pure vi.spyOn(global, 'fetch') stub verification.
 *
 * If this canary fails, see packages/sdk/CONNECTOR_MIGRATION.md §Townhouse-Side Contract
 * for the migration checklist.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { ConnectorAdminClient } from './admin-client.js';
import { ConnectorConfigGenerator } from './config-generator.js';
import { getDefaultConfig } from '../config/defaults.js';
import type { PeerEntry } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mock fetch and capture the URL the client requests, so the canary fails
 * if a future refactor changes the path under `ConnectorAdminClient`.
 */
function mockFetchAt(
  expectedPath: string,
  body: unknown,
  status = 200
): { fetch: ReturnType<typeof vi.fn>; calls: string[] } {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (!url.endsWith(expectedPath)) {
      throw new Error(
        `Canary expected client to request a URL ending in '${expectedPath}', got '${url}'`
      );
    }
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetch: fetchMock, calls };
}

const HEALTHY_BODY = {
  status: 'healthy' as const,
  uptime: 42,
  peersConnected: 1,
  totalPeers: 1,
  timestamp: '2026-04-29T00:00:00.000Z',
};

const METRICS_BODY = {
  uptimeSeconds: 60,
  aggregate: { packetsForwarded: 10, packetsRejected: 1, bytesSent: 500 },
  peers: [],
  timestamp: '2026-04-29T00:00:00.000Z',
};

const PEERS_BODY = {
  nodeId: 'townhouse-canary',
  peerCount: 1,
  connectedCount: 1,
  peers: [
    {
      id: 'town',
      connected: true,
      ilpAddresses: ['g.toon.town'],
      routeCount: 1,
    },
  ],
};

const client = new ConnectorAdminClient('http://localhost:9402');

// ─────────────────────────────────────────────────────────────────────────────
// getHealth() shape + path contract — mirrors connector HealthStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('getHealth() shape contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('succeeds on documented HealthStatus shape and requests GET /health', async () => {
    const stub = mockFetchAt('/health', HEALTHY_BODY);
    const health = await client.getHealth();
    expect(health.status).toBe('healthy');
    expect(health.uptime).toBe(42);
    expect(health.peersConnected).toBe(1);
    expect(health.totalPeers).toBe(1);
    expect(stub.calls).toHaveLength(1);
  });

  it('accepts the four documented status values: healthy/unhealthy/starting/degraded', async () => {
    for (const status of [
      'healthy',
      'unhealthy',
      'starting',
      'degraded',
    ] as const) {
      mockFetchAt('/health', { ...HEALTHY_BODY, status });
      const health = await client.getHealth();
      expect(health.status).toBe(status);
      vi.unstubAllGlobals();
    }
  });

  it('rejects when status field is missing', async () => {
    mockFetchAt('/health', { ...HEALTHY_BODY, status: undefined });
    await expect(client.getHealth()).rejects.toThrow(
      /invalid health response shape/
    );
  });

  it('rejects when status has unknown value', async () => {
    mockFetchAt('/health', { ...HEALTHY_BODY, status: 'unknown' });
    await expect(client.getHealth()).rejects.toThrow(
      /invalid health response shape/
    );
  });

  it('rejects when uptime field is missing', async () => {
    mockFetchAt('/health', { ...HEALTHY_BODY, uptime: undefined });
    await expect(client.getHealth()).rejects.toThrow(
      /invalid health response shape/
    );
  });

  it('rejects when peersConnected is missing', async () => {
    mockFetchAt('/health', { ...HEALTHY_BODY, peersConnected: undefined });
    await expect(client.getHealth()).rejects.toThrow(
      /invalid health response shape/
    );
  });

  it('rejects when totalPeers is missing', async () => {
    mockFetchAt('/health', { ...HEALTHY_BODY, totalPeers: undefined });
    await expect(client.getHealth()).rejects.toThrow(
      /invalid health response shape/
    );
  });

  it('rejects when timestamp is missing', async () => {
    mockFetchAt('/health', { ...HEALTHY_BODY, timestamp: undefined });
    await expect(client.getHealth()).rejects.toThrow(
      /invalid health response shape/
    );
  });

  it('rejects when uptime has wrong type (string instead of number)', async () => {
    mockFetchAt('/health', { ...HEALTHY_BODY, uptime: '42' });
    await expect(client.getHealth()).rejects.toThrow(
      /invalid health response shape/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getMetrics() shape + path contract — mirrors AdminMetricsJsonResponse
// ─────────────────────────────────────────────────────────────────────────────

describe('getMetrics() shape contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('succeeds on AdminMetricsJsonResponse shape and requests GET /admin/metrics.json', async () => {
    const stub = mockFetchAt('/admin/metrics.json', METRICS_BODY);
    const metrics = await client.getMetrics();
    expect(metrics.uptimeSeconds).toBe(60);
    expect(metrics.aggregate.packetsForwarded).toBe(10);
    expect(metrics.aggregate.packetsRejected).toBe(1);
    expect(metrics.aggregate.bytesSent).toBe(500);
    expect(metrics.peers).toEqual([]);
    expect(stub.calls).toHaveLength(1);
  });

  it('rejects when aggregate is missing', async () => {
    mockFetchAt('/admin/metrics.json', {
      ...METRICS_BODY,
      aggregate: undefined,
    });
    await expect(client.getMetrics()).rejects.toThrow(
      /invalid metrics response shape/
    );
  });

  it('rejects when aggregate.packetsForwarded is missing', async () => {
    mockFetchAt('/admin/metrics.json', {
      ...METRICS_BODY,
      aggregate: { packetsRejected: 0, bytesSent: 0 },
    });
    await expect(client.getMetrics()).rejects.toThrow(
      /invalid metrics response shape/
    );
  });

  it('rejects when aggregate.packetsRejected is missing', async () => {
    mockFetchAt('/admin/metrics.json', {
      ...METRICS_BODY,
      aggregate: { packetsForwarded: 0, bytesSent: 0 },
    });
    await expect(client.getMetrics()).rejects.toThrow(
      /invalid metrics response shape/
    );
  });

  it('rejects when aggregate.bytesSent is missing', async () => {
    mockFetchAt('/admin/metrics.json', {
      ...METRICS_BODY,
      aggregate: { packetsForwarded: 0, packetsRejected: 0 },
    });
    await expect(client.getMetrics()).rejects.toThrow(
      /invalid metrics response shape/
    );
  });

  it('rejects when peers is not an array', async () => {
    mockFetchAt('/admin/metrics.json', { ...METRICS_BODY, peers: {} });
    await expect(client.getMetrics()).rejects.toThrow(
      /invalid metrics response shape/
    );
  });

  it('rejects when uptimeSeconds has wrong type', async () => {
    mockFetchAt('/admin/metrics.json', {
      ...METRICS_BODY,
      uptimeSeconds: '60',
    });
    await expect(client.getMetrics()).rejects.toThrow(
      /invalid metrics response shape/
    );
  });

  it('rejects when timestamp is missing', async () => {
    mockFetchAt('/admin/metrics.json', {
      ...METRICS_BODY,
      timestamp: undefined,
    });
    await expect(client.getMetrics()).rejects.toThrow(
      /invalid metrics response shape/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPeers() shape + path contract — mirrors GET /admin/peers wrapper envelope
// ─────────────────────────────────────────────────────────────────────────────

describe('getPeers() shape contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('succeeds on documented wrapper envelope and requests GET /admin/peers', async () => {
    const stub = mockFetchAt('/admin/peers', PEERS_BODY);
    const peers = await client.getPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.id).toBe('town');
    expect(peers[0]!.connected).toBe(true);
    expect(peers[0]!.ilpAddresses).toEqual(['g.toon.town']);
    expect(peers[0]!.routeCount).toBe(1);
    expect(stub.calls).toHaveLength(1);
  });

  it('returns empty array when the connector has no peers', async () => {
    mockFetchAt('/admin/peers', {
      nodeId: 'townhouse-canary',
      peerCount: 0,
      connectedCount: 0,
      peers: [],
    });
    const peers = await client.getPeers();
    expect(peers).toEqual([]);
  });

  it('rejects when peers field is missing from the envelope', async () => {
    mockFetchAt('/admin/peers', {
      nodeId: 'townhouse-canary',
      peerCount: 0,
      connectedCount: 0,
    });
    await expect(client.getPeers()).rejects.toThrow(
      /invalid peers response shape/
    );
  });

  it('rejects when body is a bare array (legacy shape — pre-3.3.x drift indicator)', async () => {
    mockFetchAt('/admin/peers', [{ id: 'town' }]);
    await expect(client.getPeers()).rejects.toThrow(
      /invalid peers response shape/
    );
  });

  it('rejects when body is null', async () => {
    mockFetchAt('/admin/peers', null);
    await expect(client.getPeers()).rejects.toThrow(
      /invalid peers response shape/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConnectorConfigGenerator env-var contract
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectorConfigGenerator env-var contract', () => {
  it('emits exactly the required keys for activeNodes=[town,mill,dvm] in direct mode', () => {
    const config = getDefaultConfig();
    config.transport = { mode: 'direct' };
    const gen = new ConnectorConfigGenerator(config);
    const runtimeCfg = gen.generate(['town', 'mill', 'dvm']);
    const envVars = gen.toEnvVars(runtimeCfg);

    expect(Object.keys(envVars).sort()).toEqual([
      'CONNECTOR_ADMIN_PORT',
      'CONNECTOR_ILP_ADDRESS',
      'CONNECTOR_PEERS',
      'TRANSPORT_MODE',
    ]);
    expect(envVars['TRANSPORT_MODE']).toBe('direct');
  });

  it('additionally emits SOCKS_PROXY when transport.mode is ator with proxy set', () => {
    const config = getDefaultConfig();
    config.transport = {
      mode: 'ator',
      socksProxy: 'socks5h://proxy.ator.io:9050',
    };
    const gen = new ConnectorConfigGenerator(config);
    const runtimeCfg = gen.generate(['town']);
    const envVars = gen.toEnvVars(runtimeCfg);

    expect(Object.keys(envVars).sort()).toEqual([
      'CONNECTOR_ADMIN_PORT',
      'CONNECTOR_ILP_ADDRESS',
      'CONNECTOR_PEERS',
      'SOCKS_PROXY',
      'TRANSPORT_MODE',
    ]);
    expect(envVars['SOCKS_PROXY']).toBe('socks5h://proxy.ator.io:9050');
  });

  it('CONNECTOR_PEERS round-trips to PeerEntry[] with documented fields for each activeNode', () => {
    const config = getDefaultConfig();
    config.transport = { mode: 'direct' };
    const gen = new ConnectorConfigGenerator(config);
    const runtimeCfg = gen.generate(['town', 'mill', 'dvm']);
    const envVars = gen.toEnvVars(runtimeCfg);

    const peers = JSON.parse(envVars['CONNECTOR_PEERS']!) as PeerEntry[];
    expect(Array.isArray(peers)).toBe(true);
    expect(peers).toHaveLength(3);

    for (const [i, nodeType] of (['town', 'mill', 'dvm'] as const).entries()) {
      const peer = peers[i]!;
      expect(peer.id).toBe(nodeType);
      expect(peer.relation).toBe('child');
      expect(peer.btpUrl).toBe(`btp+ws://townhouse-${nodeType}:3000`);
      expect(peer.assetCode).toBe('USD');
      expect(peer.assetScale).toBe(6);
    }
  });

  it('toEnvArray() produces KEY=VALUE strings whose set matches toEnvVars()', () => {
    const config = getDefaultConfig();
    const gen = new ConnectorConfigGenerator(config);
    const runtimeCfg = gen.generate(['town']);
    const envVars = gen.toEnvVars(runtimeCfg);
    const envArray = gen.toEnvArray(runtimeCfg);

    // Re-derive a Record from the array and compare
    const roundTripped = Object.fromEntries(
      envArray.map((entry) => {
        const eqIdx = entry.indexOf('=');
        return [entry.slice(0, eqIdx), entry.slice(eqIdx + 1)];
      })
    );
    expect(roundTripped).toEqual(envVars);
  });
});
