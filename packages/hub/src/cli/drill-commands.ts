/**
 * Drill-subcommand handlers: channels, metrics (moved from cli.ts), logs, peer, health.
 *
 * Boundary: imports ONLY from ../connector/, ../docker/log-tail.js,
 * ../tui/format.js, ../constants.js, dockerode, and node:* stdlib.
 * No imports from ../api/, ../tui/components/, ../earnings/, or ../docker/orchestrator.js.
 */

import Docker from 'dockerode';
import { CONTAINER_PREFIX } from '../constants.js';
import { ConnectorAdminClient } from '../connector/admin-client.js';
import type {
  ChannelSummary,
  MetricsResponse,
  PeerStatus,
  PeerEarnings,
} from '../connector/types.js';
import {
  tailContainerLogs,
  serviceFromContainerName,
  LOG_SERVICES,
  type LogService,
} from '../docker/log-tail.js';
import { formatRelativeTime } from '../tui/format.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DrillOptions {
  json: boolean;
  jsonCompact: boolean;
  now?: Date;
  adminClient?: ConnectorAdminClient;
  apiUrl?: string;
  fetch?: typeof fetch;
  docker?: Docker;
}

export interface ProbeResult {
  source: string;
  status:
    | 'healthy'
    | 'unhealthy'
    | 'unreachable'
    | 'unknown'
    | 'starting'
    | 'n/a'
    | 'degraded';
  error?: string;
  uptime?: number;
  peersConnected?: number;
  totalPeers?: number;
  startedAt?: string;
  version?: string;
  hostname?: string;
  publishedAt?: string;
  message?: string;
}

// ── Help text constants ────────────────────────────────────────────────────────

export const CHANNELS_HELP = `  hub channels [--json] [-c <path>]                Show open payment channels`;
export const LOGS_HELP = `  hub logs <node-id> [--lines N] [--json] [-c <path>]   Tail logs for a node (Ctrl-C to stop)`;
export const PEER_HELP = `  hub peer <id> [--json] [-c <path>]               Show per-peer detail card`;
export const HEALTH_HELP = `  hub health [--json] [-c <path>]                  Probe apex/api/nodes/.anyone health`;

// ── Shared helpers ─────────────────────────────────────────────────────────────

function truncate16(s: string): string {
  return s.length > 16 ? s.slice(0, 16) + '…' : s;
}

function emitJson(payload: unknown, opts: { compact: boolean }): void {
  process.stdout.write(
    JSON.stringify(payload, null, opts.compact ? 0 : 2) + '\n'
  );
}

export function emitJsonError(
  message: string,
  code: string,
  opts: { compact: boolean }
): void {
  process.stdout.write(
    JSON.stringify({ error: message, code }, null, opts.compact ? 0 : 2) + '\n'
  );
  process.exitCode = 1;
}

// ── handleChannels ──────────────────────────────────────────────────────────────

