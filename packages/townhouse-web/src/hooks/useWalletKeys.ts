import { useCallback, useEffect, useState } from 'react';
import type { NodeKeyInfo } from '@toon-protocol/townhouse';

export type UseWalletKeysStatus = 'loading' | 'ready' | 'error';

/** Single fetch of GET /wallet, mirrors useNodes failure handling. */
export function useWalletKeys(
  options: { url?: string; timeoutMs?: number } = {}
): {
  keys: NodeKeyInfo[];
  status: UseWalletKeysStatus;
  refetch: () => void;
} {
  const url = options.url ?? '/api/wallet';
  const timeoutMs = options.timeoutMs ?? 5_000;

  const [keys, setKeys] = useState<NodeKeyInfo[]>([]);
  const [status, setStatus] = useState<UseWalletKeysStatus>('loading');
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => setRefreshKey((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    async function load() {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (cancelled) return;
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const payload = (await res.json()) as { keys: NodeKeyInfo[] };
        if (cancelled) return;
        setKeys(payload.keys ?? []);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('error');
      } finally {
        clearTimeout(timer);
      }
    }

    setStatus('loading');
    void load();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, timeoutMs, refreshKey]);

  return { keys, status, refetch };
}
