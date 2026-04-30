/**
 * WebSocket metrics route: WS /metrics
 *
 * Supports an optional `?subscribe=...` query parameter for relay-event subscriptions.
 * Format: `?subscribe=relayEvents:<nodeId>,relayEvents:<nodeId2>,...`
 * For each `relayEvents:<nodeId>` subscription, the server opens an upstream WebSocket
 * to the Town container's relay and forwards Nostr events to the client.
 */

import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { decode as decodeToon } from '@toon-format/toon';
import type { ApiDeps, WsMessage, NostrEventPayload } from '../types.js';

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
 * Parse `relayEvents:<nodeId>` subscription tokens from the `?subscribe=` query param.
 * Returns an array of nodeIds to subscribe to.
 */
function parseRelayEventSubscriptions(queryString: string): string[] {
  if (!queryString) return [];
  const params = new URLSearchParams(queryString);
  const subscribeParam = params.get('subscribe');
  if (!subscribeParam) return [];

  const nodeIds: string[] = [];
  for (const token of subscribeParam.split(',')) {
    const trimmed = token.trim();
    if (trimmed.startsWith('relayEvents:')) {
      const nodeId = trimmed.slice('relayEvents:'.length);
      if (nodeId) nodeIds.push(nodeId);
    }
  }
  return nodeIds;
}

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

    // Per-client upstream relay WebSocket connections: nodeId → WebSocket
    const upstreamSockets = new Map<string, WebSocket>();

    // ── relayEvents subscriptions ─────────────────────────────────────────────
    const rawQuery = request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : '';
    const relayNodeIds = parseRelayEventSubscriptions(rawQuery);

    // Open upstream WS for each subscribed nodeId (async, non-blocking)
    if (relayNodeIds.length > 0) {
      void (async () => {
        for (const nodeId of relayNodeIds) {
          if (socket.readyState !== WebSocket.OPEN) break;
          try {
            const relayUrl = await deps.orchestrator.getNodeRelayEndpoint(nodeId);
            const upstream = new WebSocket(relayUrl);
            upstreamSockets.set(nodeId, upstream);

            // Track the latest event timestamp for incremental polling.
            // Start 60 s back to show recent events on connect.
            let sinceTs = Math.floor(Date.now() / 1000) - 60;
            // Dedup events already forwarded in this session. Capped to prevent
            // unbounded memory growth on long-lived connections to busy relays.
            const MAX_SEEN_IDS = 10_000;
            const seenEventIds = new Set<string>();
            const subId = `live-${nodeId}`;

            function sendReq() {
              if (upstream.readyState === WebSocket.OPEN) {
                upstream.send(JSON.stringify(['REQ', subId, {
                  kinds: [0, 1, 6, 7, 9735],
                  since: sinceTs,
                }]));
              }
            }

            // Subscribe for live events once the upstream relay accepts the connection.
            // Also poll every 5 s via re-REQ so events stored via /handle-packet (which
            // currently do not trigger broadcastEvent in older relay builds) are surfaced.
            let pollTimer: NodeJS.Timeout | null = null;
            upstream.on('open', () => {
              sendReq();
              pollTimer = setInterval(sendReq, 5_000);
            });

            upstream.on('message', (data: Buffer | string) => {
              if (socket.readyState !== WebSocket.OPEN) return;
              try {
                const msg = JSON.parse(data.toString()) as unknown;
                let payload: NostrEventPayload | undefined;

                if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[2]) {
                  // Real relay: NIP-01 ["EVENT", sub_id, toon_string]
                  payload = decodeToon(msg[2] as string) as unknown as NostrEventPayload;
                } else if (msg !== null && typeof msg === 'object' && !Array.isArray(msg)) {
                  // Test stub: raw JSON event object
                  payload = msg as NostrEventPayload;
                }

                if (payload) {
                  const eventId = (payload as { id?: string }).id ?? '';
                  if (eventId && seenEventIds.has(eventId)) return; // dedup
                  if (eventId) {
                    seenEventIds.add(eventId);
                    if (seenEventIds.size > MAX_SEEN_IDS) {
                      const [oldest] = seenEventIds;
                      seenEventIds.delete(oldest);
                    }
                  }
                  // Advance sinceTs so the next poll only fetches newer events.
                  const createdAt = (payload as { created_at?: number }).created_at;
                  if (typeof createdAt === 'number' && createdAt >= sinceTs) {
                    sinceTs = createdAt;
                  }
                  addToBuffer({
                    type: 'relayEvents',
                    nodeId,
                    payload,
                    ts: Date.now(),
                  });
                }
              } catch {
                // Malformed or non-event message from upstream relay — skip
              }
            });

            upstream.on('error', (err) => {
              logger.warn({ err, nodeId }, 'Upstream relay WS error');
            });

            upstream.on('close', () => {
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
              upstreamSockets.delete(nodeId);
              // Notify the dashboard client so it can surface the AC-7 error UI
              // instead of silently showing an empty "No events yet" feed.
              addToBuffer({
                type: 'relayEventsStatus',
                nodeId,
                connected: false,
                ts: Date.now(),
              });
            });
          } catch (err) {
            logger.warn({ err, nodeId }, 'Failed to open upstream relay WS');
          }
        }
      })();
    }

    // ── Metrics poll ──────────────────────────────────────────────────────────
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

    // ── Container state event listeners ───────────────────────────────────────

    const onContainerState = (data: { name: string; state: string }) => {
      addToBuffer({
        type: 'nodeState',
        payload: data,
        ts: Date.now(),
      });
    };
    deps.orchestrator.on('containerState', onContainerState);

    // Pull progress events
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

    // Connector restart events (AC-12 in story 21.10)
    const onConnectorRestarting = () => {
      addToBuffer({
        type: 'connectorRestarting',
        ts: Date.now(),
      });
    };
    deps.orchestrator.on('connectorRestarting', onConnectorRestarting);

    const onConnectorRestarted = () => {
      addToBuffer({
        type: 'connectorRestarted',
        ts: Date.now(),
      });
      // Also emit legacy nodeState for backward compat with older clients
      addToBuffer({
        type: 'nodeState',
        payload: { name: 'connector', state: 'restarted' },
        ts: Date.now(),
      });
    };
    deps.orchestrator.on('connectorRestarted', onConnectorRestarted);

    // ── Heartbeat ─────────────────────────────────────────────────────────────

    const heartbeatTimer = setInterval(() => {
      addToBuffer({
        type: 'heartbeat',
        ts: Date.now(),
      });
    }, HEARTBEAT_INTERVAL_MS);
    timers.push(heartbeatTimer);

    // ── Flush ─────────────────────────────────────────────────────────────────

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

    // ── Incoming messages (unsubscribe) ──────────────────────────────────────

    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string; nodeId?: string };
        if (msg.type === 'unsubscribe' && typeof msg.nodeId === 'string') {
          const upstream = upstreamSockets.get(msg.nodeId);
          if (upstream) {
            try { upstream.close(); } catch { /* best-effort */ }
            upstreamSockets.delete(msg.nodeId);
          }
        }
      } catch {
        // Malformed control message — ignore
      }
    });

    // ── Cleanup on disconnect ─────────────────────────────────────────────────

    socket.on('close', () => {
      logger.info({ client: request.ip }, 'WebSocket client disconnected');

      // Remove from tracking set
      openWebSockets.delete(socket);

      // Clear all timers
      for (const timer of timers) {
        clearInterval(timer);
      }

      // Remove orchestrator event listeners
      deps.orchestrator.off('containerState', onContainerState);
      deps.orchestrator.off('pullProgress', onPullProgress);
      deps.orchestrator.off('connectorRestarting', onConnectorRestarting);
      deps.orchestrator.off('connectorRestarted', onConnectorRestarted);

      // Close all upstream relay WebSocket connections
      for (const [, ws] of upstreamSockets) {
        try {
          ws.close();
        } catch {
          // best-effort
        }
      }
      upstreamSockets.clear();
    });

    // Handle socket errors
    socket.on('error', (error) => {
      logger.error({ err: error, client: request.ip }, 'WebSocket error');
    });
  });
}
