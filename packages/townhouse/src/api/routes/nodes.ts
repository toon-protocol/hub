/**
 * Node routes: GET /nodes, GET /nodes/:type
 */

import type { FastifyInstance } from 'fastify';
import type { ApiDeps, NodeInfo, MetricsPayload } from '../types.js';
import type { NodeType, NodeState } from '../types.js';

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
  // GET /nodes - list all node types
  app.get('/nodes', async (_request, _reply) => {
    const status = await deps.orchestrator.status();
    const nodes: NodeInfo[] = [];

    for (const type of ['town', 'mill', 'dvm'] as const) {
      const nodeConfig = deps.config.nodes[type];
      if (!nodeConfig) continue;

      const statusEntry = status.find((s) => s.name === type);
      const state = statusEntry
        ? mapDockerState(statusEntry.state)
        : 'not-created';
      const uptimeSeconds = computeUptimeSeconds(statusEntry?.startedAt, state);

      nodes.push({
        type,
        enabled: nodeConfig.enabled,
        state,
        uptimeSeconds,
        image: nodeConfig.image ?? `toon:${type}`,
      });
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

      // Get status from orchestrator
      const status = await deps.orchestrator.status();
      const statusEntry = status.find((s) => s.name === type);
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
}
