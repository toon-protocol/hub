import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChainProviderEntry } from '@toon-protocol/townhouse';

export type ChainsKind = 'loading' | 'ready' | 'error';

export interface UseChainsResult {
  /** Configured settlement chains (keyId is redacted as '***' by the API). */
  chains: ChainProviderEntry[];
  kind: ChainsKind;
  refetch: () => void;
}

/** Single GET /api/chains (re-fetchable). Config rarely changes — no polling. */
export function useChains(
  options: { url?: string; timeoutMs?: number } = {}
): UseChainsResult {
  const url = options.url ?? '/api/chains';
  const timeoutMs = options.timeoutMs ?? 5_000;

  const [chains, setChains] = useState<ChainProviderEntry[]>([]);
  const [kind, setKind] = useState<ChainsKind>('loading');
  const [refreshKey, setRefreshKey] = useState(0);
  const cancelledRef = useRef(false);

  const refetch = useCallback(() => setRefreshKey((n) => n + 1), []);

  useEffect(() => {
    cancelledRef.current = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    void (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          chainProviders?: ChainProviderEntry[];
        };
        if (cancelledRef.current) return;
        setChains(
          Array.isArray(body.chainProviders) ? body.chainProviders : []
        );
        setKind('ready');
      } catch (err) {
        if (cancelledRef.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setKind('error');
      } finally {
        clearTimeout(timer);
      }
    })();

    return () => {
      cancelledRef.current = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, timeoutMs, refreshKey]);

  return { chains, kind, refetch };
}
