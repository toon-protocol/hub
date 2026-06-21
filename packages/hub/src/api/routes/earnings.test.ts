/**
 * Tests for GET /api/earnings (Story 47.2).
 *
 * Route coverage:
 *   1. Happy path — connector returns earnings, known peer, status 'ok'.
 *   2. Connector unreachable — 200 with status 'connector_unavailable'.
 *   3. Unknown peer appears as type 'external'.
 *   4. Malformed nodes.yaml — 500 with structured `{ error: 'nodes_yaml_invalid' }`.
 *
 * Comprehensive shape/recentClaims/eventsRelayed coverage lands in 47.4.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';

import { registerEarningsRoutes } from './earnings.js';
import { earningsResponseSchema } from '../schemas/earnings.js';
import type { ApiDeps } from '../types.js';
import type { ConnectorAdminClient } from '../../connector/index.js';
import type {
  EarningsResponse,
  AssetEarnings,
  MetricsResponse,
} from '../../connector/types.js';
import type { AggregatedEarnings } from '../../earnings/aggregator.js';
import type { SnapshotEntry } from '../../earnings/snapshot-writer.js';

// AC #5 — validate every route response against the wire-contract schema.
// Closes the loop between the schema (declared in api/schemas/earnings.ts)
// and the integration fixtures (this file's tests). Without this, drift
// between aggregator output and schema would only surface as Fastify
// fast-json-stringify silently dropping fields — no test would fail.
const ajv = new Ajv();
addFormats(ajv);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validateResponseShape = ajv.compile(
  (earningsResponseSchema.response as any)[200]
);
function expectMatchesSchema(body: unknown): void {
  const ok = validateResponseShape(body);
  if (!ok) {
    throw new Error(
      `response does not match earningsResponseSchema: ${JSON.stringify(validateResponseShape.errors)}`
    );
  }
}

// ── Test doubles ───────────────────────────────────────────────────────────

const ENABLED_AT = '2026-01-01T00:00:00Z';

const DEFAULT_METRICS: MetricsResponse = {
  uptimeSeconds: 0,
  aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 },
  peers: [],
  timestamp: '',
};

interface MockOpts {
  earnings?: EarningsResponse;
  earningsThrow?: boolean;
  metrics?: MetricsResponse | 'throw';
  snapshotEntries?: SnapshotEntry[];
}

function assetEntry(code: string, received: string): AssetEarnings {
  return {
    assetCode: code,
    assetScale: 6,
    claimsReceivedTotal: received,
    claimsSentTotal: '0',
    netBalance: received,
    lastClaimAt: null,
  };
}

function makeDeps(opts: MockOpts, tmpHome: string): ApiDeps {
  // Seed snapshot file if entries provided.
  if (opts.snapshotEntries && opts.snapshotEntries.length > 0) {
    const lines =
      opts.snapshotEntries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(tmpHome, 'earnings-snapshots.jsonl'), lines, {
      encoding: 'utf-8',
    });
  }

  const connectorAdmin = {
    getEarnings: vi.fn(async () => {
      if (opts.earningsThrow) throw new Error('connector down');
      return (
        opts.earnings ?? {
          uptimeSeconds: 0,
          peers: [],
          connectorFees: [],
          recentClaims: [],
          timestamp: { iso: '' },
        }
      );
    }),
    getMetrics: vi.fn(async () => {
      if (opts.metrics === 'throw') throw new Error('metrics down');
      return opts.metrics ?? DEFAULT_METRICS;
    }),
    getHealth: vi.fn(),
    getPeers: vi.fn(async () => []),
    getPacketLog: vi.fn(async () => []),
  } as unknown as ConnectorAdminClient;

  return {
    configPath: join(tmpHome, 'config.yaml'),
    config: {} as ApiDeps['config'],
    connectorAdmin,
    orchestrator: {} as ApiDeps['orchestrator'],
    wallet: {} as ApiDeps['wallet'],
    transportProbe: {} as ApiDeps['transportProbe'],
  };
}

/** Write a minimal nodes.yaml (real YAML, not JSON-passing-as-YAML). */
function writeNodesYaml(
  tmpHome: string,
  entries: { peerId: string; type: 'town' | 'mill' | 'dvm' }[]
): void {
  const doc = {
    entries: entries.map((e, i) => ({
      id: `node-${i}`,
      type: e.type,
      peerId: e.peerId,
      ilpAddress: `g.toon.test.${i}`,
      derivationIndex: i,
      enabledAt: ENABLED_AT,
      lastSeenAt: null,
    })),
  };
  writeFileSync(join(tmpHome, 'nodes.yaml'), yamlStringify(doc), {
    mode: 0o600,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/earnings', () => {
  let app: FastifyInstance;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (app) await app.close();
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('happy path: returns AggregatedEarnings shape with status "ok"', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), '47-2-route-'));
    tmpDirs.push(tmpHome);

    writeNodesYaml(tmpHome, [{ peerId: 'peer-town-01', type: 'town' }]);

    const recentClaim = {
      peerId: 'peer-town-01',
      assetCode: 'USD',
      assetScale: 6,
      amount: '100000',
      direction: 'inbound' as const,
      at: '2026-05-13T12:00:00Z',
    };
    const earnings: EarningsResponse = {
      uptimeSeconds: 5,
      connectorFees: [{ assetCode: 'USD', assetScale: 6, total: '1000' }],
      recentClaims: [recentClaim],
      timestamp: { iso: '2026-05-12T00:00:00Z' },
      peers: [
        {
          peerId: 'peer-town-01',
          byAsset: [
            {
              ...assetEntry('USD', '500'),
              lastClaimAt: '2026-05-13T12:00:00Z',
            },
          ],
        },
      ],
    };
    const metrics: MetricsResponse = {
      uptimeSeconds: 3600,
      aggregate: { packetsForwarded: 1234, packetsRejected: 0, bytesSent: 0 },
      peers: [
        {
          peerId: 'peer-town-01',
          connected: true,
          packetsForwarded: 500,
          packetsRejected: 0,
          bytesSent: 0,
          lastPacketAt: null,
        },
        {
          peerId: 'peer-other',
          connected: true,
          packetsForwarded: 734,
          packetsRejected: 0,
          bytesSent: 0,
          lastPacketAt: null,
        },
      ],
      timestamp: '',
    };
    const deps = makeDeps({ earnings, metrics }, tmpHome);

    app = Fastify();
    registerEarningsRoutes(app, deps);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/earnings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AggregatedEarnings;
    expectMatchesSchema(body);

    expect(body.status).toBe('ok');
    expect(body.apex.routingFees['USD'].lifetime).toBe('1000');
    expect(Array.isArray(body.peers)).toBe(true);
    expect(body.peers).toHaveLength(1);
    expect(body.peers[0].type).toBe('town');
    expect(body.peers[0].byAsset['USD'].lifetime).toBe('500');
    expect(body.peers[0].lastClaimAt).toBe('2026-05-13T12:00:00Z');
    expect(body.recentClaims).toEqual([recentClaim]);
    // eventsRelayed = sum of peers[].packetsForwarded = 500 + 734 = 1234
    expect(body.eventsRelayed).toBe(1234);
    expect(body.uptimeSeconds).toBe(3600);
  });

  it('connector unreachable: 200 with status "connector_unavailable"', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), '47-2-route-'));
    tmpDirs.push(tmpHome);

    const deps = makeDeps({ earningsThrow: true }, tmpHome);

    app = Fastify();
    registerEarningsRoutes(app, deps);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/earnings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AggregatedEarnings;
    expectMatchesSchema(body);
    expect(body).toEqual({
      status: 'connector_unavailable',
      apex: { routingFees: {} },
      peers: [],
      recentClaims: [],
      eventsRelayed: 0,
      uptimeSeconds: 0,
    });
  });

  it('unknown peer appears as type "external"', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), '47-2-route-'));
    tmpDirs.push(tmpHome);

    // nodes.yaml has no entries — all connector peers are external.
    writeNodesYaml(tmpHome, []);

    const earnings: EarningsResponse = {
      uptimeSeconds: 0,
      connectorFees: [],
      recentClaims: [],
      timestamp: { iso: '' },
      peers: [
        { peerId: 'peer-unknown-99', byAsset: [assetEntry('USD', '77')] },
      ],
    };
    const metrics: MetricsResponse = {
      uptimeSeconds: 0,
      aggregate: { packetsForwarded: 42, packetsRejected: 0, bytesSent: 0 },
      peers: [
        {
          peerId: 'peer-unknown-99',
          connected: true,
          packetsForwarded: 42,
          packetsRejected: 0,
          bytesSent: 0,
          lastPacketAt: null,
        },
      ],
      timestamp: '',
    };
    const deps = makeDeps({ earnings, metrics }, tmpHome);

    app = Fastify();
    registerEarningsRoutes(app, deps);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/earnings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AggregatedEarnings;
    expectMatchesSchema(body);
    expect(body.status).toBe('ok');
    expect(body.peers).toHaveLength(1);
    expect(body.peers[0].type).toBe('external');
    expect(body.peers[0].byAsset['USD'].lifetime).toBe('77');
    expect(body.peers[0].lastClaimAt).toBeNull();
    expect(body.eventsRelayed).toBe(42);
  });

  it('delta windows populated from snapshot file', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), '47-4-route-'));
    tmpDirs.push(tmpHome);

    writeNodesYaml(tmpHome, [{ peerId: 'peer-town-01', type: 'town' }]);

    // Seed snapshot: today/month/year boundaries for peer-town-01/USD.
    const snapshotEntries: SnapshotEntry[] = [
      {
        ts: '2026-05-13T00:00:00.000Z',
        peerId: 'peer-town-01',
        assetCode: 'USD',
        claimsReceivedTotal: '900',
      },
      {
        ts: '2026-05-01T00:00:00.000Z',
        peerId: 'peer-town-01',
        assetCode: 'USD',
        claimsReceivedTotal: '500',
      },
      {
        ts: '2026-01-01T00:00:00.000Z',
        peerId: 'peer-town-01',
        assetCode: 'USD',
        claimsReceivedTotal: '100',
      },
    ];

    const earnings: EarningsResponse = {
      uptimeSeconds: 0,
      connectorFees: [],
      recentClaims: [],
      timestamp: { iso: '' },
      peers: [{ peerId: 'peer-town-01', byAsset: [assetEntry('USD', '1000')] }],
    };

    const deps = makeDeps({ earnings, snapshotEntries }, tmpHome);

    app = Fastify();
    registerEarningsRoutes(app, deps);
    await app.ready();

    // Freeze clock at 2026-05-13T15:00:00Z so boundaries are deterministic.
    vi.useFakeTimers({
      now: new Date('2026-05-13T15:00:00.000Z'),
      toFake: ['Date'],
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/earnings' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AggregatedEarnings;
      expectMatchesSchema(body);

      expect(body.status).toBe('ok');
      const usd = body.peers[0].byAsset['USD'];
      expect(usd.lifetime).toBe('1000');
      expect(usd.today).toBe('100'); // 1000 - 900
      expect(usd.month).toBe('500'); // 1000 - 500
      expect(usd.year).toBe('900'); // 1000 - 100
    } finally {
      vi.useRealTimers();
    }
  });

  it('apex delta windows populated from snapshot file', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), '47-4-route-'));
    tmpDirs.push(tmpHome);

    writeNodesYaml(tmpHome, []);

    const snapshotEntries: SnapshotEntry[] = [
      {
        ts: '2026-05-13T00:00:00.000Z',
        peerId: '__apex__',
        assetCode: 'USD',
        claimsReceivedTotal: '1000',
      },
    ];

    const earnings: EarningsResponse = {
      uptimeSeconds: 0,
      connectorFees: [{ assetCode: 'USD', assetScale: 6, total: '2000' }],
      recentClaims: [],
      timestamp: { iso: '' },
      peers: [],
    };

    const deps = makeDeps({ earnings, snapshotEntries }, tmpHome);

    app = Fastify();
    registerEarningsRoutes(app, deps);
    await app.ready();

    vi.useFakeTimers({
      now: new Date('2026-05-13T15:00:00.000Z'),
      toFake: ['Date'],
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/earnings' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AggregatedEarnings;
      expectMatchesSchema(body);
      expect(body.apex.routingFees['USD'].today).toBe('1000'); // 2000 - 1000
      expect(body.apex.routingFees['USD'].lifetime).toBe('2000');
    } finally {
      vi.useRealTimers();
    }
  });

  it('getMetrics fails, getEarnings succeeds → status ok with eventsRelayed=0', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), '47-4-route-'));
    tmpDirs.push(tmpHome);

    writeNodesYaml(tmpHome, [{ peerId: 'peer-town-01', type: 'town' }]);

    const earnings: EarningsResponse = {
      uptimeSeconds: 0,
      connectorFees: [],
      recentClaims: [],
      timestamp: { iso: '' },
      peers: [{ peerId: 'peer-town-01', byAsset: [assetEntry('USD', '500')] }],
    };
    const deps = makeDeps({ earnings, metrics: 'throw' }, tmpHome);

    app = Fastify({ logger: false });
    registerEarningsRoutes(app, deps);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/earnings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AggregatedEarnings;
    expectMatchesSchema(body);
    expect(body.status).toBe('ok');
    expect(body.eventsRelayed).toBe(0);
    expect(body.uptimeSeconds).toBe(0);
    expect(body.peers).toHaveLength(1);
  });

  it('malformed nodes.yaml → 500 with { error: "nodes_yaml_invalid" }', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), '47-2-route-'));
    tmpDirs.push(tmpHome);

    // `type: 'wrong'` is not in the NodeType enum — ZodError on parse.
    const badYaml = yamlStringify({
      entries: [
        {
          id: 'node-bad',
          type: 'wrong',
          peerId: 'peer-bad',
          ilpAddress: 'g.toon.test.bad',
          derivationIndex: 0,
          enabledAt: ENABLED_AT,
          lastSeenAt: null,
        },
      ],
    });
    writeFileSync(join(tmpHome, 'nodes.yaml'), badYaml, { mode: 0o600 });

    const deps = makeDeps({}, tmpHome);

    app = Fastify({ logger: false });
    registerEarningsRoutes(app, deps);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/earnings' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'nodes_yaml_invalid' });
  });
});
