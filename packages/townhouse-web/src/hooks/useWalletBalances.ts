import { useCallback, useEffect, useRef, useState } from 'react';
import type { WalletBalanceEntry, WalletBalancesPayload } from '@toon-protocol/townhouse';

export type WalletBalancesStatus = 'loading' | 'ready' | 'error';

/** Polls GET /api/wallet/balances every 5 s, mirrors useDvmJobsRecent shape. */
export function useWalletBalances(options: {
  pollIntervalMs?: number;
  url?: string;
  timeoutMs?: number;
} = {}): {
  entries: WalletBalanceEntry[];
  ts: number | null;
  status: WalletBalancesStatus;
  refetch: () => Promise<void>;
} {
  const url = options.url ?? '/api/wallet/balances';
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 5_000;

  const [entries, setEntries] = useState<WalletBalanceEntry[]>([]);
  const [ts, setTs] = useState<number | null>(null);
  const [status, setStatus] = useState<WalletBalancesStatus>('loading');
  const pollRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    setEntries([]);
    setTs(null);
    setStatus('loading');

    let cancelled = false;
    const inFlight = new Set<AbortController>();

    async function poll() {
      const controller = new AbortController();
      inFlight.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (cancelled) return;
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const payload = (await res.json()) as Partial<WalletBalancesPayload>;
        if (cancelled) return;
        // Validate shape — a server returning malformed JSON should not crash
        // downstream `entries.filter` callers.
        const safeEntries = Array.isArray(payload.entries) ? payload.entries : [];
        setEntries(safeEntries);
        setTs(typeof payload.ts === 'number' ? payload.ts : null);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('error');
      } finally {
        clearTimeout(timer);
        inFlight.delete(controller);
      }
    }

    pollRef.current = poll;
    void poll();
    const interval = setInterval(() => void poll(), pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
      for (const c of inFlight) c.abort();
    };
  }, [url, pollIntervalMs, timeoutMs]);

  const refetch = useCallback(() => pollRef.current(), []);

  return { entries, ts, status, refetch };
}
