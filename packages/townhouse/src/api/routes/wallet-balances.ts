/**
 * GET /api/wallet/balances
 *
 * Returns per-(nodeType × family × token) balance entries.
 * Per-RPC failure is partial — one bad chain never kills the whole response.
 * Server-side cache: 5 s TTL per (nodeType × address × token) to avoid
 * hammering RPCs and to keep `payload.ts` stable across cache-hit reads.
 * In-flight requests for the same key are deduped via a Promise map so two
 * parallel /balances calls don't double-call the upstream RPC.
 */

import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../types.js';
import type { WalletBalanceEntry, WalletBalancesPayload } from '../types.js';
import { getEvmBalance, getErc20Balance } from '../../chain/evm-rpc.js';
import { getSolanaBalance } from '../../chain/solana-rpc.js';
import { getMinaBalance } from '../../chain/mina-graphql.js';
import type { NodeKeyInfo } from '../../wallet/types.js';

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheEntry {
  entry: WalletBalanceEntry;
  ts: number;
}

// In-memory best-effort cache (restart-volatile; single-process).
const CACHE = new Map<string, CacheEntry>();
const INFLIGHT = new Map<string, Promise<WalletBalanceEntry>>();
const CACHE_TTL_MS = 5_000;

/** Test hook: reset module-scope cache between vitest tests. */
export function resetWalletBalancesCache(): void {
  CACHE.clear();
  INFLIGHT.clear();
}

function getCachedEntry(key: string): CacheEntry | undefined {
  const hit = CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    CACHE.delete(key);
    return undefined;
  }
  return hit;
}

function setCached(key: string, entry: WalletBalanceEntry): CacheEntry {
  const cached = { entry, ts: Date.now() };
  CACHE.set(key, cached);
  return cached;
}

/** Wrap a fetcher with cache + in-flight dedup so two callers for the same key
 *  share one upstream RPC call. */