export async function handleChannels(
  adminClient: ConnectorAdminClient,
  opts: DrillOptions
): Promise<void> {
  let channels: ChannelSummary[];
  try {
    channels = await adminClient.getChannels();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      emitJsonError(
        `Failed to fetch connector channels: ${msg}`,
        'unreachable',
        opts
      );
    } else {
      console.error(`Failed to fetch connector channels: ${msg}`);
      process.exitCode = 1;
    }
    return;
  }

  if (opts.json) {
    emitJson(channels, opts);
    return;
  }

  if (channels.length === 0) {
    console.log('No channels open');
    return;
  }

  const now = opts.now ?? new Date();
  const HEADERS = {
    channel: 'CHANNEL',
    peer: 'PEER',
    chain: 'CHAIN',
    status: 'STATUS',
    deposit: 'DEPOSIT',
    lastActivity: 'LAST ACTIVITY',
  };

  const rows = channels.map((c) => ({
    channel: truncate16(c.channelId),
    peer: truncate16(c.peerId),
    chain: c.chain,
    status: c.status,
    deposit: c.deposit,
    lastActivity: formatRelativeTime(c.lastActivity, now),
  }));

  const widths = {
    channel: Math.max(
      HEADERS.channel.length,
      ...rows.map((r) => r.channel.length)
    ),
    peer: Math.max(HEADERS.peer.length, ...rows.map((r) => r.peer.length)),
    chain: Math.max(HEADERS.chain.length, ...rows.map((r) => r.chain.length)),
    status: Math.max(
      HEADERS.status.length,
      ...rows.map((r) => r.status.length)
    ),
    deposit: Math.max(
      HEADERS.deposit.length,
      ...rows.map((r) => r.deposit.length)
    ),
    lastActivity: Math.max(
      HEADERS.lastActivity.length,
      ...rows.map((r) => r.lastActivity.length)
    ),
  };

  const header =
    HEADERS.channel.padEnd(widths.channel) +
    '  ' +
    HEADERS.peer.padEnd(widths.peer) +
    '  ' +
    HEADERS.chain.padEnd(widths.chain) +
    '  ' +
    HEADERS.status.padEnd(widths.status) +
    '  ' +
    HEADERS.deposit.padEnd(widths.deposit) +
    '  ' +
    HEADERS.lastActivity;
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of rows) {
    console.log(
      row.channel.padEnd(widths.channel) +
        '  ' +
        row.peer.padEnd(widths.peer) +
        '  ' +
        row.chain.padEnd(widths.chain) +
        '  ' +
        row.status.padEnd(widths.status) +
        '  ' +
        row.deposit.padEnd(widths.deposit) +
        '  ' +
        row.lastActivity
    );
  }
}

// ── handleMetrics (moved from cli.ts) ──────────────────────────────────────────

