import { useEffect, useState } from 'react';
import type { TimeseriesBucket } from '@toon-protocol/townhouse';

export interface UsePacketTimeseriesResult {
  buckets: TimeseriesBucket[];
  status: 'loading' | 'ready' | 'error' | 'unavailable';
}

interface UsePacketTimeseriesOptions {
  nodeType: 'town' | 'mill' | 'dvm';
  bucket?: 'hour' | 'day' | 'minute';
  /** Number of hours to look back (default: 24) */
  lookbackHours?: number;
  /** Override the timeseries URL */
  url?: string;
  /** Refetch interval in ms (default: 60_000) */
  refetchIntervalMs?: number;
}

const DEFAULT_REFETCH_INTERVAL_MS = 60_000;

/**
 * Fetches `/api/nodes/:type/packets/timeseries` and refetches every minute.
 * Returns 'unavailable' status when the connector image doesn't expose the endpoint (503).
 */
export function usePacketTimeseries(options: UsePacketTimeseriesOptions): UsePacketTimeseriesResult {
  const {
    nodeType,
    bucket = 'hour',
    lookbackHours = 24,
    refetchIntervalMs = DEFAULT_REFETCH_INTERVAL_MS,
  } = options;

  // Stable base URL — does not include `since`, which is computed fresh per fetch
  // to avoid Effect restarts on every parent re-render.
  const baseUrl = options.url ?? null;

  const [buckets, setBuckets] = useState<TimeseriesBucket[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading');

  useEffect(() => {
    let cancelled = false;

    async function fetch_() {
      // Compute `since` at fetch time so the 24-hour window slides correctly.
      const since = new Date(Date.now() - lookbackHours * 60 * 60_000).toISOString();
      const timeseriesUrl = baseUrl ?? `/api/nodes/${nodeType}/packets/timeseries?bucket=${bucket}&since=${encodeURIComponent(since)}`;
      try {
        const res = await fetch(timeseriesUrl);
        if (cancelled) return;

        if (res.status === 503) {
          setStatus('unavailable');
          return;
        }

        if (!res.ok) {
          setStatus('error');
          return;
        }

        const body = await res.json() as { buckets: TimeseriesBucket[] };
        if (cancelled) return;

        setBuckets(body.buckets ?? []);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('error');
      }
    }

    void fetch_();
    const timer = setInterval(() => void fetch_(), refetchIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [baseUrl, nodeType, bucket, lookbackHours, refetchIntervalMs]);

  return { buckets, status };
}
