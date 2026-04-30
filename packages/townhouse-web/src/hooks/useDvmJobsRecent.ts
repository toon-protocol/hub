import { useCallback, useEffect, useRef, useState } from 'react';

export interface DvmJobsByKindEntry {
  kind: number;
  count: number;
  volume: string;
}

export interface DvmJobsRecent {
  count: number;
  volume: string;
  byKind: DvmJobsByKindEntry[];
  byStatus: {
    processing: number;
    success: number;
    error: number;
    partial: number;
  };
}

export type DvmJobsStatus = 'loading' | 'ready' | 'error';

interface UseDvmJobsRecentOptions {
  nodeId: string;
  windowSec?: number;
  pollIntervalMs?: number;
  /** Test override; production callers rely on the default URL. */
  url?: string;
  /** Per-request timeout in ms (default 5 s). */
  timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Polls `GET /api/nodes/:nodeId/jobs/recent` every 5 s. */
export function useDvmJobsRecent(options: UseDvmJobsRecentOptions): {
  data: DvmJobsRecent | null;
  status: DvmJobsStatus;
  refetch: () => Promise<void>;
} {
  const {
    nodeId,
    windowSec = 300,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const url = options.url ?? `/api/nodes/${nodeId}/jobs/recent?windowSec=${windowSec}`;

  const [data, setData] = useState<DvmJobsRecent | null>(null);
  const [status, setStatus] = useState<DvmJobsStatus>('loading');
  const pollRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    // Reset state on URL change so a card switching to a different nodeId
    // doesn't display the previous DVM's data until the new fetch resolves.
    setData(null);
    setStatus('loading');

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
        const payload = await res.json() as DvmJobsRecent;
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

  // Return the in-flight promise so callers can `await refetch()` after a
  // PATCH and know the data has actually been re-read before they continue.
  const refetch = useCallback(() => pollRef.current(), []);

  return { data, status, refetch };
}
