/**
 * Tests for cli/drill-commands.ts handlers.
 *
 * Pattern: inject mocked ConnectorAdminClient and/or Docker via opts DI seams.
 * Tests assert on stdout/stderr captures + process.exitCode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Docker from 'dockerode';
import type {
  ChannelSummary,
  MetricsResponse,
  PeerStatus,
  PeerEarnings,
  EarningsResponse,
} from '../connector/types.js';
import type { ConnectorAdminClient } from '../connector/admin-client.js';
import {
  handleChannels,
  handleMetrics,
  handleLogs,
  handlePeerDetail,
  handleHealth,
} from './drill-commands.js';

// ── Fixtures ────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-05-14T12:00:00.000Z');

const CHANNEL_1: ChannelSummary = {
  channelId: 'channel-id-long-enough',
  peerId: 'peer-id-long',
  chain: 'evm:1',
  status: 'open',
  deposit: '1000000',
  lastActivity: '2026-05-14T11:00:00.000Z',
};

const METRICS_BODY: MetricsResponse = {
  uptimeSeconds: 3600,
  aggregate: { packetsForwarded: 100, packetsRejected: 5, bytesSent: 50000 },
  peers: [
    {
      peerId: 'town',
      connected: true,
      packetsForwarded: 100,
      packetsRejected: 5,
      bytesSent: 50000,
      lastPacketAt: '2026-05-14T11:59:00.000Z',
    },
  ],
  timestamp: '2026-05-14T12:00:00.000Z',
};

const PEER_STATUS: PeerStatus = {
  id: 'town',
  connected: true,
  ilpAddresses: ['g.toon.town'],
  routeCount: 3,
};

const EARNINGS_BODY: EarningsResponse = {
  uptimeSeconds: 3600,
  peers: [
    {
      peerId: 'town',
      byAsset: [
        {
          assetCode: 'USDC',
          assetScale: 6,
          claimsReceivedTotal: '1000',
          claimsSentTotal: '500',
          netBalance: '500',
          lastClaimAt: '2026-05-14T11:00:00.000Z',
        },
      ],
    },
  ],
  connectorFees: [],
  recentClaims: [],
  timestamp: { iso: '2026-05-14T12:00:00.000Z' },
};

// ── Helpers ──────────────────────────────────────────────────────────────────────

function makeMockClient(
  overrides: Partial<{
    getChannels: () => Promise<ChannelSummary[]>;
    getMetrics: () => Promise<MetricsResponse>;
    getPeers: () => Promise<PeerStatus[]>;
    getEarnings: () => Promise<EarningsResponse>;
    getHealth: () => Promise<unknown>;
    pingAdminLive: () => Promise<unknown>;
    getHsHostname: () => Promise<unknown>;
  }>
): ConnectorAdminClient {
  const client = {
    getChannels: overrides.getChannels ?? vi.fn().mockResolvedValue([]),
    getMetrics: overrides.getMetrics ?? vi.fn().mockResolvedValue(METRICS_BODY),
    getPeers: overrides.getPeers ?? vi.fn().mockResolvedValue([PEER_STATUS]),
    getEarnings:
      overrides.getEarnings ?? vi.fn().mockResolvedValue(EARNINGS_BODY),
    getHealth:
      overrides.getHealth ??
      vi.fn().mockResolvedValue({
        status: 'healthy',
        uptime: 3600,
        peersConnected: 1,
        totalPeers: 1,
        timestamp: '2026-05-14T12:00:00.000Z',
      }),
    pingAdminLive:
      overrides.pingAdminLive ??
      vi.fn().mockResolvedValue({
        status: 'healthy',
        nodeId: 'townhouse-hs-connector',
      }),
    getHsHostname:
      overrides.getHsHostname ??
      vi.fn().mockResolvedValue({
        hostname: 'abc123.anon',
        publishedAt: '2026-05-14T10:00:00.000Z',
      }),
    getBaseUrl: () => 'http://127.0.0.1:9401',
    baseUrl: 'http://127.0.0.1:9401',
  } as unknown as ConnectorAdminClient;
  return client;
}

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    stdoutChunks.push(args.join(' ') + '\n');
  });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    stderrChunks.push(args.join(' ') + '\n');
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function getStdout(): string {
  return stdoutChunks.join('');
}

function getStderr(): string {
  return stderrChunks.join('');
}

// ── handleChannels ───────────────────────────────────────────────────────────────

describe('handleChannels', () => {
  describe('human mode', () => {
    it('prints table header with CHANNEL column when channels are present', async () => {
      const client = makeMockClient({
        getChannels: vi.fn().mockResolvedValue([CHANNEL_1]),
      });
      await handleChannels(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStdout()).toContain('CHANNEL');
      expect(getStdout()).toContain('PEER');
      expect(getStdout()).toContain('CHAIN');
      expect(getStdout()).toContain('STATUS');
      expect(getStdout()).toContain('DEPOSIT');
      expect(getStdout()).toContain('LAST ACTIVITY');
    });

    it('prints truncated channelId and peerId', async () => {
      const client = makeMockClient({
        getChannels: vi.fn().mockResolvedValue([CHANNEL_1]),
      });
      await handleChannels(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      // channelId 'channel-id-long-enough' is >16 chars → truncated
      expect(getStdout()).toContain('channel-id-long-');
    });

    it('prints "No channels open" when empty', async () => {
      const client = makeMockClient({
        getChannels: vi.fn().mockResolvedValue([]),
      });
      await handleChannels(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStdout()).toContain('No channels open');
    });

    it('prints error to stderr and sets exitCode=1 on connector unreachable', async () => {
      const client = makeMockClient({
        getChannels: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      await handleChannels(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStderr()).toContain('Failed to fetch connector channels');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('json mode', () => {
    it('emits ChannelSummary[] as JSON array', async () => {
      const client = makeMockClient({
        getChannels: vi.fn().mockResolvedValue([CHANNEL_1]),
      });
      await handleChannels(client, {
        json: true,
        jsonCompact: false,
        now: NOW,
      });
      const parsed = JSON.parse(getStdout()) as ChannelSummary[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]!.channelId).toBe(CHANNEL_1.channelId);
    });

    it('emits error envelope with code=unreachable on failure', async () => {
      const client = makeMockClient({
        getChannels: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      });
      await handleChannels(client, {
        json: true,
        jsonCompact: false,
        now: NOW,
      });
      const parsed = JSON.parse(getStdout()) as { error: string; code: string };
      expect(parsed.code).toBe('unreachable');
      expect(typeof parsed.error).toBe('string');
      expect(process.exitCode).toBe(1);
    });

    it('exit code is 0 on success', async () => {
      const client = makeMockClient({
        getChannels: vi.fn().mockResolvedValue([]),
      });
      await handleChannels(client, {
        json: true,
        jsonCompact: false,
        now: NOW,
      });
      expect(process.exitCode).toBeUndefined();
    });
  });
});

// ── handleMetrics ────────────────────────────────────────────────────────────────

describe('handleMetrics', () => {
  describe('human mode', () => {
    it('prints aggregate block verbatim with "Packets forwarded" label', async () => {
      const client = makeMockClient({});
      await handleMetrics(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStdout()).toContain('Packets forwarded');
      expect(getStdout()).toContain('100');
    });

    it('prints per-peer table with PACKETS FWD column', async () => {
      const client = makeMockClient({});
      await handleMetrics(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStdout()).toContain('PACKETS FWD');
      expect(getStdout()).toContain('PEER');
    });

    it('prints "No peers connected" when peers array is empty', async () => {
      const client = makeMockClient({
        getPeers: vi.fn().mockResolvedValue([]),
      });
      await handleMetrics(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStdout()).toContain('No peers connected');
    });

    it('prints error to stderr and sets exitCode=1 on failure', async () => {
      const client = makeMockClient({
        getMetrics: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      await handleMetrics(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStderr()).toContain('Failed to fetch connector metrics');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('json mode', () => {
    it('emits aggregate + peers + peersDetail + timestamp', async () => {
      const client = makeMockClient({});
      await handleMetrics(client, { json: true, jsonCompact: false, now: NOW });
      const parsed = JSON.parse(getStdout()) as {
        aggregate: unknown;
        peers: unknown[];
        peersDetail: unknown[];
        uptimeSeconds: number;
        timestamp: string;
      };
      expect(typeof parsed.aggregate).toBe('object');
      expect(Array.isArray(parsed.peers)).toBe(true);
      expect(Array.isArray(parsed.peersDetail)).toBe(true);
      expect(typeof parsed.uptimeSeconds).toBe('number');
    });

    it('emits error envelope on failure', async () => {
      const client = makeMockClient({
        getMetrics: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      });
      await handleMetrics(client, { json: true, jsonCompact: false, now: NOW });
      const parsed = JSON.parse(getStdout()) as { error: string; code: string };
      expect(parsed.code).toBe('unreachable');
      expect(process.exitCode).toBe(1);
    });
  });
});

// ── handleLogs ────────────────────────────────────────────────────────────────────

describe('handleLogs', () => {
  it('resolves townhouse- prefixed container names verbatim', async () => {
    const listContainersMock = vi
      .fn()
      .mockResolvedValue([{ Names: ['/townhouse-connector'] }]);

    // Call 'end' handler synchronously when it's registered so the while loop exits immediately
    const mockStream2 = {
      on: vi.fn().mockImplementation((event: string, handler: () => void) => {
        if (event === 'end') handler();
        return mockStream2;
      }),
      destroy: vi.fn(),
    };

    const mockDocker = {
      listContainers: listContainersMock,
      getContainer: vi.fn().mockReturnValue({
        logs: vi.fn().mockResolvedValue(mockStream2),
      }),
    } as unknown as Docker;

    await handleLogs(mockDocker, 'townhouse-connector', {
      lines: 50,
      json: false,
      jsonCompact: false,
      docker: mockDocker,
    });
    expect(listContainersMock).toHaveBeenCalled();
  });

  it('emits unknown-node error when container does not exist', async () => {
    const mockDocker = {
      listContainers: vi.fn().mockResolvedValue([]),
    } as unknown as Docker;

    await handleLogs(mockDocker, 'nonexistent-node', {
      lines: 50,
      json: false,
      jsonCompact: false,
      docker: mockDocker,
    });

    expect(getStderr()).toContain('is not running');
    expect(process.exitCode).toBe(1);
  });

  it('emits ambiguous-node error when multiple containers match a bare service tag', async () => {
    const mockDocker = {
      listContainers: vi
        .fn()
        .mockResolvedValue([
          { Names: ['/townhouse-town-01'] },
          { Names: ['/townhouse-town-02'] },
        ]),
    } as unknown as Docker;

    await handleLogs(mockDocker, 'town', {
      lines: 50,
      json: false,
      jsonCompact: false,
      docker: mockDocker,
    });

    expect(getStderr()).toContain('Ambiguous node-id');
    expect(process.exitCode).toBe(1);
  });

  it('emits docker-unavailable error when Docker daemon is unreachable (json mode)', async () => {
    const mockDocker = {
      listContainers: vi
        .fn()
        .mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock')),
    } as unknown as Docker;

    await handleLogs(mockDocker, 'connector', {
      lines: 50,
      json: true,
      jsonCompact: false,
      docker: mockDocker,
    });

    const parsed = JSON.parse(getStdout()) as { code: string };
    expect(parsed.code).toBe('docker-unavailable');
    expect(process.exitCode).toBe(1);
  });

  it('resolves bare service tag to townhouse-<tag> when unambiguous', async () => {
    const listMock = vi
      .fn()
      .mockResolvedValue([{ Names: ['/townhouse-connector'] }]);

    // Call 'end' handler synchronously when it's registered so while loop exits immediately
    const mockStream = {
      on: vi.fn().mockImplementation((event: string, handler: () => void) => {
        if (event === 'end') handler();
        return mockStream;
      }),
      destroy: vi.fn(),
    };

    const mockDocker = {
      listContainers: listMock,
      getContainer: vi.fn().mockReturnValue({
        logs: vi.fn().mockResolvedValue(mockStream),
      }),
    } as unknown as Docker;

    await handleLogs(mockDocker, 'connector', {
      lines: 50,
      json: false,
      jsonCompact: false,
      docker: mockDocker,
    });

    expect(listMock).toHaveBeenCalled();
    expect(getStderr()).not.toContain('is not running');
  });
});

// ── handlePeerDetail ─────────────────────────────────────────────────────────────

describe('handlePeerDetail', () => {
  describe('human mode', () => {
    it('prints peer header and ILP address section', async () => {
      const client = makeMockClient({});
      await handlePeerDetail(client, 'town', {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStdout()).toContain('Peer: town');
      expect(getStdout()).toContain('g.toon.town');
      expect(getStdout()).toContain('Routes: 3');
    });

    it('prints connected status', async () => {
      const client = makeMockClient({});
      await handlePeerDetail(client, 'town', {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStdout()).toContain('Connected: yes');
    });

    it('prints earnings per asset', async () => {
      const client = makeMockClient({});
      await handlePeerDetail(client, 'town', {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStdout()).toContain('USDC');
      expect(getStdout()).toContain('received 1000');
    });

    it('prints unknown-peer error and sets exitCode=1 when peer not found', async () => {
      const client = makeMockClient({
        getPeers: vi.fn().mockResolvedValue([]),
      });
      await handlePeerDetail(client, 'unknown-peer-id', {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStderr()).toContain('Unknown peer "unknown-peer-id"');
      expect(process.exitCode).toBe(1);
    });

    it('shows degraded earnings section when earnings endpoint returns 503', async () => {
      const client = makeMockClient({
        getEarnings: vi
          .fn()
          .mockRejectedValue(new Error('503 Service Unavailable')),
        getChannels: vi.fn().mockResolvedValue([]),
      });
      await handlePeerDetail(client, 'town', {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStdout()).toContain('earnings endpoint unavailable');
      expect(process.exitCode).toBeUndefined();
    });

    it('shows (no channels open) when channels are empty', async () => {
      const client = makeMockClient({
        getChannels: vi.fn().mockResolvedValue([]),
      });
      await handlePeerDetail(client, 'town', {
        json: false,
        jsonCompact: false,
        now: NOW,
      });
      expect(getStdout()).toContain('no channels open');
    });
  });

  describe('json mode', () => {
    it('emits { peer, earnings, channels } object', async () => {
      const client = makeMockClient({
        getChannels: vi.fn().mockResolvedValue([CHANNEL_1]),
      });
      await handlePeerDetail(client, 'town', {
        json: true,
        jsonCompact: false,
        now: NOW,
      });
      const parsed = JSON.parse(getStdout()) as {
        peer: PeerStatus;
        earnings: PeerEarnings | null;
        channels: ChannelSummary[];
      };
      expect(parsed.peer.id).toBe('town');
      expect(typeof parsed.earnings).toBe('object');
      expect(Array.isArray(parsed.channels)).toBe(true);
    });

    it('emits error envelope with code=unknown-peer for missing peer', async () => {
      const client = makeMockClient({
        getPeers: vi.fn().mockResolvedValue([]),
      });
      await handlePeerDetail(client, 'ghost', {
        json: true,
        jsonCompact: false,
        now: NOW,
      });
      const parsed = JSON.parse(getStdout()) as { code: string };
      expect(parsed.code).toBe('unknown-peer');
      expect(process.exitCode).toBe(1);
    });

    it('earnings is null when earnings endpoint fails', async () => {
      const client = makeMockClient({
        getEarnings: vi.fn().mockRejectedValue(new Error('503')),
        getChannels: vi.fn().mockResolvedValue([]),
      });
      await handlePeerDetail(client, 'town', {
        json: true,
        jsonCompact: false,
        now: NOW,
      });
      const parsed = JSON.parse(getStdout()) as { earnings: null };
      expect(parsed.earnings).toBeNull();
    });
  });
});

// ── handleHealth ─────────────────────────────────────────────────────────────────

const HEALTHY_API_RESPONSE = {
  status: 'healthy',
  uptime: 3600,
  startedAt: '2026-05-14T08:00:00.000Z',
  version: '0.1.0-rc5',
};

describe('handleHealth', () => {
  describe('human mode', () => {
    it('prints each probe source and Overall status', async () => {
      const client = makeMockClient({});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => HEALTHY_API_RESPONSE,
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [] }) });

      await handleHealth(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
        apiUrl: 'http://127.0.0.1:28090',
        fetch: fetchMock,
        adminClient: client,
      });

      expect(getStdout()).toContain('connector');
      expect(getStdout()).toContain('api');
      expect(getStdout()).toContain('anyone-hostname');
      expect(getStdout()).toContain('Overall:');
    });

    it('prints Overall: healthy when all probes pass', async () => {
      const client = makeMockClient({});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => HEALTHY_API_RESPONSE,
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [] }) });

      await handleHealth(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
        apiUrl: 'http://127.0.0.1:28090',
        fetch: fetchMock,
        adminClient: client,
      });

      expect(getStdout()).toContain('Overall: healthy');
      expect(process.exitCode).toBeUndefined();
    });

    it('sets exitCode=1 when connector is unreachable (unhealthy overall)', async () => {
      const client = makeMockClient({
        pingAdminLive: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        getHsHostname: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      });
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [] }) });

      await handleHealth(client, {
        json: false,
        jsonCompact: false,
        now: NOW,
        apiUrl: 'http://127.0.0.1:28090',
        fetch: fetchMock,
        adminClient: client,
      });

      expect(process.exitCode).toBe(1);
    });
  });

  describe('json mode', () => {
    it('emits { overall, probes } JSON object', async () => {
      const client = makeMockClient({});
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => HEALTHY_API_RESPONSE,
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [] }) });

      await handleHealth(client, {
        json: true,
        jsonCompact: false,
        now: NOW,
        apiUrl: 'http://127.0.0.1:28090',
        fetch: fetchMock,
        adminClient: client,
      });

      const parsed = JSON.parse(getStdout()) as {
        overall: string;
        probes: unknown[];
      };
      expect(typeof parsed.overall).toBe('string');
      expect(Array.isArray(parsed.probes)).toBe(true);
      expect(parsed.probes.length).toBeGreaterThanOrEqual(2);
    });

    it('overall=degraded and exit 0 when .anyone hostname is still starting', async () => {
      const client = makeMockClient({
        getHsHostname: vi
          .fn()
          .mockResolvedValue({ hostname: null, publishedAt: null }),
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => HEALTHY_API_RESPONSE,
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [] }) });

      await handleHealth(client, {
        json: true,
        jsonCompact: false,
        now: NOW,
        apiUrl: 'http://127.0.0.1:28090',
        fetch: fetchMock,
        adminClient: client,
      });

      const parsed = JSON.parse(getStdout()) as { overall: string };
      expect(parsed.overall).toBe('degraded');
      expect(process.exitCode).toBeUndefined();
    });

    it('.anyone probe shows n/a when anon is disabled', async () => {
      const client = makeMockClient({
        getHsHostname: vi
          .fn()
          .mockRejectedValue(
            new Error('connector is anon-disabled (HTTP 503)')
          ),
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => HEALTHY_API_RESPONSE,
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [] }) });

      await handleHealth(client, {
        json: true,
        jsonCompact: false,
        now: NOW,
        apiUrl: 'http://127.0.0.1:28090',
        fetch: fetchMock,
        adminClient: client,
      });

      const parsed = JSON.parse(getStdout()) as {
        probes: { source: string; status: string }[];
      };
      const anyoneProbe = parsed.probes.find(
        (p) => p.source === 'anyone-hostname'
      );
      expect(anyoneProbe?.status).toBe('n/a');
    });
  });
});
