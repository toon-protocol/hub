/**
 * Node routes: GET /nodes, GET /nodes/:type, GET /nodes/:type/packets/timeseries,
 * GET /nodes/:type/bandwidth,
 * GET /nodes/:nodeId/health, GET /nodes/:nodeId/swaps/recent,
 * GET /nodes/:nodeId/deposit-addresses.
 *
 * `:type` routes are scoped per node kind ('town' | 'mill' | 'dvm').
 * `:nodeId` routes are scoped per running instance and accept either a
 * container name (e.g. 'dev-mill-01') or a type-level placeholder
 * ('mill' when no instance has started yet).
 */

import type { FastifyInstance } from 'fastify';
import type {
  ApiDeps,
  NodeInfo,
  MetricsPayload,
  BandwidthPayload,
  PacketTimeseriesPayload,
  TimeseriesBucket,
  NodeHealthPayload,
  MillSwapsRecentPayload,
  JobsRecentPayload,
  DepositAddressesPayload,
  DvmHealthResponse,
} from '../types.js';
import type { NodeType, NodeState } from '../types.js';
import { CONTAINER_PREFIX } from '../../constants.js';

/** Cache entry for health proxy responses */
interface HealthCacheEntry {
  payload: NodeHealthPayload;
  cachedAt: number;
}

const HEALTH_CACHE_TTL_MS = 2_000;

/**
 * Feature-detect the event `kind` from a connector packet log entry. The
 * connector contract's `PacketLogEntry` does not yet expose a `kind` field
 * (see `@toon-protocol/sdk` CONNECTOR_MIGRATION.md "Hub-Side
 * Contract"); when absent, packets group under bucket 0 ("unattributed")
 * so operators can see the shortfall instead of silent data loss.
 */
export function extractKindFromPacketEntry(entry: unknown): number {
  const kind = (entry as { kind?: unknown } | null)?.kind;
  return typeof kind === 'number' && Number.isFinite(kind) ? kind : 0;
}

/** Map raw Docker container state to the API's NodeState enum. */
function mapDockerState(raw: string | undefined): NodeState {
  switch (raw) {
    case 'running':
      return 'running';
    case 'exited':
    case 'stopped':
    case 'created':
    case 'paused':
      return 'stopped';
    case undefined:
      return 'not-created';
    default:
      // 'restarting', 'removing', 'dead' → error
      return 'error';
  }
}

/** Build the mutable fee-field subset of a node's config, typed per node kind. */
function pickMutableFees(
  type: NodeType,
  nodeConfig: {
    enabled: boolean;
    feePerEvent?: number;
    feeBasisPoints?: number;
    feePerJob?: number;
  }
): {
  enabled: boolean;
  feePerEvent?: number;
  feeBasisPoints?: number;
  feePerJob?: number;
} {
  switch (type) {
    case 'town':
      return {
        enabled: nodeConfig.enabled,
        feePerEvent: nodeConfig.feePerEvent,
      };
    case 'mill':
      return {
        enabled: nodeConfig.enabled,
        feeBasisPoints: nodeConfig.feeBasisPoints,
      };
    case 'dvm':
      return { enabled: nodeConfig.enabled, feePerJob: nodeConfig.feePerJob };
  }
}

/** Guard an ISO-8601 StartedAt and return uptime in seconds, or null if implausible. */
function computeUptimeSeconds(
  startedAt: string | undefined,
  state: NodeState
): number | null {
  if (state !== 'running' || !startedAt) return null;
  const started = new Date(startedAt).getTime();
  if (isNaN(started) || started <= 0) return null;
  const now = Date.now();
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  if (started > now || now - started >= ONE_YEAR_MS) return null;
  return Math.floor((now - started) / 1000);
}

/**
 * Register node routes.
 */
