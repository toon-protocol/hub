import { useCallback, useEffect, useRef, useState } from 'react';

export interface SwapByPairEntry {
  pair: string;
  count: number;
  volume: string;
}

export interface MillSwapsRecent {
  count: number;
  volume: string;
  byPair: SwapByPairEntry[];
}

export type MillSwapsStatus = 'loading' | 'ready' | 'error';

interface UseMillSwapsRecentOptions {
  /** Container name (e.g. 'dev-mill-01') or type-level placeholder ('mill'). */
  nodeId: string;
  windowSec?: number;
  pollIntervalMs?: number;
  /** Test override; production callers should rely on the default URL. */
  url?: string;
  /** Per-request timeout in ms (default 5 s). */
  timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Polls `GET /api/nodes/:nodeId/swaps/recent` every 5 s. */
export function useMillSwapsRecent(options: UseMillSwapsRecentOptions): {
  data: MillSwapsRecent | null;
  status: MillSwapsStatus;
  refetch: () => void;
} {
  const {
    nodeId,
    windowSec = 300,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const url =
    options.url ?? `/api/nodes/${nodeId}/swaps/recent?windowSec=${windowSec}`;

  const [data, setData] = useState<MillSwapsRecent | null>(null);
  const [status, setStatus] = useState<MillSwapsStatus>('loading');
  const pollRef = useRef<() => void>(() => {
    /* placeholder until first effect runs */
  });

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
        const payload = (await res.json()) as MillSwapsRecent;
        if (cancelled) return;
        setData(payload);
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

  const refetch = useCallback(() => {
    pollRef.current();
  }, []);

  return { data, status, refetch };
}
