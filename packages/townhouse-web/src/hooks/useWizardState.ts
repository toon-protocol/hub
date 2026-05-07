import { useCallback, useEffect, useRef, useState } from 'react';
import type { WizardStatePayload } from '@toon-protocol/townhouse';

export type WizardStateStatus = 'loading' | 'ready' | 'error';

export interface UseWizardStateResult {
  state: WizardStatePayload | null;
  status: WizardStateStatus;
  refetch: () => void;
}

interface UseWizardStateOptions {
  url?: string;
  pollIntervalMs?: number;
  fetchTimeoutMs?: number;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_FETCH_TIMEOUT_MS = 3000;

/**
 * Polls GET /api/wizard/state every 2 s.
 * AC-25: In DEV builds, ?wizard=force in the URL overrides the API response
 * to simulate a fresh wizard session without deleting real config.
 */
export function useWizardState(
  options: UseWizardStateOptions = {}
): UseWizardStateResult {
  const {
    url = '/api/wizard/state',
    pollIntervalMs = DEFAULT_POLL_MS,
    fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  } = options;

  const [state, setState] = useState<WizardStatePayload | null>(null);
  const [status, setStatus] = useState<WizardStateStatus>('loading');

  const pollRef = useRef<() => void>(() => {
    /* placeholder until first effect runs */
  });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let activeController: AbortController | null = null;

    // AC-25: dev-only ?wizard=force override
    if (import.meta.env.DEV) {
      const search = new URLSearchParams(window.location.search);
      if (search.get('wizard') === 'force') {
        const mockState: WizardStatePayload = {
          config_exists: false,
          wallet_exists: false,
          containers_running: false,
          mode: 'wizard',
          ts: Date.now(),
        };
        setState(mockState);
        setStatus('ready');
        return () => {
          mountedRef.current = false;
        };
      }
    }

    async function poll() {
      const controller = new AbortController();
      activeController = controller;
      const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);

      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!mountedRef.current) return;
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const data = (await res.json()) as WizardStatePayload;
        if (!mountedRef.current) return;
        setState(data);
        setStatus('ready');
      } catch {
        if (!mountedRef.current) return;
        setStatus('error');
      } finally {
        clearTimeout(timeoutId);
        if (activeController === controller) {
          activeController = null;
        }
      }
    }

    pollRef.current = () => void poll();
    void poll();
    const timer = setInterval(() => void poll(), pollIntervalMs);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      pollRef.current = () => {
        /* cleared on unmount */
      };
      // Abort any in-flight fetch
      activeController?.abort();
    };
  }, [url, pollIntervalMs, fetchTimeoutMs]);

  const refetch = useCallback(() => {
    pollRef.current();
  }, []);

  return { state, status, refetch };
}
