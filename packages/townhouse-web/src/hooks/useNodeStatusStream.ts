import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeType, WsMessage, WsNodeStateMessage } from '@toon-protocol/townhouse';

export type StreamConnectionStatus = 'connecting' | 'open' | 'degraded' | 'closed';

export interface UseNodeStatusStreamResult {
  /**
   * Latest raw Docker state per node type (`town` | `mill` | `dvm`). Keys are
   * normalized from the WS server's `townhouse-{type}` container names, and
   * non-node names (`pull:*`, `connector`, `townhouse-connector`, …) are
   * filtered out.
   */
  statesByName: Partial<Record<NodeType, string>>;
  connectionStatus: StreamConnectionStatus;
  /**
   * Force a reconnect — clears any pending backoff, closes the active socket,
   * and immediately attempts a new connection. Useful for "Retry" affordances
   * that need to bring the live feed back at the same time as the REST view.
   */
  reconnect: () => void;
}

interface UseNodeStatusStreamOptions {
  /** Override the WebSocket URL (defaults to `/api/metrics` resolved against the current page origin). */
  url?: string;
  /** Inactivity threshold in ms before the connection is marked degraded. */
  heartbeatTimeoutMs?: number;
  /** Initial backoff in ms; doubles each retry up to `maxBackoffMs`. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

const NODE_TYPES = new Set<NodeType>(['town', 'mill', 'dvm']);
const CONTAINER_PREFIX = 'townhouse-';

/**
 * Map a WS-emitted container name to a known `NodeType`, or `null` if the name
 * doesn't refer to a node-type container. The orchestrator emits names like
 * `townhouse-town` / `townhouse-mill` / `townhouse-dvm` (production) or
 * `townhouse-connector` / `pull:<image>` (other namespaces) — only the first
 * three matter to this hook.
 */
function nameToNodeType(name: string): NodeType | null {
  const stripped = name.startsWith(CONTAINER_PREFIX)
    ? name.slice(CONTAINER_PREFIX.length)
    : name;
  return NODE_TYPES.has(stripped as NodeType) ? (stripped as NodeType) : null;
}

function defaultUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:9400/metrics';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/metrics`;
}

/**
 * Subscribe to `WS /api/metrics` and surface the latest per-node Docker state.
 *
 * Reconnect strategy:
 *   - If the socket closes or errors, schedule a reconnect with exponential
 *     backoff starting at `initialBackoffMs` and capped at `maxBackoffMs`.
 *   - On any message (including heartbeats), reset the backoff counter.
 *   - If no message arrives within `heartbeatTimeoutMs`, mark the connection
 *     `degraded` and proactively close + reconnect.
 *
 * The hook deliberately does NOT mutate the `statesByName` map on connection
 * loss — last-known state is preserved so the dashboard reflects what we
 * know rather than blanking out cards. Consumers that care about staleness
 * should observe `connectionStatus`.
 */
