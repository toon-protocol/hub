import { useEffect, useState } from 'react';

export interface DepositAddressEntry {
  family: 'evm' | 'solana' | 'mina';
  address: string;
}

export type DepositAddressesStatus = 'loading' | 'ready' | 'error';

interface UseDepositAddressesOptions {
  /** Container name (e.g. 'dev-mill-01') or type-level placeholder ('mill'). */
  nodeId: string;
  /** Test override; production callers should rely on the default URL. */
  url?: string;
  /** Per-request timeout in ms (default 5 s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Single fetch of `GET /api/nodes/:nodeId/deposit-addresses` (no poll). */
export function useDepositAddresses(options: UseDepositAddressesOptions): {
  chains: DepositAddressEntry[];
  status: DepositAddressesStatus;
} {
  const { nodeId, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const url = options.url ?? `/api/nodes/${nodeId}/deposit-addresses`;

  const [chains, setChains] = useState<DepositAddressEntry[]>([]);
  const [status, setStatus] = useState<DepositAddressesStatus>('loading');

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
        const payload = (await res.json()) as { chains: DepositAddressEntry[] };
        if (cancelled) return;
        setChains(payload.chains ?? []);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('error');
      } finally {
        clearTimeout(timer);
      }
    }

    void load();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, timeoutMs]);

  return { chains, status };
}