export async function handleMetrics(
  adminClient: ConnectorAdminClient,
  opts: DrillOptions
): Promise<void> {
  try {
    const metrics: MetricsResponse = await adminClient.getMetrics();
    const peers: PeerStatus[] = await adminClient.getPeers();

    const peerMetrics = new Map(metrics.peers.map((p) => [p.peerId, p]));

    if (opts.json) {
      emitJson(
        {
          aggregate: metrics.aggregate,
          peers: metrics.peers,
          peersDetail: peers,
          uptimeSeconds: metrics.uptimeSeconds,
          timestamp: metrics.timestamp,
        },
        opts
      );
      return;
    }

    const now = opts.now ?? new Date();

    console.log('Connector Metrics:');
    console.log('------------------');
    console.log(`  Packets forwarded: ${metrics.aggregate.packetsForwarded}`);
    console.log(`  Packets rejected:  ${metrics.aggregate.packetsRejected}`);
    console.log(`  Bytes sent:        ${metrics.aggregate.bytesSent}`);
    console.log('');
    console.log('Peers:');
    console.log('------');
    if (peers.length === 0) {
      console.log('  No peers connected');
    } else {
      const HEADERS = {
        peer: 'PEER',
        connected: 'STATUS',
        packetsForwarded: 'PACKETS FWD',
        packetsRejected: 'PACKETS REJ',
        bytesSent: 'BYTES SENT',
        lastPacket: 'LAST PACKET',
      };

      const rows = peers.map((peer) => {
        const pm = peerMetrics.get(peer.id);
        return {
          peer: peer.id,
          connected: peer.connected ? 'connected' : 'disconnected',
          packetsForwarded: String(pm?.packetsForwarded ?? 0),
          packetsRejected: String(pm?.packetsRejected ?? 0),
          bytesSent: String(pm?.bytesSent ?? 0),
          lastPacket:
            pm?.lastPacketAt != null
              ? formatRelativeTime(pm.lastPacketAt, now)
              : '—',
        };
      });

      const widths = {
        peer: Math.max(HEADERS.peer.length, ...rows.map((r) => r.peer.length)),
        connected: Math.max(
          HEADERS.connected.length,
          ...rows.map((r) => r.connected.length)
        ),
        packetsForwarded: Math.max(
          HEADERS.packetsForwarded.length,
          ...rows.map((r) => r.packetsForwarded.length)
        ),
        packetsRejected: Math.max(
          HEADERS.packetsRejected.length,
          ...rows.map((r) => r.packetsRejected.length)
        ),
        bytesSent: Math.max(
          HEADERS.bytesSent.length,
          ...rows.map((r) => r.bytesSent.length)
        ),
        lastPacket: Math.max(
          HEADERS.lastPacket.length,
          ...rows.map((r) => r.lastPacket.length)
        ),
      };

      const headerLine =
        `  ${HEADERS.peer.padEnd(widths.peer)}  ` +
        `${HEADERS.connected.padEnd(widths.connected)}  ` +
        `${HEADERS.packetsForwarded.padEnd(widths.packetsForwarded)}  ` +
        `${HEADERS.packetsRejected.padEnd(widths.packetsRejected)}  ` +
        `${HEADERS.bytesSent.padEnd(widths.bytesSent)}  ` +
        HEADERS.lastPacket;
      console.log(headerLine);
      console.log(`  ${'-'.repeat(headerLine.trim().length)}`);
      for (const row of rows) {
        console.log(
          `  ${row.peer.padEnd(widths.peer)}  ` +
            `${row.connected.padEnd(widths.connected)}  ` +
            `${row.packetsForwarded.padEnd(widths.packetsForwarded)}  ` +
            `${row.packetsRejected.padEnd(widths.packetsRejected)}  ` +
            `${row.bytesSent.padEnd(widths.bytesSent)}  ` +
            row.lastPacket
        );
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      emitJsonError(
        `Failed to fetch connector metrics: ${msg}`,
        'unreachable',
        opts
      );
    } else {
      console.error(`Failed to fetch connector metrics: ${msg}`);
      process.exitCode = 1;
    }
  }
}

// ── handleLogs ──────────────────────────────────────────────────────────────────

interface LogsOpts extends DrillOptions {
  lines: number;
}

async function resolveContainerName(
  docker: Docker,
  nodeId: string
): Promise<
  { name: string; service: LogService } | { error: string; code: string }
> {
  let containers: { Names: string[] }[];
  try {
    containers = (await docker.listContainers({ all: false })) as {
      Names: string[];
    }[];
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      error: `Cannot connect to docker daemon: ${msg}. Is docker running?`,
      code: 'docker-unavailable',
    };
  }

  const allNames = containers.flatMap((c) =>
    c.Names.map((n) => n.replace(/^\//, ''))
  );

  // Rule 1: verbatim match if starts with CONTAINER_PREFIX. Verify it actually
  // exists in the running container set so a typo like `hub-conector`
  // surfaces as `unknown-node` rather than bubbling out as a raw dockerode 404.
  if (nodeId.startsWith(CONTAINER_PREFIX)) {
    if (!allNames.includes(nodeId)) {
      return {
        error: `Node "${nodeId}" is not running (no container named "${nodeId}").`,
        code: 'unknown-node',
      };
    }
    const svc = serviceFromContainerName(nodeId) ?? ('town' as LogService);
    return { name: nodeId, service: svc };
  }

  // Rule 2: build candidate set
  const candidates: { name: string; service: LogService }[] = [];

  // Exact prefix match: hub-<nodeId>
  const exactName = `${CONTAINER_PREFIX}${nodeId}`;
  if (allNames.includes(exactName)) {
    const svc = serviceFromContainerName(exactName) ?? ('town' as LogService);
    candidates.push({ name: exactName, service: svc });
  }

  // Service-class match: nodeId is a bare service tag (e.g. 'town')
  const isService = (LOG_SERVICES as readonly string[]).includes(nodeId);
  if (isService) {
    for (const name of allNames) {
      if (name === exactName) continue; // already covered above
      const svc = serviceFromContainerName(name);
      if (svc === nodeId) {
        candidates.push({ name, service: svc });
      }
    }
  }

  const unique = candidates.filter(
    (c, i) => candidates.findIndex((x) => x.name === c.name) === i
  );

  if (unique.length === 0) {
    const resolvedName = `${CONTAINER_PREFIX}${nodeId}`;
    return {
      error: `Node "${nodeId}" is not running (no container named "${resolvedName}").`,
      code: 'unknown-node',
    };
  }

  if (unique.length > 1) {
    const names = unique.map((c) => c.name).join(', ');
    return {
      error: `Ambiguous node-id "${nodeId}" — matches multiple containers: ${names}. Use the full container name.`,
      code: 'ambiguous-node',
    };
  }

  const first = unique[0];
  if (first === undefined) {
    return {
      error: `Internal error resolving container name for "${nodeId}"`,
      code: 'internal',
    };
  }
  return first;
}

export async function handleLogs(
  docker: Docker,
  nodeId: string,
  opts: LogsOpts
): Promise<void> {
  const resolved = await resolveContainerName(docker, nodeId);
  if ('error' in resolved) {
    if (opts.json) {
      emitJsonError(resolved.error, resolved.code, opts);
    } else {
      process.stderr.write(resolved.error + '\n');
      process.exitCode = 1;
    }
    return;
  }

  const { name: containerName, service } = resolved;

  const controller = new AbortController();

  // SIGINT → abort the stream, drain stdout, then exit honoring exitCode.
  // Avoids both (a) a 50ms race that masked errors arriving in that window
  // and (b) buffer truncation on `hub logs --json | jq` pipelines.
  const sigintHandler = () => {
    controller.abort();
    process.stdout.write('', () => {
      process.exit(process.exitCode ?? 0);
    });
  };
  process.once('SIGINT', sigintHandler);

  try {
    const gen = tailContainerLogs(docker, containerName, service, {
      tail: opts.lines,
      signal: controller.signal,
    });

    for await (const evt of gen) {
      if (opts.json) {
        process.stdout.write(JSON.stringify(evt) + '\n');
      } else {
        process.stdout.write(
          `${evt.ts} [${evt.service}] ${evt.level}: ${evt.msg}\n`
        );
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const isDockerError =
      (msg.includes('ENOENT') && msg.includes('/var/run/docker.sock')) ||
      msg.includes('connect ENOENT') ||
      msg.includes('Cannot connect to the Docker daemon') ||
      (msg.includes('ECONNREFUSED') && msg.includes('docker'));
    if (isDockerError) {
      const errMsg = `Cannot connect to docker daemon: ${msg}. Is docker running?`;
      if (opts.json) {
        emitJsonError(errMsg, 'docker-unavailable', opts);
      } else {
        process.stderr.write(errMsg + '\n');
        process.exitCode = 1;
      }
    } else {
      const errMsg = `Log stream error for "${nodeId}": ${msg}`;
      if (opts.json) {
        emitJsonError(errMsg, 'internal', opts);
      } else {
        process.stderr.write(errMsg + '\n');
        process.exitCode = 1;
      }
    }
  } finally {
    process.off('SIGINT', sigintHandler);
  }
}

// ── handlePeerDetail ────────────────────────────────────────────────────────────

export async function handlePeerDetail(
  adminClient: ConnectorAdminClient,
  peerId: string,
  opts: DrillOptions
): Promise<void> {
  const now = opts.now ?? new Date();

  let peers: PeerStatus[];
  try {
    peers = await adminClient.getPeers();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      emitJsonError(msg, 'unreachable', opts);
    } else {
      process.stderr.write(`Failed to fetch peers: ${msg}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const peer = peers.find((p) => p.id === peerId);
  if (peer === undefined) {
    const errMsg = `Unknown peer "${peerId}". Use \`hub metrics\` to see registered peers.`;
    if (opts.json) {
      emitJsonError(errMsg, 'unknown-peer', opts);
    } else {
      process.stderr.write(errMsg + '\n');
      process.exitCode = 1;
    }
    return;
  }

  const [earningsRaw, channelsRaw] = await Promise.all([
    adminClient.getEarnings().catch(() => null),
    adminClient.getChannels().catch(() => null),
  ]);

  const peerEarnings: PeerEarnings | null =
    earningsRaw?.peers.find((p) => p.peerId === peerId) ?? null;
  const peerChannels: ChannelSummary[] =
    channelsRaw?.filter((c) => c.peerId === peerId) ?? [];

  if (opts.json) {
    // Per AC #8: earnings is null when byAsset[] is empty OR when the
    // earnings endpoint returned 503 (already nulled by the .catch above).
    const earningsForJson =
      peerEarnings && peerEarnings.byAsset.length > 0 ? peerEarnings : null;
    emitJson(
      {
        peer,
        earnings: earningsForJson,
        channels: peerChannels,
      },
      opts
    );
    return;
  }

  // Human mode — card display
  console.log(`Peer: ${peerId}`);
  console.log('');

  // ILP section
  if (peer.ilpAddresses.length === 0) {
    console.log('  (no ILP addresses registered)');
  } else {
    for (const addr of peer.ilpAddresses) {
      console.log(`  ${addr}`);
    }
  }
  console.log(`  Routes: ${peer.routeCount}`);
  console.log('');

  // Status section
  console.log(`Connected: ${peer.connected ? 'yes' : 'no'}`);
  console.log('');

  // Earnings section
  if (earningsRaw === null) {
    console.log('Earnings:');
    console.log(
      '  (earnings endpoint unavailable: connector is not settlement-configured)'
    );
  } else if (peerEarnings === null || peerEarnings.byAsset.length === 0) {
    console.log('Earnings:');
    console.log('  (no settlement activity yet)');
  } else {
    console.log('Earnings:');
    for (const asset of peerEarnings.byAsset) {
      const lastClaim = asset.lastClaimAt
        ? formatRelativeTime(asset.lastClaimAt, now)
        : 'never';
      console.log(
        `  ${asset.assetCode} · received ${asset.claimsReceivedTotal} · sent ${asset.claimsSentTotal} · net ${asset.netBalance} · last claim ${lastClaim}`
      );
    }
  }
  console.log('');

  // Channels section
  if (channelsRaw === null) {
    console.log('Channels:');
    console.log(
      '  (channels endpoint unavailable: connector is not settlement-configured)'
    );
  } else if (peerChannels.length === 0) {
    console.log('Channels:');
    console.log('  (no channels open)');
  } else {
    console.log('Channels:');
    for (const ch of peerChannels) {
      console.log(
        `  ${truncate16(ch.channelId)} · ${ch.chain} · ${ch.status} · deposit ${ch.deposit} · ${formatRelativeTime(ch.lastActivity, now)}`
      );
    }
  }
}

// ── handleHealth ────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 3000;

async function probeConnector(
  adminClient: ConnectorAdminClient
): Promise<ProbeResult> {
  try {
    // The hub host has only the admin port (9401) reachable, not the
    // connector's healthCheckPort (8080, internal). The admin server's /health
    // returns a slim shape that getHealth()'s validator rejects, so use
    // pingAdminLive() which only checks status code.
    await adminClient.pingAdminLive();
    return { source: 'connector', status: 'healthy' };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { source: 'connector', status: 'unreachable', error: msg };
  }
}

async function probeHostApi(
  apiUrl: string,
  fetchImpl: typeof fetch
): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        source: 'api',
        status: 'unhealthy',
        error: `HTTP ${response.status}`,
      };
    }
    const body = (await response.json()) as {
      status: string;
      uptime: number;
      startedAt: string;
      version: string;
    };
    return {
      source: 'api',
      status: 'healthy',
      uptime: body.uptime,
      startedAt: body.startedAt,
      version: body.version,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { source: 'api', status: 'unreachable', error: msg };
  }
}

async function probeNodes(
  apiUrl: string,
  fetchImpl: typeof fetch
): Promise<ProbeResult[]> {
  let nodes: { id: string }[];
  try {
    const resp = await fetchImpl(`${apiUrl}/api/nodes`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // Surface enumeration failure as a sentinel probe so it counts toward
      // computeOverall instead of silently disappearing as "no nodes".
      return [
        {
          source: 'nodes',
          status: 'unknown',
          error: `failed to enumerate nodes: HTTP ${resp.status}`,
        },
      ];
    }
    const body = (await resp.json()) as { nodes?: { id: string }[] };
    nodes = body.nodes ?? [];
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return [
      {
        source: 'nodes',
        status: 'unknown',
        error: `failed to enumerate nodes: ${msg}`,
      },
    ];
  }

  return Promise.all(
    nodes.map(async (node) => {
      try {
        const resp = await fetchImpl(
          `${apiUrl}/api/nodes/${encodeURIComponent(node.id)}/health`,
          {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          }
        );
        if (!resp.ok) {
          return {
            source: `node:${node.id}`,
            status: 'unhealthy' as const,
            error: `HTTP ${resp.status}`,
          };
        }
        const body = (await resp.json()) as { status?: string };
        const s = body.status;
        const status: ProbeResult['status'] =
          s === 'healthy'
            ? 'healthy'
            : s === 'unhealthy'
              ? 'unhealthy'
              : s === 'starting'
                ? 'starting'
                : s === 'degraded'
                  ? 'degraded'
                  : 'unknown';
        return { source: `node:${node.id}`, status };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          source: `node:${node.id}`,
          status: 'unreachable' as const,
          error: msg,
        };
      }
    })
  );
}

async function probeAnyone(
  adminClient: ConnectorAdminClient
): Promise<ProbeResult> {
  try {
    const result = await adminClient.getHsHostname();
    if (result.hostname !== null) {
      return {
        source: 'anyone-hostname',
        status: 'healthy',
        hostname: result.hostname,
        publishedAt: result.publishedAt ?? undefined,
      };
    }
    return {
      source: 'anyone-hostname',
      status: 'starting',
      message: 'anon publish pending',
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    // Accept both the bare prefix from getHsHostname() and any wrapped 503
    // (proxies/middleware that wrap the throw); avoids classifying "feature
    // off" as "unreachable" when the path picks up wrapping.
    if (
      msg.startsWith('connector is anon-disabled') ||
      /(?:^|:\s)503\b/.test(msg)
    ) {
      return {
        source: 'anyone-hostname',
        status: 'n/a',
        message: 'anon disabled in config',
      };
    }
    return { source: 'anyone-hostname', status: 'unreachable', error: msg };
  }
}

function computeOverall(
  probes: ProbeResult[]
): 'healthy' | 'degraded' | 'unhealthy' {
  const statuses = probes.map((p) => p.status);
  if (
    statuses.some(
      (s) => s === 'unhealthy' || s === 'unreachable' || s === 'unknown'
    )
  ) {
    return 'unhealthy';
  }
  // A per-node `degraded` probe must surface at the rollup; otherwise a
  // partially-degraded fleet rolls up to healthy.
  if (statuses.some((s) => s === 'starting' || s === 'degraded')) {
    return 'degraded';
  }
  return 'healthy';
}

export async function handleHealth(
  adminClient: ConnectorAdminClient,
  opts: DrillOptions
): Promise<void> {
  const apiUrl = opts.apiUrl ?? 'http://127.0.0.1:28090';
  const fetchImpl = opts.fetch ?? fetch;

  // Build a 3-second-timeout version of the admin client for connector probe.
  // Read baseUrl through the public getter so a future field rename surfaces
  // as a type error instead of a silent fallback to the hardcoded port.
  const healthClient =
    opts.adminClient ??
    new ConnectorAdminClient(adminClient.getBaseUrl(), PROBE_TIMEOUT_MS);

  const [connectorProbe, apiProbe, nodeProbes, anyoneProbe] = await Promise.all(
    [
      probeConnector(healthClient),
      probeHostApi(apiUrl, fetchImpl),
      probeNodes(apiUrl, fetchImpl),
      probeAnyone(healthClient),
    ]
  );

  const probes: ProbeResult[] = [
    connectorProbe,
    apiProbe,
    ...nodeProbes,
    anyoneProbe,
  ];
  const overall = computeOverall(probes);

  if (opts.json) {
    emitJson({ overall, probes }, opts);
  } else {
    for (const probe of probes) {
      console.log(`${probe.source}: ${probe.status}`);
      if (probe.error) console.log(`  error: ${probe.error}`);
      if (probe.uptime !== undefined) console.log(`  uptime: ${probe.uptime}s`);
      if (probe.peersConnected !== undefined)
        console.log(
          `  peers: ${probe.peersConnected}/${probe.totalPeers ?? '?'} connected`
        );
      if (probe.startedAt) console.log(`  startedAt: ${probe.startedAt}`);
      if (probe.version) console.log(`  version: ${probe.version}`);
      if (probe.hostname) console.log(`  hostname: ${probe.hostname}`);
      if (probe.publishedAt) console.log(`  publishedAt: ${probe.publishedAt}`);
      if (probe.message) console.log(`  ${probe.message}`);
    }
    console.log(`Overall: ${overall}`);
  }

  if (overall === 'unhealthy') {
    process.exitCode = 1;
  }
}

// ── dispatchDrillCommand ────────────────────────────────────────────────────────

/**
 * Dispatcher for the five drill verbs (channels, metrics, logs, peer, health).
 * Centralises arg parsing, --json error envelope routing, and admin-client
 * construction so cli.ts stays thin. Returns true when the command was handled.
 *
 * `--json` validation errors (missing positional, bad --lines, etc.) emit a
 * `{ error, code }` envelope to stdout instead of plain stderr text — the
 * universal contract the human-mode handlers already follow.
 */
export interface DispatchDrillDeps {
  adminUrl: string;
  apiUrl: string;
  values: Record<string, unknown>;
  positionals: string[];
  docker?: Docker;
}

export async function dispatchDrillCommand(
  command: string,
  deps: DispatchDrillDeps
): Promise<boolean> {
  const { values, positionals, adminUrl, apiUrl } = deps;
  const json = values['json'] === true;
  const jsonCompact = values['json-compact'] === true;
  const baseOpts = { json, jsonCompact };

  const usageError = (msg: string, code: string): void => {
    if (json) emitJsonError(msg, code, baseOpts);
    else {
      console.error(msg);
      process.exitCode = 1;
    }
  };

  switch (command) {
    case 'channels': {
      await handleChannels(new ConnectorAdminClient(adminUrl), baseOpts);
      return true;
    }
    case 'metrics': {
      await handleMetrics(new ConnectorAdminClient(adminUrl), baseOpts);
      return true;
    }
    case 'logs': {
      const nodeId = positionals[1];
      if (!nodeId) {
        usageError(
          'Usage: hub logs <node-id> [--lines N] [-f|--follow] [--json]',
          'usage'
        );
        return true;
      }
      const linesRaw = values['lines'] as string | undefined;
      // Strict integer parse: reject empty/whitespace, scientific notation, hex.
      // Number() coerces all of those silently; the help text says "an integer".
      let lines = 50;
      if (linesRaw !== undefined) {
        if (!/^\d+$/.test(linesRaw)) {
          usageError(
            '--lines must be an integer between 0 and 10000',
            'bad-flag'
          );
          return true;
        }
        lines = Number(linesRaw);
        if (lines < 0 || lines > 10000) {
          usageError(
            '--lines must be an integer between 0 and 10000',
            'bad-flag'
          );
          return true;
        }
      }
      const docker = deps.docker ?? new Docker();
      await handleLogs(docker, nodeId, { ...baseOpts, lines });
      return true;
    }
    case 'peer': {
      const peerId = positionals[1];
      if (!peerId) {
        usageError('Usage: hub peer <id> [--json]', 'usage');
        return true;
      }
      await handlePeerDetail(
        new ConnectorAdminClient(adminUrl),
        peerId,
        baseOpts
      );
      return true;
    }
    case 'health': {
      await handleHealth(new ConnectorAdminClient(adminUrl, PROBE_TIMEOUT_MS), {
        ...baseOpts,
        apiUrl,
      });
      return true;
    }
    default:
      return false;
  }
}
