import { useEffect, useRef, useState } from 'react';
import type { AggregatedEarnings } from './types.js';
import {
  DEFAULT_API_URL,
  DEFAULT_REFRESH_INTERVAL_MS,
  STARTING_UP_GRACE_FETCHES,
} from './constants.js';

export type EarningsState =
  | { phase: 'loading'; data: null; bannerKey: null }
  | { phase: 'ok'; data: AggregatedEarnings; bannerKey: null }
  | {
      phase: 'stale';
      data: AggregatedEarnings;
      bannerKey: 'connector_unavailable' | 'fetch_failed' | 'starting_up';
    };

export interface UseEarningsOptions {
  apiUrl?: string;
  refreshIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

const EMPTY_EARNINGS: AggregatedEarnings = {
  status: 'connector_unavailable',
  apex: { routingFees: {} },
  peers: [],
  recentClaims: [],
  eventsRelayed: 0,
  uptimeSeconds: 0,
};

export function useEarnings(opts: UseEarningsOptions = {}): EarningsState {
  const {
    apiUrl = DEFAULT_API_URL,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    fetchImpl = globalThis.fetch,
  } = opts;

  const [state, setState] = useState<EarningsState>({
    phase: 'loading',
    data: null,
    bannerKey: null,
  });

  const prevDataRef = useRef<AggregatedEarnings | null>(null);
  // Consecutive failures before the first-ever success. Resets on any success.
  const warmupFailuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let abortController: AbortController | null = null;

    // Choose the banner for a failed fetch: a calm 'starting_up' while a node
    // that has never responded is within its warm-up grace, escalating to the
    // specific failure banner once we've had data OR the grace is exhausted.
    function failureBanner(
      specific: 'fetch_failed' | 'connector_unavailable'
    ): 'starting_up' | 'fetch_failed' | 'connector_unavailable' {
      if (prevDataRef.current !== null) return specific;
      warmupFailuresRef.current += 1;
      return warmupFailuresRef.current <= STARTING_UP_GRACE_FETCHES
        ? 'starting_up'
        : specific;
    }

    async function doFetch(): Promise<void> {
      if (cancelled) return;

      const ac = new AbortController();
      abortController = ac;

      try {
        const res = await fetchImpl(`${apiUrl}/api/earnings`, {
          signal: ac.signal,
        });

        if (cancelled) return;

        if (!res.ok) {
          const prev = prevDataRef.current;
          setState({
            phase: 'stale',
            data: prev ?? EMPTY_EARNINGS,
            bannerKey: failureBanner('fetch_failed'),
          });
          return;
        }

        const body = (await res.json()) as AggregatedEarnings;

        if (cancelled) return;

        if (body.status === 'connector_unavailable') {
          const prev = prevDataRef.current;
          setState({
            phase: 'stale',
            data: prev ?? EMPTY_EARNINGS,
            bannerKey: failureBanner('connector_unavailable'),
          });
          return;
        }

        prevDataRef.current = body;
        warmupFailuresRef.current = 0;
        setState({ phase: 'ok', data: body, bannerKey: null });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;

        setState({
          phase: 'stale',
          data: prevDataRef.current ?? EMPTY_EARNINGS,
          bannerKey: failureBanner('fetch_failed'),
        });
      } finally {
        abortController = null;
      }
    }

    void doFetch();

    const intervalId = setInterval(() => {
      void doFetch();
    }, refreshIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      if (abortController !== null) {
        abortController.abort();
      }
    };
  }, [apiUrl, refreshIntervalMs, fetchImpl]);

  return state;
}
