import { useCallback, useEffect, useRef, useState } from 'react';
import type { NetworkMode } from '@toon-protocol/townhouse';

export interface UseNetworkPatchResult {
  patch: (network: NetworkMode, onSuccess?: () => void) => Promise<void>;
  pending: boolean;
  error: string | null;
}

/** Single-shot PATCH /api/network. Gate double-submits via `pending`. */
export function useNetworkPatch(
  options: { url?: string; timeoutMs?: number } = {}
): UseNetworkPatchResult {
  const url = options.url ?? '/api/network';
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
    async (network: NetworkMode, onSuccess?: () => void): Promise<void> => {
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
          body: JSON.stringify({ network }),
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
