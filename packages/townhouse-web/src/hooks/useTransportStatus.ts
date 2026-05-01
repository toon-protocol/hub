import { useCallback, useEffect, useRef, useState } from 'react';
import type { TransportStatusPayload } from '@toon-protocol/townhouse';

export type TransportStatusKind = 'loading' | 'ready' | 'error';

export interface UseTransportStatusResult {
  status: TransportStatusPayload | null;
  statusKind: TransportStatusKind;
  refetch: () => void;
}

function isValidPayload(p: unknown): p is TransportStatusPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    (o.mode === 'direct' || o.mode === 'ator') &&
    typeof o.reachable === 'boolean' &&
    typeof o.lastProbedAt === 'number'
  );
}

/** Polls GET /api/transport every 5 s. Single source of truth for transport status. */
export function useTransportStatus(
  options: {
    pollIntervalMs?: number;
    url?: string;
    timeoutMs?: number;
  } = {}
): UseTransportStatusResult {
  const url = options.url ?? '/api/transport';
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 5_000);
  const timeoutMs = options.timeoutMs ?? 5_000;

  const [transportStatus, setTransportStatus] =
    useState<TransportStatusPayload | null>(null);
  const [statusKind, setStatusKind] = useState<TransportStatusKind>('loading');
  const [refreshKey, setRefreshKey] = useState(0);
  const cancelledRef = useRef(false);
  // Sequence number — out-of-order responses (slow tick N + fast tick N+1)
  // are dropped so we never overwrite a newer snapshot with an older one.
  const seqRef = useRef(0);

  const refetch = useCallback(() => {
    setRefreshKey((n) => n + 1);
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    setStatusKind((prev) => (prev === 'ready' ? 'ready' : 'loading'));

    async function fetchStatus(seq: number) {
      // Per-fetch AbortController so a tick's timeout doesn't abort overlapping ticks.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (cancelledRef.current || seq !== seqRef.current) return;
        if (!res.ok) {
          setStatusKind('error');
          return;
        }
        // Reject explicitly non-JSON responses (HTML proxy errors, plaintext
        // 5xx). When the header is absent (common in test mocks), proceed and
        // let res.json() decide.
        const ct = res.headers?.get('content-type');
        if (ct && !ct.includes('json')) {
          setStatusKind('error');
          return;
        }
        let raw: unknown;
        try {
          raw = await res.json();
        } catch {
          if (cancelledRef.current || seq !== seqRef.current) return;
          setStatusKind('error');
          return;
        }
        if (cancelledRef.current || seq !== seqRef.current) return;
        if (!isValidPayload(raw)) {
          setStatusKind('error');
          return;
        }
        setTransportStatus(raw);
        setStatusKind('ready');
      } catch (e) {
        if (cancelledRef.current || seq !== seqRef.current) return;
        if (e instanceof Error && e.name === 'AbortError') return;
        setStatusKind('error');
      } finally {
        clearTimeout(timer);
      }
    }

    function tick() {
      seqRef.current += 1;
      void fetchStatus(seqRef.current);
    }

    tick();
    const interval = setInterval(tick, pollIntervalMs);

    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
      // Bump seq so any in-flight fetch is ignored after unmount.
      seqRef.current += 1;
    };
  }, [url, pollIntervalMs, timeoutMs, refreshKey]);

  return { status: transportStatus, statusKind, refetch };
}
