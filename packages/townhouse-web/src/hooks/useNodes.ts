import { useCallback, useEffect, useState } from 'react';
import type {
  NodeInfo,
  NodeDetail,
  MetricsPayload,
  NodeType,
} from '@toon-protocol/hub';

export type UseNodesStatus = 'loading' | 'ready' | 'error';

export interface UseNodesResult {
  nodes: NodeInfo[];
  /** metrics indexed by node type — populated from per-type detail fetches */
  metricsByType: Partial<Record<NodeType, MetricsPayload | null>>;
  status: UseNodesStatus;
  error: Error | null;
  /**
   * True while a refetch is running on top of an already-`ready` cache. Lets
   * consumers show a subtle inline spinner instead of replacing the whole
   * cards section with the loading skeleton.
   */
  isRefreshing: boolean;
  refetch: () => void;
}

interface UseNodesOptions {
  /** Override the list endpoint (defaults to `/api/nodes`). */
  listUrl?: string;
  /** Override the per-type detail endpoint builder. */
  detailUrl?: (type: NodeType) => string;
  /** Per-request timeout in ms for both list and detail fetches. */
  requestTimeoutMs?: number;
}

const defaultDetailUrl = (type: NodeType) => `/api/nodes/${type}`;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Fetch the operator's node roster and per-type metrics.
 *
 * Two-phase fetch:
 *   1. `GET /api/nodes` for the list (state, uptime, enabled).
 *   2. For each enabled type, `GET /api/nodes/:type` to harvest the
 *      `metrics` payload (the list endpoint omits it).
 *
 * Failures of individual detail fetches are tolerated — the list still
 * resolves to `ready` and the per-type metric is left absent. Only a
 * failure of the list fetch trips the hook into `error`.
 */
export function useNodes(options: UseNodesOptions = {}): UseNodesResult {
  const listUrl = options.listUrl ?? '/api/nodes';
  const detailUrl = options.detailUrl ?? defaultDetailUrl;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [metricsByType, setMetricsByType] = useState<
    Partial<Record<NodeType, MetricsPayload | null>>
  >({});
  const [status, setStatus] = useState<UseNodesStatus>('loading');
  const [error, setError] = useState<Error | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => {
    setRefreshKey((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setStatus((prev) => {
      // First load (or post-error) → flip to loading skeleton. Subsequent
      // refetches keep prior cards visible and surface progress via
      // `isRefreshing` instead.
      if (prev === 'ready') {
        setIsRefreshing(true);
        return prev;
      }
      return 'loading';
    });
    setError(null);

    /**
     * Wrap a fetch in a per-request timeout that aborts only this call,
     * not the parent controller (so a slow detail fetch doesn't kill the
     * whole hook).
     */
    async function fetchWithTimeout(
      input: string,
      parentSignal: AbortSignal
    ): Promise<Response> {
      const localController = new AbortController();
      const onParentAbort = () => localController.abort();
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
      const timeout = setTimeout(
        () => localController.abort(),
        requestTimeoutMs
      );
      try {
        return await fetch(input, { signal: localController.signal });
      } finally {
        clearTimeout(timeout);
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    }

    async function load() {
      try {
        const res = await fetchWithTimeout(listUrl, controller.signal);
        if (!res.ok) {
          throw new Error(`GET ${listUrl} failed: ${res.status}`);
        }
        const list = (await res.json()) as NodeInfo[];
        if (cancelled) return;
        setNodes(list);

        const enabled = list.filter((n) => n.enabled);
        const detailEntries = await Promise.all(
          enabled.map(async (node) => {
            try {
              const detailRes = await fetchWithTimeout(
                detailUrl(node.type),
                controller.signal
              );
              if (!detailRes.ok) return [node.type, null] as const;
              const detail = (await detailRes.json()) as NodeDetail;
              return [node.type, detail.metrics] as const;
            } catch {
              // Includes timeouts — record null and let the list still render.
              return [node.type, null] as const;
            }
          })
        );
        if (cancelled) return;

        const next: Partial<Record<NodeType, MetricsPayload | null>> = {};
        for (const [type, metrics] of detailEntries) {
          next[type] = metrics;
        }
        setMetricsByType(next);
        setStatus('ready');
        setIsRefreshing(false);
      } catch (e) {
        // Suppress phantom errors during fast remount: a stream-read abort can
        // surface as `TypeError` (Firefox) or a `DOMException` named
        // `AbortError` (Chromium). The `cancelled` flag is the authoritative
        // signal that this run was intentionally aborted.
        if (cancelled || controller.signal.aborted) return;
        if (e instanceof Error && e.name === 'AbortError') return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setStatus('error');
        setIsRefreshing(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [listUrl, detailUrl, requestTimeoutMs, refreshKey]);

  return { nodes, metricsByType, status, error, isRefreshing, refetch };
}
