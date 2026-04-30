/**
 * Node routes: GET /nodes, GET /nodes/:type, GET /nodes/:type/packets/timeseries,
 * GET /nodes/:type/bandwidth
 */

import type { FastifyInstance } from 'fastify';
import type {
  ApiDeps,
  NodeInfo,
  MetricsPayload,
  BandwidthPayload,
  PacketTimeseriesPayload,
  TimeseriesBucket,
} from '../types.js';
import type { NodeType, NodeState } from '../types.js';
import { CONTAINER_PREFIX } from '../../constants.js';

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

    const sinceMs = since ? new Date(since).getTime() : Date.now() - 24 * 60 * 60 * 1000;
    if (isNaN(sinceMs)) {
      return reply.status(400).send({ error: 'invalid_since', message: 'since must be ISO 8601' });
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
        bucket === 'minute' ? 60_000 :
        bucket === 'day'    ? 24 * 60 * 60_000 :
        /* hour */            60 * 60_000;

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
          message: 'Connector image does not expose GET /packets. See CONNECTOR_MIGRATION.md §getPacketLog.',
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
}
