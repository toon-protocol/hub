import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  WsRelayEventsMessage,
  NostrEventPayload,
} from '@toon-protocol/townhouse';

export type RelayStreamStatus = 'connecting' | 'open' | 'degraded' | 'closed';

export interface UseRelayEventStreamResult {
  events: NostrEventPayload[];
  status: RelayStreamStatus;
  reconnect: () => void;
}

interface UseRelayEventStreamOptions {
  url?: string;
  nodeId: string;
  /** Max events to buffer client-side (default: 50) */
  bufferSize?: number;
  heartbeatTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_BUFFER_SIZE = 50;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

function defaultUrl(nodeId: string): string {
  if (typeof window === 'undefined')
    return `ws://127.0.0.1:9400/metrics?subscribe=relayEvents:${nodeId}`;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/metrics?subscribe=relayEvents:${nodeId}`;
}

/**
 * Subscribe to relay events for a specific Town node instance.
 *
 * Maintains a ring buffer of the last `bufferSize` events. Reconnects with
 * exponential backoff on disconnect. Mirrors the pattern of useNodeStatusStream.
 */
export function useRelayEventStream(
  options: UseRelayEventStreamOptions
): UseRelayEventStreamResult {
  const { nodeId, bufferSize = DEFAULT_BUFFER_SIZE } = options;
  const url = options.url ?? defaultUrl(nodeId);
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const initialBackoffMs =
    options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  const [events, setEvents] = useState<NostrEventPayload[]>([]);
  const [status, setStatus] = useState<RelayStreamStatus>('connecting');

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(initialBackoffMs);
  const closedByCallerRef = useRef(false);
  const reconnectScheduledRef = useRef(false);
  const connectRef = useRef<(() => void) | null>(null);

  const reconnect = useCallback(() => {
    closedByCallerRef.current = false;
    reconnectScheduledRef.current = false;
    if (reconnectTimerRef.current != null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    backoffRef.current = initialBackoffMs;
    try {
      socketRef.current?.close();
    } catch {
      /* best-effort */
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

    function armHeartbeat(socket: WebSocket) {
      clearHeartbeat();
      heartbeatTimerRef.current = setTimeout(() => {
        setStatus('degraded');
        try {
          socket.close();
        } catch {
          /* best-effort */
        }
      }, heartbeatTimeoutMs);
    }

    function scheduleReconnect() {
      if (closedByCallerRef.current) return;
      if (reconnectScheduledRef.current) return;
      reconnectScheduledRef.current = true;
      setStatus('degraded');
      const delay = Math.min(backoffRef.current, maxBackoffMs);
      reconnectTimerRef.current = setTimeout(() => {
        backoffRef.current = Math.min(backoffRef.current * 2, maxBackoffMs);
        connect();
      }, delay);
    }

    function connect() {
      clearReconnect();
      reconnectScheduledRef.current = false;
      setStatus((prev) => (prev === 'open' ? prev : 'connecting'));
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
        setStatus('open');
        armHeartbeat(socket);
      });

      socket.addEventListener('message', (event) => {
        armHeartbeat(socket);
        setStatus((prev) => (prev === 'open' ? prev : 'open'));
        try {
          type RawMsg = {
            type: string;
            nodeId?: string;
            payload?: NostrEventPayload;
            messages?: RawMsg[];
            connected?: boolean;
          };
          const parsed = JSON.parse(String(event.data)) as RawMsg;

          function applyMsg(msg: RawMsg) {
            if (
              msg.type === 'relayEvents' &&
              msg.nodeId === nodeId &&
              msg.payload
            ) {
              const incoming = msg.payload;
              setEvents((prev) => {
                const next = [...prev, incoming];
                return next.length > bufferSize
                  ? next.slice(next.length - bufferSize)
                  : next;
              });
            }
            // Server notifies us when the upstream relay WS closes so we can show
            // the AC-7 error state instead of silently showing an empty feed.
            if (
              msg.type === 'relayEventsStatus' &&
              msg.nodeId === nodeId &&
              msg.connected === false
            ) {
              setStatus('degraded');
            }
          }

          if (parsed.type === 'batch' && parsed.messages) {
            for (const m of parsed.messages) applyMsg(m);
          } else {
            applyMsg(parsed);
          }
        } catch (err) {
          console.warn('[useRelayEventStream] failed to parse message:', err);
        }
      });

      socket.addEventListener('close', () => {
        clearHeartbeat();
        if (closedByCallerRef.current) {
          setStatus('closed');
          return;
        }
        scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        if (closedByCallerRef.current) return;
        scheduleReconnect();
      });
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
        /* best-effort */
      }
      socketRef.current = null;
    };
  }, [
    url,
    nodeId,
    bufferSize,
    heartbeatTimeoutMs,
    initialBackoffMs,
    maxBackoffMs,
  ]);

  return { events, status, reconnect };
}
