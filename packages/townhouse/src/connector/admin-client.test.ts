/**
 * Unit Tests: ConnectorAdminClient
 *
 * Test IDs map to test-design-epic-21.md scenario T-020.
 *
 * Verifies the client speaks the connector's source-of-truth contract:
 *   - GET /health on healthCheckPort → HealthStatus
 *   - GET /admin/peers on adminApi.port → wrapped peers envelope
 *   - GET /admin/metrics.json on adminApi.port → AdminMetricsJsonResponse
 *
 * The dedicated stub canary (`./contract-canary.test.ts`) covers shape-drift
 * with URL-bound assertions; this file covers happy-path + transport-layer
 * failure modes (timeout, ECONNREFUSED, non-2xx).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ConnectorAdminClient } from './admin-client.js';

const HEALTHY_BODY = {
  status: 'healthy',
  uptime: 120,
  peersConnected: 2,
  totalPeers: 3,
  timestamp: '2026-04-29T00:00:00.000Z',
};

const METRICS_BODY = {
  uptimeSeconds: 120,
  aggregate: {
    packetsForwarded: 1500,
    packetsRejected: 12,
    bytesSent: 45000,
  },
  peers: [
    {
      peerId: 'town',
      connected: true,
      packetsForwarded: 800,
      packetsRejected: 5,
      bytesSent: 25000,
      lastPacketAt: '2026-04-29T00:00:00.000Z',
    },
  ],
  timestamp: '2026-04-29T00:00:00.000Z',
};

const PEERS_BODY = {
  nodeId: 'townhouse-canary',
  peerCount: 2,
  connectedCount: 2,
  peers: [
    {
      id: 'town',
      connected: true,
      ilpAddresses: ['g.toon.town'],
      routeCount: 1,
    },
    {
      id: 'mill',
      connected: true,
      ilpAddresses: ['g.toon.mill'],
      routeCount: 1,
    },
  ],
};

describe('ConnectorAdminClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── T-020: Connector admin API endpoint accessible from host ──

  describe('getHealth() (T-020)', () => {
    it('returns the connector HealthStatus on the healthCheckPort', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => HEALTHY_BODY });

      const client = new ConnectorAdminClient('http://localhost:9401');
      const health = await client.getHealth();

      expect(health.status).toBe('healthy');
      expect(health.uptime).toBe(120);
      expect(health.peersConnected).toBe(2);
      expect(health.totalPeers).toBe(3);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:9401/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('throws when connector is not running (connection refused)', async () => {
      fetchMock.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

      const client = new ConnectorAdminClient('http://localhost:9401');

      await expect(client.getHealth()).rejects.toThrow(/connection refused/i);
    });

    it('handles non-200 response gracefully', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      const client = new ConnectorAdminClient('http://localhost:9401');

      await expect(client.getHealth()).rejects.toThrow(/503/);
    });

    it('throws timeout error when request exceeds timeout', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      fetchMock.mockRejectedValue(abortError);

      const client = new ConnectorAdminClient('http://localhost:9401', 1000);

      await expect(client.getHealth()).rejects.toThrow(/timeout/i);
    });
  });

  describe('getMetrics() (T-020)', () => {
    it('returns AdminMetricsJsonResponse from /admin/metrics.json', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => METRICS_BODY });

      const client = new ConnectorAdminClient('http://localhost:9402');
      const metrics = await client.getMetrics();

      expect(metrics.aggregate.packetsForwarded).toBe(1500);
      expect(metrics.aggregate.packetsRejected).toBe(12);
      expect(metrics.aggregate.bytesSent).toBe(45000);
      expect(metrics.peers).toHaveLength(1);
      expect(metrics.peers[0]?.peerId).toBe('town');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:9402/admin/metrics.json',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('throws when connector is not running', async () => {
      fetchMock.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

      const client = new ConnectorAdminClient('http://localhost:9402');

      await expect(client.getMetrics()).rejects.toThrow(/connection refused/i);
    });
  });

  describe('getPeers() (T-020)', () => {
    it('unwraps the peers array from /admin/peers', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => PEERS_BODY });

      const client = new ConnectorAdminClient('http://localhost:9402');
      const peers = await client.getPeers();

      expect(peers).toHaveLength(2);
      expect(peers[0]).toMatchObject({
        id: 'town',
        connected: true,
        ilpAddresses: ['g.toon.town'],
        routeCount: 1,
      });
      expect(peers[1]).toMatchObject({
        id: 'mill',
        connected: true,
        routeCount: 1,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:9402/admin/peers',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('returns empty array when no peers are connected', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          nodeId: 'townhouse-canary',
          peerCount: 0,
          connectedCount: 0,
          peers: [],
        }),
      });

      const client = new ConnectorAdminClient('http://localhost:9402');
      const peers = await client.getPeers();

      expect(peers).toHaveLength(0);
    });

    it('throws when connector is not running', async () => {
      fetchMock.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

      const client = new ConnectorAdminClient('http://localhost:9402');

      await expect(client.getPeers()).rejects.toThrow(/connection refused/i);
    });
  });

  describe('getHsHostname() (Story 45.3 / AC #7)', () => {
    it('returns hostname + publishedAt when bootstrap is complete (200 with non-null fields)', async () => {
      const body = {
        hostname: 'abc123.anon',
        publishedAt: '2026-05-09T00:00:00Z',
      };
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
      });

      const client = new ConnectorAdminClient('http://localhost:9401');
      const result = await client.getHsHostname();

      expect(result.hostname).toBe('abc123.anon');
      expect(result.publishedAt).toBe('2026-05-09T00:00:00Z');
    });

    it('returns nulls when bootstrap is still in progress (200 with null fields)', async () => {
      const body = { hostname: null, publishedAt: null };
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
      });

      const client = new ConnectorAdminClient('http://localhost:9401');
      const result = await client.getHsHostname();

      expect(result.hostname).toBeNull();
      expect(result.publishedAt).toBeNull();
    });

    it('throws anon-disabled error on 503 response', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ error: 'anon-disabled' }),
      });

      const client = new ConnectorAdminClient('http://localhost:9401');

      await expect(client.getHsHostname()).rejects.toThrow('anon-disabled');
    });

    it('throws on shape-violating response (hostname: number)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ hostname: 42, publishedAt: null }),
      });

      const client = new ConnectorAdminClient('http://localhost:9401');

      await expect(client.getHsHostname()).rejects.toThrow(
        /invalid hs-hostname response shape/
      );
    });

    it('throws on shape-violating response (publishedAt: number)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ hostname: 'x.anon', publishedAt: 99 }),
      });

      const client = new ConnectorAdminClient('http://localhost:9401');

      await expect(client.getHsHostname()).rejects.toThrow(
        /invalid hs-hostname response shape/
      );
    });
  });

  describe('constructor', () => {
    it('accepts base URL without trailing slash', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => HEALTHY_BODY });

      const client = new ConnectorAdminClient('http://localhost:9401');
      await client.getHealth();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:9401/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('strips trailing slash from base URL', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => HEALTHY_BODY });

      const client = new ConnectorAdminClient('http://localhost:9401/');
      await client.getHealth();

      // Should not produce double-slash URL
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:9401/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });
  });
});