async function memoize(
  key: string,
  fetcher: () => Promise<WalletBalanceEntry>,
): Promise<{ entry: WalletBalanceEntry; ts: number }> {
  const cached = getCachedEntry(key);
  if (cached) return cached;
  const inflight = INFLIGHT.get(key);
  if (inflight) {
    const entry = await inflight;
    const after = getCachedEntry(key);
    return after ?? { entry, ts: Date.now() };
  }
  const promise = (async () => {
    try {
      const entry = await fetcher();
      setCached(key, entry);
      return entry;
    } finally {
      INFLIGHT.delete(key);
    }
  })();
  INFLIGHT.set(key, promise);
  const entry = await promise;
  const after = getCachedEntry(key);
  return after ?? { entry, ts: Date.now() };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

function unavailable(
  nodeType: 'town' | 'mill' | 'dvm',
  family: WalletBalanceEntry['family'],
  token: WalletBalanceEntry['token'],
  address: string,
  scale: number,
  reason: string,
): WalletBalanceEntry {
  return { nodeType, family, token, address, balance: '0', scale, available: false, reason };
}

async function fetchEvmEth(
  rpcUrl: string,
  nodeType: 'town' | 'mill' | 'dvm',
  address: string,
): Promise<{ entry: WalletBalanceEntry; ts: number }> {
  const cacheKey = `evm:${nodeType}:${address}:ETH`;
  return memoize(cacheKey, async () => {
    try {
      const balance = await getEvmBalance(rpcUrl, address);
      return { nodeType, family: 'evm', token: 'ETH', address, balance, scale: 18, available: true };
    } catch (e) {
      return unavailable(nodeType, 'evm', 'ETH', address, 18, e instanceof Error ? e.message : 'evm_rpc_error');
    }
  });
}

async function fetchEvmUsdc(
  rpcUrl: string,
  usdcAddress: string | undefined,
  nodeType: 'town' | 'mill' | 'dvm',
  address: string,
): Promise<{ entry: WalletBalanceEntry; ts: number }> {
  if (!usdcAddress || !/^0x[0-9a-fA-F]{40}$/.test(usdcAddress)) {
    // Don't cache config-drift — it should clear immediately when the env is fixed.
    return { entry: unavailable(nodeType, 'evm', 'USDC', address, 6, 'usdc_address_not_configured'), ts: Date.now() };
  }
  const cacheKey = `evm:${nodeType}:${address}:USDC`;
  return memoize(cacheKey, async () => {
    try {
      const balance = await getErc20Balance(rpcUrl, usdcAddress, address);
      return { nodeType, family: 'evm', token: 'USDC', address, balance, scale: 6, available: true };
    } catch (e) {
      return unavailable(nodeType, 'evm', 'USDC', address, 6, e instanceof Error ? e.message : 'evm_rpc_error');
    }
  });
}

async function fetchSolana(
  rpcUrl: string,
  nodeType: 'town' | 'mill' | 'dvm',
  address: string,
): Promise<{ entry: WalletBalanceEntry; ts: number }> {
  const cacheKey = `solana:${nodeType}:${address}:SOL`;
  return memoize(cacheKey, async () => {
    try {
      const balance = await getSolanaBalance(rpcUrl, address);
      return { nodeType, family: 'solana', token: 'SOL', address, balance, scale: 9, available: true };
    } catch (e) {
      return unavailable(nodeType, 'solana', 'SOL', address, 9, e instanceof Error ? e.message : 'solana_rpc_error');
    }
  });
}

async function fetchMina(
  graphqlUrl: string,
  nodeType: 'town' | 'mill' | 'dvm',
  address: string,
): Promise<{ entry: WalletBalanceEntry; ts: number }> {
  const cacheKey = `mina:${nodeType}:${address}:MINA`;
  return memoize(cacheKey, async () => {
    try {
      const balance = await getMinaBalance(graphqlUrl, address);
      return { nodeType, family: 'mina', token: 'MINA', address, balance, scale: 9, available: true };
    } catch (e) {
      return unavailable(nodeType, 'mina', 'MINA', address, 9, e instanceof Error ? e.message : 'mina_graphql_error');
    }
  });
}

// ── Route registration ────────────────────────────────────────────────────────

interface FetchTask {
  /** Identity of the (nodeType, family, token, address) so a thrown task can
   *  still be reported with its original tuple instead of a fake town/ETH stub. */
  identity: { nodeType: 'town' | 'mill' | 'dvm'; family: WalletBalanceEntry['family']; token: WalletBalanceEntry['token']; address: string; scale: number };
  run: () => Promise<{ entry: WalletBalanceEntry; ts: number }>;
}

export function registerWalletBalancesRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/wallet/balances', async (_request, reply) => {
    let keys: NodeKeyInfo[];
    try {
      keys = deps.wallet.getAllKeys();
    } catch {
      return reply.status(503).send({ error: 'wallet_not_initialized' });
    }

    const anvil = process.env['TOWNHOUSE_DEV_ANVIL_RPC'] ?? 'http://127.0.0.1:28545';
    const solanaRpc = process.env['TOWNHOUSE_DEV_SOLANA_RPC'] ?? 'http://127.0.0.1:28899';
    const minaGraphql = process.env['TOWNHOUSE_DEV_MINA_GRAPHQL'] ?? 'http://127.0.0.1:28085/graphql';
    const usdcAddress = process.env['TOON_USDC_ADDRESS'] || undefined;

    const tasks: FetchTask[] = [];
    for (const keyInfo of keys) {
      const nodeType = keyInfo.nodeType as 'town' | 'mill' | 'dvm';
      tasks.push({
        identity: { nodeType, family: 'evm', token: 'ETH', address: keyInfo.evmAddress, scale: 18 },
        run: () => fetchEvmEth(anvil, nodeType, keyInfo.evmAddress),
      });
      tasks.push({
        identity: { nodeType, family: 'evm', token: 'USDC', address: keyInfo.evmAddress, scale: 6 },
        run: () => fetchEvmUsdc(anvil, usdcAddress, nodeType, keyInfo.evmAddress),
      });
      if (nodeType === 'mill' && keyInfo.solanaAddress) {
        const solAddr = keyInfo.solanaAddress;
        tasks.push({
          identity: { nodeType, family: 'solana', token: 'SOL', address: solAddr, scale: 9 },
          run: () => fetchSolana(solanaRpc, nodeType, solAddr),
        });
      }
      if (nodeType === 'mill' && keyInfo.minaAddress) {
        const minaAddr = keyInfo.minaAddress;
        tasks.push({
          identity: { nodeType, family: 'mina', token: 'MINA', address: minaAddr, scale: 9 },
          run: () => fetchMina(minaGraphql, nodeType, minaAddr),
        });
      }
    }

    const results = await Promise.allSettled(tasks.map((t) => t.run()));

    let oldestTs = Number.POSITIVE_INFINITY;
    const entries: WalletBalanceEntry[] = results.map((r, idx) => {
      if (r.status === 'fulfilled') {
        if (r.value.ts < oldestTs) oldestTs = r.value.ts;
        return r.value.entry;
      }
      // Rejection branch: capture the original task identity rather than a fake stub.
      const { nodeType, family, token, address, scale } = tasks[idx]!.identity;
      const reason = r.reason instanceof Error ? r.reason.message : 'internal_error';
      return unavailable(nodeType, family, token, address, scale, reason);
    });

    // AC-2: cache-hit returns same `ts`. Use the oldest cached entry's ts so
    // back-to-back cached requests yield identical timestamps.
    const ts = oldestTs === Number.POSITIVE_INFINITY ? Date.now() : oldestTs;
    const payload: WalletBalancesPayload = { entries, ts };
    return payload;
  });
}
