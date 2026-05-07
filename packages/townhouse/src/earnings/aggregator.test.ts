/**
 * Unit tests for the earnings aggregator (Story D4).
 *
 * Test gate matrix (AC requires ≥3 cases — we run more):
 *   1. Empty sources — connector reports no peers, all buckets are zero.
 *   2. Full sources — one peer per node type, packet log has fulfilled
 *      packets, totals match expected sum.
 *   3. Partial sources — only town + dvm registered, mill bucket is zero
 *      (no fake numbers per the no-mock policy).
 *
 * Plus: rejected packets are excluded from sats totals; items array is
 * capped + sorted newest-first; connector unavailable degrades gracefully.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ConnectorAdminClient } from '../connector/index.js';
import type { DockerOrchestrator } from '../docker/orchestrator.js';
import type { PacketLogEntry } from '../connector/types.js';

import { aggregateEarnings, MAX_ITEMS } from './aggregator.js';

// ── Test doubles ───────────────────────────────────────────────────────────

interface MockConfig {
  peers?: { id: string; ilpAddresses: string[] }[];
  packetsByIlp?: Record<string, PacketLogEntry[]>;
  /** When true, getPeers throws. */
  peersThrow?: boolean;
  /** When true, getPacketLog throws. */
  packetsThrow?: boolean;
  /** Statuses returned by orchestrator.status(). */
  statuses?: { name: string; type: string }[];
}

function makeConnector(cfg: MockConfig): ConnectorAdminClient {
  return {
    getPeers: vi.fn(async () => {
      if (cfg.peersThrow) throw new Error('connector down');
      return cfg.peers ?? [];
    }),
    getPacketLog: vi.fn(async (filter: { ilpAddress?: string }) => {
      if (cfg.packetsThrow) throw new Error('packets endpoint down');
      const ilp = filter.ilpAddress ?? '';
      return cfg.packetsByIlp?.[ilp] ?? [];
    }),
    getMetrics: vi.fn(async () => ({
      uptimeSeconds: 0,
      aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 },
      peers: [],
      timestamp: '',
    })),
    getHealth: vi.fn(async () => ({
      status: 'healthy' as const,
      uptime: 0,
      peersConnected: 0,
      totalPeers: 0,
      timestamp: '',
    })),
  } as unknown as ConnectorAdminClient;
}

