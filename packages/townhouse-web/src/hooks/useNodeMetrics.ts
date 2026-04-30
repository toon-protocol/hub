import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeDetail, BandwidthPayload } from '@toon-protocol/townhouse';

export interface NodeMetrics {
  /** From GET /api/nodes/:type */
  connectedClients: number | null;
  /** From GET /api/nodes/:type/bandwidth */
  bandwidth: BandwidthPayload | null;
  /** Current fee from GET /api/nodes/:type config field */
  currentFee: number | null;
}

export type NodeMetricsStatus = 'loading' | 'ready' | 'error';

export interface UseNodeMetricsResult {
  metrics: NodeMetrics;
  status: NodeMetricsStatus;
  refetch: () => void;
}

interface UseNodeMetricsOptions {
  nodeType: 'town' | 'mill' | 'dvm';
  /** Override the node detail URL */
  detailUrl?: string;
  /** Override the bandwidth URL */
  bandwidthUrl?: string;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Polls `/api/nodes/:type` and `/api/nodes/:type/bandwidth` every 5 s.
 * Returns connected-client count and bandwidth stats for a single node type.
 */
export function useNodeMetrics(options: UseNodeMetricsOptions): UseNodeMetricsResult {
  const {
    nodeType,
    detailUrl = `/api/nodes/${nodeType}`,
    bandwidthUrl = `/api/nodes/${nodeType}/bandwidth`,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  const [metrics, setMetrics] = useState<NodeMetrics>({ connectedClients: null, bandwidth: null, currentFee: null });
  const [status, setStatus] = useState<NodeMetricsStatus>('loading');

  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [detailRes, bwRes] = await Promise.all([
          fetch(detailUrl),
          fetch(bandwidthUrl),
        ]);

        if (cancelled) return;

        let connectedClients: number | null = null;
        let currentFee: number | null = null;
        if (detailRes.ok) {
          const detail = await detailRes.json() as NodeDetail;
          // packetsForwarded used as a proxy until a dedicated connectedClients field lands
          connectedClients = detail.metrics?.packetsForwarded ?? null;
          currentFee = detail.config?.feePerEvent ?? null;
        }

        let bandwidth: BandwidthPayload | null = null;
        if (bwRes.ok) {
          const bwBody = await bwRes.json() as BandwidthPayload | null;
          bandwidth = bwBody;
        }

        if (cancelled) return;

        setMetrics({ connectedClients, bandwidth, currentFee });
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('error');
      }
    }

    pollRef.current = () => void poll();

    void poll();
    const timer = setInterval(() => void poll(), pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
      pollRef.current = () => {};
    };
  }, [detailUrl, bandwidthUrl, pollIntervalMs]);

  const refetch = useCallback(() => { pollRef.current(); }, []);

  return { metrics, status, refetch };
}