export function registerNodeRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const healthCache = new Map<string, HealthCacheEntry>();
  // GET /nodes - list all node types (multi-instance aware)
  app.get('/nodes', async (_request, _reply) => {
    const status = await deps.orchestrator.status();
    const nodes: NodeInfo[] = [];

    for (const type of ['town', 'mill', 'dvm'] as const) {
      const nodeConfig = deps.config.nodes[type];
      if (!nodeConfig) continue;

      const instances = status.filter((s) => s.type === type);

      if (instances.length === 0) {
        nodes.push({
          id: type,
          type,
          enabled: nodeConfig.enabled,
          state: 'not-created',
          uptimeSeconds: null,
          image: nodeConfig.image ?? `toon:${type}`,
        });
        continue;
      }

      for (const entry of instances) {
        const state = mapDockerState(entry.state);
        const uptimeSeconds = computeUptimeSeconds(entry.startedAt, state);
        nodes.push({
          id: entry.name, // "town" for single-instance, "dev-town-01" for multi
          type,
          enabled: nodeConfig.enabled,
          state,
          uptimeSeconds,
          image: nodeConfig.image ?? `toon:${type}`,
        });
      }
    }

    return nodes;
  });

  // GET /nodes/:type - get single node detail
  app.get<{ Params: { type: string } }>(
    '/nodes/:type',
    async (request, reply) => {
      const { type } = request.params;

      // Validate type - return 404 for unknown types (for AC #9)
      if (type !== 'town' && type !== 'mill' && type !== 'dvm') {
        return reply.status(404).send({
          error: 'unknown_node_type',
          type,
        });
      }

      const nodeConfig = deps.config.nodes[type as NodeType];
      if (!nodeConfig) {
        return reply.status(404).send({
          error: 'unknown_node_type',
          type,
        });
      }

      // Get status from orchestrator (use first matching instance for single-type endpoint)
      const status = await deps.orchestrator.status();
      const statusEntry = status.find((s) => s.type === type);
      const state: NodeState = statusEntry
        ? mapDockerState(statusEntry.state)
        : 'not-created';
      const uptimeSeconds = computeUptimeSeconds(statusEntry?.startedAt, state);

      // Get metrics from connector admin (degraded state on failure).
      // ConnectorAdminClient.getMetrics() returns the connector's
      // /admin/metrics.json shape verbatim — aggregate counters live under
      // `aggregate`, per-peer entries under `peers`. Narrowed MetricsPayload
      // here surfaces the aggregate rollup; per-peer breakdowns are available
      // to consumers that need them via metricsRes.peers.
      let metrics: MetricsPayload | null = null;
      try {
        const metricsRes = await deps.connectorAdmin.getMetrics();
        if (metricsRes) {
          metrics = {
            packetsForwarded: metricsRes.aggregate.packetsForwarded,
            packetsRejected: metricsRes.aggregate.packetsRejected,
            bytesSent: metricsRes.aggregate.bytesSent,
            attribution: 'aggregate',
            available: true,
          };
        }
      } catch {
        // Connector down - return degraded state
        metrics = {
          packetsForwarded: 0,
          packetsRejected: 0,
          bytesSent: 0,
          attribution: 'aggregate',
          available: false,
        };
      }

      // Build config subset (mutable fields) — per-type, typed safely
      const config = pickMutableFees(type as NodeType, nodeConfig);

      return {
        id: type,
        type,
        enabled: nodeConfig.enabled,
        state,
        uptimeSeconds,
        image: nodeConfig.image ?? `toon:${type}`,
        config,
        metrics,
      };
    }
  );

  // ── GET /nodes/:type/packets/timeseries ────────────────────────────────────

  app.get<{
    Params: { type: string };
    Querystring: { bucket?: string; since?: string };
  }>('/nodes/:type/packets/timeseries', async (request, reply) => {
    const { type } = request.params;
    const { bucket = 'hour', since } = request.query;

    if (type !== 'town' && type !== 'mill' && type !== 'dvm') {
      return reply.status(404).send({ error: 'unknown_node_type', type });
    }

    const supportedBuckets = ['hour', 'day', 'minute'];
    if (!supportedBuckets.includes(bucket)) {
      return reply.status(400).send({
        error: 'unsupported_bucket',
        message: `bucket must be one of: ${supportedBuckets.join(', ')}`,
      });
    }

    const sinceMs = since
      ? new Date(since).getTime()
      : Date.now() - 24 * 60 * 60 * 1000;
    if (isNaN(sinceMs)) {
      return reply
        .status(400)
        .send({ error: 'invalid_since', message: 'since must be ISO 8601' });
    }

    try {
      // Resolve the node's ILP address from the connector's peer roster so the
      // packet log is scoped to this node type only (AC-3 / Task 2.3).
      // Falls through without filter if peers are unavailable.
      let ilpAddress: string | undefined;
      try {
        const peers = await deps.connectorAdmin.getPeers();
        const peer = peers.find((p) => p.id === type);
        ilpAddress = peer?.ilpAddresses[0];
      } catch {
        // Connector peer list unavailable — return unfiltered data as fallback
      }

      const packets = await deps.connectorAdmin.getPacketLog({
        ilpAddress,
        since: sinceMs,
        limit: 10_000,
      });

      // Bucket the packet log by time
      const bucketMs =
        bucket === 'minute'
          ? 60_000
          : bucket === 'day'
            ? 24 * 60 * 60_000
            : /* hour */ 60 * 60_000;

      const countsMap = new Map<number, number>();
      for (const entry of packets) {
        const bucketTs = Math.floor(entry.ts / bucketMs) * bucketMs;
        countsMap.set(bucketTs, (countsMap.get(bucketTs) ?? 0) + 1);
      }

      const buckets: TimeseriesBucket[] = Array.from(countsMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([ts, count]) => ({ ts, count }));

      const payload: PacketTimeseriesPayload = { buckets };
      return payload;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ConnectorEndpointNotFound') {
        return reply.status(503).send({
          error: 'connector_endpoint_not_found',
          message:
            'Connector image does not expose GET /packets. See CONNECTOR_MIGRATION.md §getPacketLog.',
        });
      }
      // Connector down or other error
      return reply.status(503).send({
        error: 'connector_unavailable',
        message: 'Could not reach connector admin API',
      });
    }
  });

  // ── GET /nodes/:type/bandwidth ─────────────────────────────────────────────

  app.get<{ Params: { type: string } }>(
    '/nodes/:type/bandwidth',
    async (request, reply) => {
      const { type } = request.params;

      if (type !== 'town' && type !== 'mill' && type !== 'dvm') {
        return reply.status(404).send({ error: 'unknown_node_type', type });
      }

      const containerName = `${CONTAINER_PREFIX}${type}`;
      const stats = await deps.orchestrator.getContainerStats(containerName);

      if (stats === null) {
        return null;
      }

      const payload: BandwidthPayload = {
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
        sampleAt: stats.sampleAt,
      };
      return payload;
    }
  );

  // ── per-instance node resolution helper ───────────────────────────────────

  async function resolveNodeId(
    nodeId: string
  ): Promise<{ type: NodeType; instanceName: string } | null> {
    const status = await deps.orchestrator.status();
    const instance = status.find((s) => s.name === nodeId);
    if (instance) {
      return { type: instance.type as NodeType, instanceName: instance.name };
    }
    if (nodeId === 'town' || nodeId === 'mill' || nodeId === 'dvm') {
      return { type: nodeId, instanceName: nodeId };
    }
    return null;
  }

  // ── GET /nodes/:nodeId/health ──────────────────────────────────────────────

  app.get<{ Params: { nodeId: string } }>(
    '/nodes/:nodeId/health',
    async (request, reply) => {
      const { nodeId } = request.params;

      // Skip the type-level routes that share the prefix.
      if (nodeId === 'packets' || nodeId === 'bandwidth') {
        return reply.status(404).send({ error: 'unknown_node', nodeId });
      }

      const resolved = await resolveNodeId(nodeId);
      if (!resolved) {
        return reply.status(404).send({ error: 'unknown_node', nodeId });
      }

      const cacheKey = resolved.instanceName;
      const cached = healthCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < HEALTH_CACHE_TTL_MS) {
        return cached.payload;
      }

      try {
        const endpoint = await deps.orchestrator.getNodeHealthEndpoint(
          resolved.instanceName,
          resolved.type
        );
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3_000);
        let res: Response;
        try {
          // nosemgrep: javascript.lang.security.detect-insecure-http -- Docker-internal, TLS unnecessary
          res = await fetch(`${endpoint}/health`, {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!res.ok) {
          return reply.status(503).send({ error: 'node_unreachable' });
        }
        const payload = (await res.json()) as NodeHealthPayload;
        healthCache.set(cacheKey, { payload, cachedAt: Date.now() });
        return payload;
      } catch {
        return reply.status(503).send({ error: 'node_unreachable' });
      }
    }
  );

  // ── GET /nodes/:nodeId/swaps/recent ───────────────────────────────────────

  app.get<{
    Params: { nodeId: string };
    Querystring: { windowSec?: string };
  }>('/nodes/:nodeId/swaps/recent', async (request, reply) => {
    const { nodeId } = request.params;

    const resolved = await resolveNodeId(nodeId);
    if (!resolved) {
      return reply.status(404).send({ error: 'unknown_node', nodeId });
    }
    if (resolved.type !== 'mill') {
      return reply.status(404).send({
        error: 'swaps_only_for_mill',
        message: 'swaps/recent is only available for mill instances',
      });
    }

    const rawWindowSec = request.query.windowSec;
    // Reject scientific notation and non-decimal strings before parseInt
    // silently truncates them ('1e10' → 1).
    if (rawWindowSec !== undefined && !/^\d+$/.test(rawWindowSec)) {
      return reply.status(400).send({
        error: 'invalid_window_sec',
        message: 'windowSec must be a non-negative integer (1–3600)',
      });
    }
    const windowSec =
      rawWindowSec !== undefined ? parseInt(rawWindowSec, 10) : 300;
    if (isNaN(windowSec) || windowSec < 1 || windowSec > 3600) {
      return reply.status(400).send({
        error: 'invalid_window_sec',
        message: 'windowSec must be 1–3600',
      });
    }

    // Resolve this instance's ILP address from connector peers.
    // If the peer is not registered yet, return an empty result rather than
    // an unfiltered packet log (which would include packets from every peer).
    let ilpAddress: string | undefined;
    try {
      const peers = await deps.connectorAdmin.getPeers();
      const peer = peers.find((p) => p.id === resolved.instanceName);
      ilpAddress = peer?.ilpAddresses[0];
    } catch {
      // Connector unavailable — handled in the next try block.
    }

    if (!ilpAddress) {
      const empty: MillSwapsRecentPayload = {
        count: 0,
        volume: '0',
        byPair: [],
      };
      return empty;
    }

    try {
      const packets = await deps.connectorAdmin.getPacketLog({
        ilpAddress,
        since: Date.now() - windowSec * 1_000,
        limit: 10_000,
      });

      const byPairMap = new Map<string, { count: number; volume: bigint }>();
      let totalVolume = 0n;

      for (const entry of packets) {
        totalVolume += BigInt(entry.amount ?? 0);
        const pairKey = `${entry.ilpAddressFrom ?? '?'}→${entry.ilpAddressTo ?? '?'}`;
        const existing = byPairMap.get(pairKey) ?? { count: 0, volume: 0n };
        byPairMap.set(pairKey, {
          count: existing.count + 1,
          volume: existing.volume + BigInt(entry.amount ?? 0),
        });
      }

      const byPair = Array.from(byPairMap.entries()).map(([pair, data]) => ({
        pair,
        count: data.count,
        volume: data.volume.toString(),
      }));

      const payload: MillSwapsRecentPayload = {
        count: packets.length,
        volume: totalVolume.toString(),
        byPair,
      };
      return payload;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ConnectorEndpointNotFound') {
        return reply.status(503).send({
          error: 'connector_endpoint_not_found',
          message:
            'Connector image does not expose GET /packets. See CONNECTOR_MIGRATION.md.',
        });
      }
      return reply.status(503).send({ error: 'connector_unavailable' });
    }
  });

  // ── GET /nodes/:nodeId/jobs/recent ────────────────────────────────────────
  // Returns DVM job throughput for the requested window (default 300 s).
  // byKind is sourced from the DVM container's health endpoint (counter-shim,
  // the canonical source since the connector PacketLogEntry has no kind field).
  // volume is sourced from the connector packet log (amount sum).

  app.get<{
    Params: { nodeId: string };
    Querystring: { windowSec?: string };
  }>('/nodes/:nodeId/jobs/recent', async (request, reply) => {
    const { nodeId } = request.params;

    const resolved = await resolveNodeId(nodeId);
    if (!resolved) {
      return reply.status(404).send({ error: 'unknown_node', nodeId });
    }
    if (resolved.type !== 'dvm') {
      return reply.status(404).send({
        error: 'jobs_only_for_dvm',
        message: 'jobs/recent is only available for dvm instances',
      });
    }

    const rawWindowSec = request.query.windowSec;
    if (rawWindowSec !== undefined && !/^\d+$/.test(rawWindowSec)) {
      return reply.status(400).send({
        error: 'invalid_window_sec',
        message: 'windowSec must be a non-negative integer (1–300)',
      });
    }
    const requestedWindowSec =
      rawWindowSec !== undefined ? parseInt(rawWindowSec, 10) : 300;
    // The DVM in-memory counter is fixed at a 5-minute (300 s) window,
    // so the byKind/byStatus/total fields can only honestly report the
    // last 300 s. Reject windows outside [1, 300] rather than silently
    // mixing windows across response fields.
    if (requestedWindowSec < 1 || requestedWindowSec > 300) {
      return reply.status(400).send({
        error: 'invalid_window_sec',
        message:
          'windowSec must be 1–300 (DVM counter window is fixed at 5 min)',
      });
    }
    const windowSec = requestedWindowSec;

    // Resolve ILP address from connector peers
    let ilpAddress: string | undefined;
    let connectorDown = false;
    try {
      const peers = await deps.connectorAdmin.getPeers();
      const peer = peers.find((p) => p.id === resolved.instanceName);
      ilpAddress = peer?.ilpAddresses[0];
    } catch {
      connectorDown = true;
    }

    if (connectorDown) {
      return reply.status(503).send({ error: 'connector_unavailable' });
    }

    // Fetch DVM health for byKind and byStatus (the canonical counter source)
    let dvmHealth: DvmHealthResponse | null = null;
    try {
      const cached = healthCache.get(resolved.instanceName);
      if (cached && Date.now() - cached.cachedAt < HEALTH_CACHE_TTL_MS) {
        dvmHealth = cached.payload as DvmHealthResponse;
      } else {
        const endpoint = await deps.orchestrator.getNodeHealthEndpoint(
          resolved.instanceName,
          'dvm'
        );
        // 3 s timeout mirrors the parallel /nodes/:nodeId/health route.
        // A hung DVM container otherwise blocks Fastify indefinitely.
        const healthController = new AbortController();
        const healthTimeout = setTimeout(() => healthController.abort(), 3_000);
        let healthRes: Response;
        try {
          // nosemgrep: javascript.lang.security.detect-insecure-http -- Docker-internal, TLS unnecessary
          healthRes = await fetch(`${endpoint}/health`, {
            signal: healthController.signal,
          });
        } finally {
          clearTimeout(healthTimeout);
        }
        if (healthRes.ok) {
          dvmHealth = (await healthRes.json()) as DvmHealthResponse;
          healthCache.set(resolved.instanceName, {
            payload: dvmHealth,
            cachedAt: Date.now(),
          });
        }
      }
    } catch {
      // Health fetch failed — degrade gracefully
    }

    const byStatus = dvmHealth?.jobsRecent?.byStatus ?? {
      processing: 0,
      success: 0,
      error: 0,
      partial: 0,
    };

    // Build byKind from DVM health counter (canonical) — group into JobsByKindEntry
    const byKindFromHealth = dvmHealth?.jobsRecent?.byKind ?? [];
    const byKindMap = new Map<number, { count: number; volume: bigint }>();
    for (const entry of byKindFromHealth) {
      byKindMap.set(entry.kind, { count: entry.count, volume: 0n });
    }

    if (!ilpAddress) {
      // ILP address unknown — return zero-volume result with health-sourced counters
      const payload: JobsRecentPayload = {
        count: dvmHealth?.jobsRecent?.total ?? 0,
        volume: '0',
        byKind: Array.from(byKindMap.entries()).map(([kind, d]) => ({
          kind,
          count: d.count,
          volume: '0',
        })),
        byStatus,
      };
      return payload;
    }

    try {
      const packets = await deps.connectorAdmin.getPacketLog({
        ilpAddress,
        since: Date.now() - windowSec * 1_000,
        limit: 10_000,
      });

      let totalVolume = 0n;
      for (const entry of packets) {
        totalVolume += BigInt(entry.amount ?? 0);
        // kind field: feature-detect — if absent, group under bucket 0 (unattributed)
        const kind = extractKindFromPacketEntry(entry);
        const existing = byKindMap.get(kind) ?? { count: 0, volume: 0n };
        // Only increment count from packet log if no DVM health data available;
        // prefer DVM counter for count, use packet log for volume only.
        byKindMap.set(kind, {
          count:
            byKindFromHealth.length > 0 ? existing.count : existing.count + 1,
          volume: existing.volume + BigInt(entry.amount ?? 0),
        });
      }

      const byKind = Array.from(byKindMap.entries()).map(([kind, d]) => ({
        kind,
        count: d.count,
        volume: d.volume.toString(),
      }));

      const payload: JobsRecentPayload = {
        count: dvmHealth?.jobsRecent?.total ?? packets.length,
        volume: totalVolume.toString(),
        byKind,
        byStatus,
      };
      return payload;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ConnectorEndpointNotFound') {
        return reply.status(503).send({
          error: 'connector_endpoint_not_found',
          message:
            'Connector image does not expose GET /packets. See CONNECTOR_MIGRATION.md.',
        });
      }
      return reply.status(503).send({ error: 'connector_unavailable' });
    }
  });

  // ── GET /nodes/:nodeId/deposit-addresses ──────────────────────────────────

  app.get<{ Params: { nodeId: string } }>(
    '/nodes/:nodeId/deposit-addresses',
    async (request, reply) => {
      const { nodeId } = request.params;

      const resolved = await resolveNodeId(nodeId);
      if (!resolved) {
        return reply.status(404).send({ error: 'unknown_node', nodeId });
      }

      let keys;
      try {
        keys = deps.wallet.getNodeKeys(resolved.type);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/not initialized/i.test(msg)) {
          return reply.status(503).send({ error: 'wallet_not_initialized' });
        }
        return reply.status(500).send({ error: 'wallet_error', message: msg });
      }

      const chains: DepositAddressesPayload['chains'] = [
        { family: 'evm', address: keys.evmAddress },
      ];

      if (resolved.type === 'mill') {
        if (keys.solanaAddress) {
          chains.push({ family: 'solana', address: keys.solanaAddress });
        }
        if (keys.minaAddress) {
          chains.push({ family: 'mina', address: keys.minaAddress });
        }
      }

      const payload: DepositAddressesPayload = { chains };
      return payload;
    }
  );
}
