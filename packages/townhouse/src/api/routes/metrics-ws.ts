/**
 * WebSocket metrics route: WS /metrics
 */

import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { ApiDeps, WsMessage } from '../types.js';

/** Maximum buffer size before dropping old messages */
const MAX_BUFFER_SIZE = 100;

/** Track open WebSocket connections for graceful shutdown (AC #10) */
const openWebSockets = new Set<WebSocket>();

/** Get the set of open WebSocket connections (for server.ts close()) */
export function getOpenWebSockets(): Set<WebSocket> {
  return openWebSockets;
}

/** Flush interval for message batching (ms) */
const FLUSH_INTERVAL_MS = 100;

/** Metrics poll interval (ms) */
const METRICS_POLL_INTERVAL_MS = 1000;

/** Heartbeat interval (ms) */
const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Register WebSocket metrics route.
 */
export function registerMetricsWsRoutes(
  app: FastifyInstance,
  deps: ApiDeps
): void {
  // Register websocket plugin handler
  app.get('/metrics', { websocket: true }, (socket, request) => {
    const logger = deps.logger ?? app.log;
    logger.info({ client: request.ip }, 'WebSocket client connected');

    // Track this connection for graceful shutdown
    openWebSockets.add(socket);

    // Per-socket message buffer
    const messageBuffer: WsMessage[] = [];

    // Track timers for cleanup
    const timers: NodeJS.Timeout[] = [];

    // Metrics poll timer (1s interval) — skip if previous poll is still pending
    let metricsPollPending = false;
    const metricsTimer = setInterval(async () => {
      if (metricsPollPending) {
        return; // Skip this poll, previous one still in flight
      }
      metricsPollPending = true;
      try {
        const metricsRes = await deps.connectorAdmin.getMetrics();
        if (metricsRes) {
          // ConnectorAdminClient.getMetrics() returns the connector's
          // /admin/metrics.json shape; aggregate counters live under `aggregate`.
          const payload = {
            packetsForwarded: metricsRes.aggregate.packetsForwarded,
            packetsRejected: metricsRes.aggregate.packetsRejected,
            bytesSent: metricsRes.aggregate.bytesSent,
            attribution: 'aggregate' as const,
            available: true,
          };
          addToBuffer({
            type: 'metrics',
            payload,
            ts: Date.now(),
          });
        }
      } catch {
        // Connector down or /metrics not available — add unavailable marker
        addToBuffer({
          type: 'metrics',
          payload: {
            packetsForwarded: 0,
            packetsRejected: 0,
            bytesSent: 0,
            attribution: 'aggregate',
            available: false,
          },
          ts: Date.now(),
        });
      } finally {
        metricsPollPending = false;
      }
    }, METRICS_POLL_INTERVAL_MS);
    timers.push(metricsTimer);

    // Container state event listener
    const onContainerState = (data: { name: string; state: string }) => {
      addToBuffer({
        type: 'nodeState',
        payload: data,
        ts: Date.now(),
      });
    };
    deps.orchestrator.on('containerState', onContainerState);

    // Pull progress events (AC #5, Task 5.2)
    const onPullProgress = (data: {
      image: string;
      status: string;
      progress?: string;
    }) => {
      addToBuffer({
        type: 'nodeState',
        payload: { name: `pull:${data.image}`, state: data.status },
        ts: Date.now(),
      });
    };
    deps.orchestrator.on('pullProgress', onPullProgress);

    // Connector restart events (AC #5, Task 5.2)
    const onConnectorRestarted = () => {
      addToBuffer({
        type: 'nodeState',
        payload: { name: 'connector', state: 'restarted' },
        ts: Date.now(),
      });
    };
    deps.orchestrator.on('connectorRestarted', onConnectorRestarted);

    // Heartbeat timer (15s interval)
    const heartbeatTimer = setInterval(() => {
      addToBuffer({
        type: 'heartbeat',
        ts: Date.now(),
      });
    }, HEARTBEAT_INTERVAL_MS);
    timers.push(heartbeatTimer);

    // Flush buffer on 100ms cadence with batching
    const flushTimer = setInterval(() => {
      flushBuffer(socket);
    }, FLUSH_INTERVAL_MS);
    timers.push(flushTimer);

    // Add message to buffer with backpressure handling
    function addToBuffer(message: WsMessage): void {
      messageBuffer.push(message);

      // If buffer exceeds max, drop oldest metrics (keep latest)
      if (messageBuffer.length > MAX_BUFFER_SIZE) {
        const idx = messageBuffer.findIndex((m) => m.type === 'metrics');
        if (idx >= 0) {
          messageBuffer.splice(idx, 1);
        } else {
          messageBuffer.shift();
        }
      }
    }

    // Flush buffer with batching logic
    function flushBuffer(_ws: WebSocket): void {
      if (messageBuffer.length === 0) {
        return;
      }

      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (messageBuffer.length === 1) {
        socket.send(JSON.stringify(messageBuffer[0]));
      } else {
        // Batch multiple messages
        const batch: WsMessage = {
          type: 'batch',
          messages: [...messageBuffer],
          ts: Date.now(),
        };
        socket.send(JSON.stringify(batch));
      }

      messageBuffer.length = 0;
    }

    // Handle socket close
    socket.on('close', () => {
      logger.info({ client: request.ip }, 'WebSocket client disconnected');

      // Remove from tracking set
      openWebSockets.delete(socket);

      // Clear all timers
      for (const timer of timers) {
        clearInterval(timer);
      }

      // Remove all event listeners
      deps.orchestrator.off('containerState', onContainerState);
      deps.orchestrator.off('pullProgress', onPullProgress);
      deps.orchestrator.off('connectorRestarted', onConnectorRestarted);
    });

    // Handle socket errors
    socket.on('error', (error) => {
      logger.error({ err: error, client: request.ip }, 'WebSocket error');
    });
  });
}
