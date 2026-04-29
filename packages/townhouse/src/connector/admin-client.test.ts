/**
 * Unit Tests: ConnectorAdminClient (Story 21.3)
 *
 * Test IDs map to test-design-epic-21.md scenario T-020.
 *
 * These tests verify:
 * - AC #4: Connector admin API endpoint exposed for dashboard metrics
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ConnectorAdminClient } from './admin-client.js';

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
    it('returns health status from connector admin API', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'healthy', uptime: 120 }),
      });

      const client = new ConnectorAdminClient('http://localhost:9401');
      const health = await client.getHealth();

      expect(health.status).toBe('healthy');
      expect(health.uptime).toBe(120);
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
    it('returns metrics from connector admin API', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          packetsForwarded: 1500,
          packetsRejected: 12,
          bytesSent: 45000,
        }),
      });

      const client = new ConnectorAdminClient('http://localhost:9401');
      const metrics = await client.getMetrics();

      expect(metrics.packetsForwarded).toBe(1500);
      expect(metrics.packetsRejected).toBe(12);
      expect(metrics.bytesSent).toBe(45000);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:9401/metrics',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('throws when connector is not running', async () => {
      fetchMock.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

      const client = new ConnectorAdminClient('http://localhost:9401');

      await expect(client.getMetrics()).rejects.toThrow(/connection refused/i);
    });
  });

  describe('getPeers() (T-020)', () => {
    it('returns peer status list from connector admin API', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 'town', connected: true, packetsForwarded: 800 },
          { id: 'mill', connected: true, packetsForwarded: 700 },
        ],
      });

      const client = new ConnectorAdminClient('http://localhost:9401');
      const peers = await client.getPeers();

      expect(peers).toHaveLength(2);
      expect(peers[0]).toMatchObject({
        id: 'town',
        connected: true,
        packetsForwarded: 800,
      });
      expect(peers[1]).toMatchObject({
        id: 'mill',
        connected: true,
        packetsForwarded: 700,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:9401/peers',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('returns empty array when no peers are connected', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      const client = new ConnectorAdminClient('http://localhost:9401');
      const peers = await client.getPeers();

      expect(peers).toHaveLength(0);
    });

    it('throws when connector is not running', async () => {
      fetchMock.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

      const client = new ConnectorAdminClient('http://localhost:9401');

      await expect(client.getPeers()).rejects.toThrow(/connection refused/i);
    });
  });

  describe('constructor', () => {
    it('accepts base URL without trailing slash', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'healthy', uptime: 10 }),
      });

      const client = new ConnectorAdminClient('http://localhost:9401');
      await client.getHealth();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:9401/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('strips trailing slash from base URL', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'healthy', uptime: 10 }),
      });

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
