import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  TransportPatchRequest,
  TransportPatchResponse,
} from '@toon-protocol/hub';

export interface UseTransportPatchResult {
  patch: (
    req: TransportPatchRequest,
    onSuccess?: () => void
  ) => Promise<TransportPatchResponse>;
  pending: boolean;
  error: string | null;
}

/** Single-shot PATCH /api/transport. Gate against double-clicks via `pending`. */
export function useTransportPatch(
  options: {
    url?: string;
    timeoutMs?: number;
  } = {}
): UseTransportPatchResult {
  const url = options.url ?? '/api/transport';
  const timeoutMs = options.timeoutMs ?? 10_000;

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ref-backed pending guard — closure-stable across renders so a fast second
  // click cannot race a stale `pending=false` capture.
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const safeSetPending = (v: boolean) => {
    pendingRef.current = v;
    if (mountedRef.current) setPending(v);
  };
  const safeSetError = (v: string | null) => {
    if (mountedRef.current) setError(v);
  };

  const patch = useCallback(
    async (
      req: TransportPatchRequest,
      onSuccess?: () => void
    ): Promise<TransportPatchResponse> => {
      if (pendingRef.current) {
        throw new Error('patch already in flight');
      }
      safeSetPending(true);
      safeSetError(null);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
          signal: controller.signal,
        });

        // Reject explicitly non-JSON responses; tolerate missing header
        // (common in test mocks).
        const ct = res.headers?.get('content-type');
        let body:
          | (TransportPatchResponse & {
              error?: string;
              message?: string;
            })
          | null = null;

        if (!ct || ct.includes('json')) {
          try {
            body = (await res.json()) as TransportPatchResponse & {
              error?: string;
              message?: string;
            };
          } catch {
            body = null;
          }
        }

        if (!res.ok) {
          const msg = body?.message ?? body?.error ?? `HTTP ${res.status}`;
          safeSetError(msg);
          throw new Error(msg);
        }

        if (!body) {
          const msg = `unexpected response (HTTP ${res.status}, content-type: ${ct || 'none'})`;
          safeSetError(msg);
          throw new Error(msg);
        }

        // Call refetch callback so Home header updates immediately
        onSuccess?.();
        return body;
      } catch (e) {
        if (e instanceof Error && e.name !== 'AbortError') {
          safeSetError(e.message);
        } else if (e instanceof Error && e.name === 'AbortError') {
          safeSetError('Request timed out');
        }
        throw e;
      } finally {
        clearTimeout(timer);
        safeSetPending(false);
      }
    },
    [url, timeoutMs]
  );

  return { patch, pending, error };
}