function makeOrchestrator(cfg: MockConfig): DockerOrchestrator {
  return {
    status: vi.fn(async () => cfg.statuses ?? []),
  } as unknown as DockerOrchestrator;
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

describe('aggregateEarnings', () => {
  it('[case 1] empty sources — all buckets zero, items empty', async () => {
    const cfg: MockConfig = { peers: [], statuses: [] };
    const result = await aggregateEarnings({
      connectorAdmin: makeConnector(cfg),
      orchestrator: makeOrchestrator(cfg),
      leasesPath: null,
    });

    expect(result.totals.sats).toBe('0');
    expect(result.by_source.relay.sats).toBe('0');
    expect(result.by_source.mill.sats).toBe('0');
    expect(result.by_source.dvm.sats).toBe('0');
    expect(result.by_source.connector.sats).toBe('0');
    expect(result.items).toEqual([]);
    expect(typeof result.since).toBe('string');
  });

  it('[case 2] full sources — totals match per-source sum', async () => {
    const cfg: MockConfig = {
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
        'g.test.town-01': [
          pkt(Date.now() - 5_000, 'g.test.town-01', 100),
          pkt(Date.now() - 4_000, 'g.test.town-01', 50),
        ],
        'g.test.mill-01': [pkt(Date.now() - 3_000, 'g.test.mill-01', 1000)],
        'g.test.dvm-01': [
          pkt(Date.now() - 2_000, 'g.test.dvm-01', 200),
          pkt(Date.now() - 1_000, 'g.test.dvm-01', 300),
        ],
      },
    };
    const result = await aggregateEarnings({
      connectorAdmin: makeConnector(cfg),
      orchestrator: makeOrchestrator(cfg),
      leasesPath: null,
    });

    expect(result.by_source.relay.sats).toBe('150'); // 100 + 50
    expect(result.by_source.mill.sats).toBe('1000');
    expect(result.by_source.dvm.sats).toBe('500'); // 200 + 300
    expect(result.by_source.connector.sats).toBe('0'); // not yet wired
    expect(result.totals.sats).toBe('1650');
    expect(result.items).toHaveLength(5);

    // Items must be sorted newest-first.
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].ts >= result.items[i].ts).toBe(true);
    }

    // No txHash / explorerUrl on ILP-layer rows (D3 wiring downstream).
    for (const item of result.items) {
      expect(item.txHash).toBeUndefined();
      expect(item.explorerUrl).toBeUndefined();
    }
  });

  it('[case 3] partial sources — only town + dvm registered', async () => {
    const cfg: MockConfig = {
      peers: [
        { id: 'townhouse-dev-town-01', ilpAddresses: ['g.test.town-01'] },
        { id: 'townhouse-dev-dvm-01', ilpAddresses: ['g.test.dvm-01'] },
      ],
      statuses: [
        { name: 'townhouse-dev-town-01', type: 'town' },
        { name: 'townhouse-dev-dvm-01', type: 'dvm' },
      ],
      packetsByIlp: {
        'g.test.town-01': [pkt(Date.now() - 1_000, 'g.test.town-01', 42)],
        'g.test.dvm-01': [pkt(Date.now() - 500, 'g.test.dvm-01', 99)],
      },
    };
    const result = await aggregateEarnings({
      connectorAdmin: makeConnector(cfg),
      orchestrator: makeOrchestrator(cfg),
      leasesPath: null,
    });

    expect(result.by_source.relay.sats).toBe('42');
    expect(result.by_source.mill.sats).toBe('0'); // no mill peer
    expect(result.by_source.dvm.sats).toBe('99');
    expect(result.totals.sats).toBe('141');
    expect(result.items).toHaveLength(2);
  });

  it('rejected and timed-out packets are excluded from sats totals', async () => {
    const cfg: MockConfig = {
      peers: [
        { id: 'townhouse-dev-town-01', ilpAddresses: ['g.test.town-01'] },
      ],
      statuses: [{ name: 'townhouse-dev-town-01', type: 'town' }],
      packetsByIlp: {
        'g.test.town-01': [
          pkt(Date.now() - 1000, 'g.test.town-01', 100, 'fulfill'),
          pkt(Date.now() - 900, 'g.test.town-01', 999, 'reject'),
          pkt(Date.now() - 800, 'g.test.town-01', 9999, 'timeout'),
          pkt(Date.now() - 700, 'g.test.town-01', 50, 'fulfill'),
        ],
      },
    };
    const result = await aggregateEarnings({
      connectorAdmin: makeConnector(cfg),
      orchestrator: makeOrchestrator(cfg),
      leasesPath: null,
    });

    expect(result.by_source.relay.sats).toBe('150'); // 100 + 50
    expect(result.items).toHaveLength(2);
  });

  it('connector unavailable degrades to all-zero, no throw', async () => {
    const cfg: MockConfig = { peersThrow: true };
    const result = await aggregateEarnings({
      connectorAdmin: makeConnector(cfg),
      orchestrator: makeOrchestrator(cfg),
      leasesPath: null,
    });

    expect(result.totals.sats).toBe('0');
    expect(result.items).toEqual([]);
  });

  it('items array is capped at MAX_ITEMS', async () => {
    const many: PacketLogEntry[] = Array.from(
      { length: MAX_ITEMS + 50 },
      (_, i) => pkt(Date.now() - i * 1_000, 'g.test.town-01', 1)
    );
    const cfg: MockConfig = {
      peers: [
        { id: 'townhouse-dev-town-01', ilpAddresses: ['g.test.town-01'] },
      ],
      statuses: [{ name: 'townhouse-dev-town-01', type: 'town' }],
      packetsByIlp: { 'g.test.town-01': many },
    };
    const result = await aggregateEarnings({
      connectorAdmin: makeConnector(cfg),
      orchestrator: makeOrchestrator(cfg),
      leasesPath: null,
    });

    expect(result.items.length).toBe(MAX_ITEMS);
    // Total sats reflects ALL packets, not just the visible items.
    expect(result.by_source.relay.sats).toBe(String(MAX_ITEMS + 50));
  });

  it('falls back to peer-id heuristic when orchestrator status is empty', async () => {
    // Some peers exist on the connector but the orchestrator doesn't list
    // them (e.g. the demo image was started outside Townhouse). The peer-id
    // string contains 'mill' — heuristic attribution should kick in.
    const cfg: MockConfig = {
      peers: [{ id: 'standalone-mill', ilpAddresses: ['g.test.mill-x'] }],
      statuses: [], // orchestrator says nothing
      packetsByIlp: {
        'g.test.mill-x': [pkt(Date.now() - 100, 'g.test.mill-x', 7)],
      },
    };
    const result = await aggregateEarnings({
      connectorAdmin: makeConnector(cfg),
      orchestrator: makeOrchestrator(cfg),
      leasesPath: null,
    });

    expect(result.by_source.mill.sats).toBe('7');
  });

  it('respects sinceMs for the lower-bound timestamp', async () => {
    const fixedSince = 1700000000000;
    const cfg: MockConfig = { peers: [], statuses: [] };
    const result = await aggregateEarnings({
      connectorAdmin: makeConnector(cfg),
      orchestrator: makeOrchestrator(cfg),
      leasesPath: null,
      sinceMs: fixedSince,
    });

    expect(result.since).toBe(new Date(fixedSince).toISOString());
  });

  it('orchestrator unavailable degrades to peer-name heuristics', async () => {
    const cfg: MockConfig = {
      peers: [{ id: 'town-prod', ilpAddresses: ['g.test.town-prod'] }],
      packetsByIlp: {
        'g.test.town-prod': [pkt(Date.now() - 100, 'g.test.town-prod', 5)],
      },
    };
    const orchestrator = {
      status: vi.fn(async () => {
        throw new Error('docker down');
      }),
    } as unknown as DockerOrchestrator;
    const result = await aggregateEarnings({
      connectorAdmin: makeConnector(cfg),
      orchestrator,
      leasesPath: null,
    });

    expect(result.by_source.relay.sats).toBe('5');
  });
});
