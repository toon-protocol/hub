import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChainProviderEntry } from '@toon-protocol/townhouse';

export interface UseChainsPatchResult {
  patch: (
    chainProviders: ChainProviderEntry[],
    onSuccess?: () => void
  ) => Promise<void>;
  pending: boolean;
  error: string | null;
}

/** Single-shot PATCH /api/chains. Gate double-submits via `pending`. */
export function useChainsPatch(
  options: { url?: string; timeoutMs?: number } = {}
): UseChainsPatchResult {
  const url = options.url ?? '/api/chains';
  const timeoutMs = options.timeoutMs ?? 15_000;

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const patch = useCallback(
    async (
      chainProviders: ChainProviderEntry[],
      onSuccess?: () => void
    ): Promise<void> => {
      if (pendingRef.current) throw new Error('patch already in flight');
      pendingRef.current = true;
      if (mountedRef.current) {
        setPending(true);
        setError(null);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chainProviders }),
          signal: controller.signal,
        });
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const b = (await res.json()) as { message?: string };
            if (b?.message) msg = b.message;
          } catch {
            /* non-JSON error body */
          }
          throw new Error(msg);
        }
        onSuccess?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (mountedRef.current) setError(msg);
        throw err;
      } finally {
        clearTimeout(timer);
        pendingRef.current = false;
        if (mountedRef.current) setPending(false);
      }
    },
    [url, timeoutMs]
  );

  return { patch, pending, error };
}
