import { useCallback, useEffect, useRef, useState } from 'react';

export type NodeHealthStatus = 'loading' | 'ready' | 'error';

interface UseNodeHealthOptions {
  /** Container name (e.g. 'dev-mill-01') or type-level placeholder ('mill'). */
  nodeId: string;
  pollIntervalMs?: number;
  /** Test override; production callers should rely on the default URL. */
  url?: string;
  /** Per-request timeout in ms (default 5 s). */
  timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Polls `GET /api/nodes/:nodeId/health` every 5 s.
 * Returns the raw health payload — callers narrow to the specific shape.
 */
export function useNodeHealth<T = Record<string, unknown>>(
  options: UseNodeHealthOptions
): {
  health: T | null;
  status: NodeHealthStatus;
  refetch: () => Promise<void>;
} {
  const {
    nodeId,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const url = options.url ?? `/api/nodes/${nodeId}/health`;

  const [health, setHealth] = useState<T | null>(null);
  const [status, setStatus] = useState<NodeHealthStatus>('loading');
  const pollRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    const inFlight = new Set<AbortController>();

    async function poll() {
      const controller = new AbortController();
      inFlight.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (cancelled) return;
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const payload = (await res.json()) as T;
        if (cancelled) return;
        setHealth(payload);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('error');
      } finally {
        clearTimeout(timer);
        inFlight.delete(controller);
      }
    }

    pollRef.current = poll;
    void poll();
    const interval = setInterval(() => void poll(), pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
      for (const c of inFlight) c.abort();
    };
  }, [url, pollIntervalMs, timeoutMs]);

  const refetch = useCallback(() => pollRef.current(), []);

  return { health, status, refetch };
}
