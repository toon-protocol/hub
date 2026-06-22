import { useCallback, useEffect, useRef, useState } from 'react';
import type { NetworkMode } from '@toon-protocol/hub';

export type NetworkKind = 'loading' | 'ready' | 'error';

/**
 * Per-family settlement readiness, mirroring the core `NetworkFamilyStatus`
 * shape returned by GET /api/network. Defined locally because the hub
 * package re-exports `NetworkMode` but not this structural type, and
 * hub-web does not depend on @toon-protocol/core directly.
 */
export interface NetworkFamilyStatus {
  evm: 'configured' | 'unconfigured';
  solana: 'configured' | 'unconfigured';
  mina: 'configured' | 'unconfigured';
}

/**
 * Resolved node-container env overlay (only keys with real values are present),
 * mirroring the core `NetworkNodeEnv` shape from GET /api/network.
 */
export interface NetworkNodeEnv {
  EVM_CHAIN?: string;
  EVM_RPC_URL?: string;
  EVM_CHAIN_ID?: string;
  EVM_USDC_ADDRESS?: string;
  SOLANA_RPC_URL?: string;
  SOLANA_USDC_MINT?: string;
}

/**
 * Operator-supplied RPC URLs for the `custom` tier. Lets the operator point at
 * the project's dev chains (e.g. the Akash-hosted anvil/solana) without filling
 * in the full per-chain editor. Mirrors the optional `endpoints` field returned
 * by GET /api/network.
 */
export interface NetworkEndpoints {
  evmUrl?: string;
  solUrl?: string;
}

/** Shape of GET /api/network (also the non-restart subset of PATCH). */
export interface NetworkPayload {
  network: NetworkMode;
  status: NetworkFamilyStatus;
  nodeEnv: NetworkNodeEnv;
  /** Present (and meaningful) only when `network === 'custom'`. */
  endpoints?: NetworkEndpoints;
  ts: number;
}

export interface UseNetworkResult {
  /** Resolved network mode + per-family settlement status (null until ready). */
  network: NetworkPayload | null;
  kind: NetworkKind;
  refetch: () => void;
}

/** Single GET /api/network (re-fetchable). Config rarely changes — no polling. */
export function useNetwork(
  options: { url?: string; timeoutMs?: number } = {}
): UseNetworkResult {
  const url = options.url ?? '/api/network';
  const timeoutMs = options.timeoutMs ?? 5_000;

  const [network, setNetwork] = useState<NetworkPayload | null>(null);
  const [kind, setKind] = useState<NetworkKind>('loading');
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
        const body = (await res.json()) as Partial<NetworkPayload>;
        if (cancelledRef.current) return;
        // Defensive: only accept a well-formed payload (the GET route returns a
        // `network` mode + per-family status). Anything else is treated as a
        // load error rather than rendered as a half-populated panel.
        if (typeof body.network !== 'string' || body.status == null) {
          setKind('error');
          return;
        }
        setNetwork({
          network: body.network,
          status: body.status,
          nodeEnv: body.nodeEnv ?? {},
          ...(body.endpoints ? { endpoints: body.endpoints } : {}),
          ts: typeof body.ts === 'number' ? body.ts : Date.now(),
        });
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

  return { network, kind, refetch };
}
