/**
 * Tests for GET /api/earnings (Story D4, AC-D4-1 + AC-D4-3).
 *
 * Test gate: happy path + leases.json absent path. We also exercise:
 *   - 400 on malformed `since`
 *   - 200 with empty by_source totals when connector reports no peers
 *   - response shape conforms to AC-D4-1
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { registerEarningsRoutes } from './earnings.js';
import type { ApiDeps } from '../types.js';
import type { ConnectorAdminClient } from '../../connector/index.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { PacketLogEntry } from '../../connector/types.js';
import type { EarningsPayload } from '../../earnings/aggregator.js';

// ── Test doubles ───────────────────────────────────────────────────────────

interface MockOpts {
  peers?: { id: string; ilpAddresses: string[] }[];
  packetsByIlp?: Record<string, PacketLogEntry[]>;
  statuses?: { name: string; type: string }[];
}

function makeDeps(opts: MockOpts): ApiDeps {
  const connectorAdmin = {
    getPeers: vi.fn(async () => opts.peers ?? []),
    getPacketLog: vi.fn(async (filter: { ilpAddress?: string }) => {
      const ilp = filter.ilpAddress ?? '';
      return opts.packetsByIlp?.[ilp] ?? [];
    }),
    getMetrics: vi.fn(async () => ({
      uptimeSeconds: 0,
      aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 },
      peers: [],
      timestamp: '',
    })),
    getHealth: vi.fn(),
  } as unknown as ConnectorAdminClient;

  const orchestrator = {
    status: vi.fn(async () => opts.statuses ?? []),
  } as unknown as DockerOrchestrator;

  return {
    configPath: '/tmp/test-earnings.yaml',
    config: {} as ApiDeps['config'],
    connectorAdmin,
    orchestrator,
    wallet: {} as ApiDeps['wallet'],
    transportProbe: {} as ApiDeps['transportProbe'],
  };
}

function pkt(
  ts: number,
  ilpTo: string,
  amount: string | number,
  result: 'fulfill' | 'reject' | 'timeout' = 'fulfill'
): PacketLogEntry {
  return {
    ts,
    ilpAddressFrom: 'g.test.client',
    ilpAddressTo: ilpTo,
    amount: String(amount),
    result,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/earnings', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('happy path: returns AC-D4-1 shape with totals + by_source + items', async () => {
    const deps = makeDeps({
      peers: [
        { id: 'townhouse-dev-town-01', ilpAddresses: ['g.test.town-01'] },
        { id: 'townhouse-dev-mill-01', ilpAddresses: ['g.test.mill-01'] },
        { id: 'townhouse-dev-dvm-01', ilpAddresses: ['g.test.dvm-01'] },
      ],
      statuses: [
        { name: 'townhouse-dev-town-01', type: 'town' },
        { name: 'townhouse-dev-mill-01', type: 'mill' },
        { name: 'townhouse-dev-dvm-01', type: 'dvm' },
      ],
      packetsByIlp: {
        'g.test.town-01': [pkt(Date.now() - 1000, 'g.test.town-01', 11)],
        'g.test.mill-01': [pkt(Date.now() - 2000, 'g.test.mill-01', 22)],
        'g.test.dvm-01': [pkt(Date.now() - 3000, 'g.test.dvm-01', 33)],
      },
    });

    app = Fastify();
    registerEarningsRoutes(app, deps, { leasesPath: null });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/earnings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as EarningsPayload;

    // AC-D4-1 shape
    expect(typeof body.since).toBe('string');
    expect(typeof body.totals.sats).toBe('string');
    expect(body.totals.tokens).toEqual({});
    expect(body.by_source.relay.sats).toBe('11');
    expect(body.by_source.mill.sats).toBe('22');
    expect(body.by_source.dvm.sats).toBe('33');
    expect(body.by_source.connector.sats).toBe('0');
    expect(body.totals.sats).toBe('66');
    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(item.asset.symbol).toBe('sats');
      expect(item.asset.decimals).toBe(0);
      expect(item.txHash).toBeUndefined();
      expect(item.explorerUrl).toBeUndefined();
    }
  });

  it('leases.json absent: items have no explorerUrl (no broken links)', async () => {
    const deps = makeDeps({
      peers: [
        { id: 'townhouse-dev-town-01', ilpAddresses: ['g.test.town-01'] },
      ],
      statuses: [{ name: 'townhouse-dev-town-01', type: 'town' }],
      packetsByIlp: {
        'g.test.town-01': [pkt(Date.now() - 100, 'g.test.town-01', 5)],
      },
    });

    app = Fastify();
    // Point at a path that does not exist — aggregator must still return
    // 200 with items but no explorerUrl on any row.
    registerEarningsRoutes(app, deps, {
      leasesPath: '/nonexistent/path/leases.json',
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/earnings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as EarningsPayload;
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.explorerUrl).toBeUndefined();
    }
  });

  it('leases.json present but no on-chain rows: items unchanged', async () => {
    // For D4 the mill SettlementEvent live emission is a known gap. Even
    // with a valid leases.json on disk, the items array contains only ILP
    // packet rows (no txHash). The route MUST still return 200.
    const dir = mkdtempSync(join(tmpdir(), 'd4-route-leases-'));
    const leasesPath = join(dir, 'leases.json');
    writeFileSync(
      leasesPath,
      JSON.stringify({ blockscout: { url: 'https://blockscout.example' } })
    );

    try {
      const deps = makeDeps({
        peers: [
          { id: 'townhouse-dev-town-01', ilpAddresses: ['g.test.town-01'] },
        ],
        statuses: [{ name: 'townhouse-dev-town-01', type: 'town' }],
        packetsByIlp: {
          'g.test.town-01': [pkt(Date.now() - 100, 'g.test.town-01', 7)],
        },
      });
      app = Fastify();
      registerEarningsRoutes(app, deps, { leasesPath });
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/earnings' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as EarningsPayload;
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0]?.explorerUrl).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('400 on non-numeric since', async () => {
    const deps = makeDeps({});
    app = Fastify();
    registerEarningsRoutes(app, deps, { leasesPath: null });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/earnings?since=abc',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe('invalid_since');
  });

  it('400 on scientific-notation since (would silently truncate)', async () => {
    const deps = makeDeps({});
    app = Fastify();
    registerEarningsRoutes(app, deps, { leasesPath: null });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/earnings?since=1e10',
    });
    expect(res.statusCode).toBe(400);
  });

  it('200 with explicit since lower bound', async () => {
    const deps = makeDeps({});
    app = Fastify();
    registerEarningsRoutes(app, deps, { leasesPath: null });
    await app.ready();

    const fixed = 1700000000000;
    const res = await app.inject({
      method: 'GET',
      url: `/api/earnings?since=${fixed}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as EarningsPayload;
    expect(body.since).toBe(new Date(fixed).toISOString());
  });

  it('connector unreachable: returns 200 with all-zero totals', async () => {
    const connectorAdmin = {
      getPeers: vi.fn(async () => {
        throw new Error('connector down');
      }),
      getPacketLog: vi.fn(),
      getMetrics: vi.fn(),
      getHealth: vi.fn(),
    } as unknown as ConnectorAdminClient;
    const deps: ApiDeps = {
      configPath: '/tmp/x.yaml',
      config: {} as ApiDeps['config'],
      connectorAdmin,
      orchestrator: {
        status: vi.fn(async () => []),
      } as unknown as DockerOrchestrator,
      wallet: {} as ApiDeps['wallet'],
      transportProbe: {} as ApiDeps['transportProbe'],
    };

    app = Fastify();
    registerEarningsRoutes(app, deps, { leasesPath: null });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/earnings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as EarningsPayload;
    expect(body.totals.sats).toBe('0');
    expect(body.items).toEqual([]);
  });
});