export function useNodeStatusStream(
  options: UseNodeStatusStreamOptions = {}
): UseNodeStatusStreamResult {
  const url = options.url ?? defaultUrl();
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const initialBackoffMs =
    options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  const [statesByName, setStatesByName] = useState<Partial<Record<NodeType, string>>>({});
  const [connectionStatus, setConnectionStatus] =
    useState<StreamConnectionStatus>('connecting');

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(initialBackoffMs);
  const closedByCallerRef = useRef(false);
  // Tracks whether the most recent socket already triggered a reconnect — guards
  // against `'error'` and `'close'` both firing for the same socket and double-
  // scheduling.
  const reconnectScheduledForCurrentSocketRef = useRef(false);
  const connectRef = useRef<(() => void) | null>(null);

  const reconnect = useCallback(() => {
    closedByCallerRef.current = false;
    reconnectScheduledForCurrentSocketRef.current = false;
    if (reconnectTimerRef.current != null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    backoffRef.current = initialBackoffMs;
    try {
      socketRef.current?.close();
    } catch {
      // best-effort
    }
    connectRef.current?.();
  }, [initialBackoffMs]);

  useEffect(() => {
    closedByCallerRef.current = false;

    function clearReconnect() {
      if (reconnectTimerRef.current != null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function clearHeartbeat() {
      if (heartbeatTimerRef.current != null) {
        clearTimeout(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    }

    /**
     * Captures `socket` in closure rather than reading `socketRef.current` at
     * timer-fire time — so a fresh socket from a reconnect can't be killed by
     * an old heartbeat timer.
     */
    function armHeartbeat(socket: WebSocket) {
      clearHeartbeat();
      heartbeatTimerRef.current = setTimeout(() => {
        setConnectionStatus('degraded');
        try {
          socket.close();
        } catch {
          // best-effort
        }
      }, heartbeatTimeoutMs);
    }

    function applyMessage(msg: WsMessage) {
      if (msg.type === 'nodeState') {
        const payload = (msg as WsNodeStateMessage).payload;
        const type = nameToNodeType(payload.name);
        if (type == null) return;
        setStatesByName((prev) => {
          if (prev[type] === payload.state) return prev;
          return { ...prev, [type]: payload.state };
        });
      }
      // metrics + heartbeat just keep the connection alive — handled by armHeartbeat.
    }

    function connect() {
      clearReconnect();
      reconnectScheduledForCurrentSocketRef.current = false;
      setConnectionStatus((prev) => (prev === 'open' ? prev : 'connecting'));
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        backoffRef.current = initialBackoffMs;
        setConnectionStatus('open');
        armHeartbeat(socket);
      });

      socket.addEventListener('message', (event) => {
        armHeartbeat(socket);
        // Functional setter — avoids reading the captured-at-mount
        // `connectionStatus` closure value on every message.
        setConnectionStatus((prev) => (prev === 'open' ? prev : 'open'));
        try {
          const parsed = JSON.parse(String(event.data)) as WsMessage;
          if (parsed.type === 'batch') {
            for (const m of parsed.messages) applyMessage(m);
          } else {
            applyMessage(parsed);
          }
        } catch (err) {
          // Malformed payloads still reset the heartbeat (the connection is
          // alive even if one message was bad), but log so operators can see
          // the server is emitting bad JSON.
          console.warn('[useNodeStatusStream] failed to parse message:', err);
        }
      });

      socket.addEventListener('close', () => {
        clearHeartbeat();
        if (closedByCallerRef.current) {
          setConnectionStatus('closed');
          return;
        }
        scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        // Most browsers/jsdom fire `'close'` after `'error'`, but some
        // environments (CSP-blocked WS, certificate revoked mid-handshake)
        // fire `'error'` alone. Schedule a reconnect here too — guarded by
        // a per-socket flag so we don't double-schedule when both fire.
        if (closedByCallerRef.current) return;
        scheduleReconnect();
      });
    }

    function scheduleReconnect() {
      if (closedByCallerRef.current) return;
      if (reconnectScheduledForCurrentSocketRef.current) return;
      reconnectScheduledForCurrentSocketRef.current = true;
      setConnectionStatus('degraded');
      const delay = Math.min(backoffRef.current, maxBackoffMs);
      reconnectTimerRef.current = setTimeout(() => {
        // Double the backoff *as we attempt the next connect* rather than
        // before the timer elapses — prevents a synchronous-throw loop from
        // burning through `100→200→…→cap` in milliseconds.
        backoffRef.current = Math.min(backoffRef.current * 2, maxBackoffMs);
        connect();
      }, delay);
    }

    connectRef.current = connect;
    connect();

    return () => {
      closedByCallerRef.current = true;
      connectRef.current = null;
      clearReconnect();
      clearHeartbeat();
      try {
        socketRef.current?.close();
      } catch {
        // best-effort
      }
      socketRef.current = null;
    };
  }, [url, heartbeatTimeoutMs, initialBackoffMs, maxBackoffMs]);

  return { statesByName, connectionStatus, reconnect };
}
