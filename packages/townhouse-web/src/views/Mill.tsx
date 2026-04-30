import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Shell } from '@/components/primitives/Shell';
import { StatusDot } from '@/components/primitives/StatusDot';
import { TypeChip } from '@/components/primitives/TypeChip';
import { MetricBlock } from '@/components/primitives/MetricBlock';
import { StateShell } from '@/components/primitives/StateShell';
import { Button, buttonVariants } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import { LiquidityBar } from '@/components/primitives/LiquidityBar';
import { PairChip } from '@/components/primitives/PairChip';
import { useNodeMetrics } from '@/hooks/useNodeMetrics';
import { usePacketTimeseries } from '@/hooks/usePacketTimeseries';
import { useNodeHealth } from '@/hooks/useNodeHealth';
import { useMillSwapsRecent, type SwapByPairEntry } from '@/hooks/useMillSwapsRecent';
import { chainFamilyOf } from '@/lib/chain';
import { formatVolume } from '@/lib/format-volume';
import { ThroughputChart } from '@/components/charts/ThroughputChart';
import { AddFunds } from '@/components/AddFunds';
import type { NodeInfo } from '@toon-protocol/townhouse';
import { colors } from '@/theme/tokens';

// ── Types ────────────────────────────────────────────────────────────────────

interface SwapPairShape {
  from: { assetCode: string; assetScale?: number; chain: string };
  to: { assetCode: string; assetScale?: number; chain: string };
  rate?: string;
}

interface MillHealthShape {
  status: string;
  swapPairs?: SwapPairShape[];
  inventory?: Record<string, string>;
  inventoryAvailable?: Record<string, string>;
  /** Chain *family* identifiers per `MillChainKind` ('evm' | 'mina' | 'solana'). */
  chains?: Array<'evm' | 'mina' | 'solana'>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// formatVolume extracted to @/lib/format-volume (shared with DVM view)

interface ChainResolution {
  family: 'evm' | 'mina' | 'solana';
  fullChain: string;
  assetCode: string;
  invKey: string;
  total: bigint;
  available: bigint;
}

/**
 * Map a chain family from `MillHealthResponse.chains` to the matching
 * full-chain identifier in the swap pairs (e.g. 'evm' → 'evm:8453'), so
 * `inventory[invKey]` lookups land on the right entry. The Mill emits
 * inventory keyed by `${assetCode}:${fullChain}` and (for single-asset chains)
 * also by `${fullChain}` alone.
 */
function resolveChain(
  family: 'evm' | 'mina' | 'solana',
  swapPairs: SwapPairShape[],
  inventory: Record<string, string>,
  inventoryAvailable: Record<string, string>
): ChainResolution | null {
  // Find any swap pair whose `from` or `to` chain belongs to this family.
  for (const pair of swapPairs) {
    if (chainFamilyOf(pair.from.chain) === family) {
      const fullChain = pair.from.chain;
      const assetCode = pair.from.assetCode;
      return buildResolution(family, fullChain, assetCode, inventory, inventoryAvailable);
    }
    if (chainFamilyOf(pair.to.chain) === family) {
      const fullChain = pair.to.chain;
      const assetCode = pair.to.assetCode;
      return buildResolution(family, fullChain, assetCode, inventory, inventoryAvailable);
    }
  }
  return null;
}

function buildResolution(
  family: 'evm' | 'mina' | 'solana',
  fullChain: string,
  assetCode: string,
  inventory: Record<string, string>,
  inventoryAvailable: Record<string, string>
): ChainResolution {
  const invKey = `${assetCode}:${fullChain}`;
  const totalStr = inventory[invKey] ?? inventory[fullChain] ?? '0';
  const availStr = inventoryAvailable[invKey] ?? inventoryAvailable[fullChain] ?? '0';
  let total = 0n;
  let available = 0n;
  try { total = BigInt(totalStr); } catch { /* noop */ }
  try { available = BigInt(availStr); } catch { /* noop */ }
  return { family, fullChain, assetCode, invKey, total, available };
}

/** Sum all `byPair.volume` entries as a bigint. */
function sumByPairVolume(byPair: SwapByPairEntry[] | undefined): bigint {
  if (!byPair) return 0n;
  let total = 0n;
  for (const entry of byPair) {
    try { total += BigInt(entry.volume); } catch { /* skip */ }
  }
  return total;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface MillFeeSliderProps {
  nodeId: string;
  initialFee: number;
  /** 5-minute volume from `useMillSwapsRecent`, scaled to display units. */
  volumeDisplay: number | null;
  onApply: (fee: number) => Promise<void>;
  isRestarting: boolean;
}

function MillFeeSlider({
  nodeId,
  initialFee,
  volumeDisplay,
  onApply,
  isRestarting,
}: MillFeeSliderProps) {
  const [fee, setFee] = useState(initialFee);
  const [isDirty, setIsDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!isDirty) setFee(initialFee);
  }, [initialFee, isDirty]);

  const handleApply = async () => {
    setApplying(true);
    setError(null);
    setSuccess(false);
    try {
      await onApply(fee);
      setSuccess(true);
      setIsDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply fee');
    } finally {
      setApplying(false);
    }
  };

  const label = `Swap fee for ${nodeId} (basis points)`;
  const statusText = isRestarting
    ? 'Applying fee — connector restarting…'
    : success
      ? 'Updated.'
      : error ?? null;

  // AC-16: earnings preview below the slider — `volume × fee / 10000`,
  // computed from the current 5-minute volume.
  const earningsPreview =
    volumeDisplay !== null && volumeDisplay > 0
      ? `Approx earnings at current fee: ~${((volumeDisplay * fee) / 10000).toFixed(4)}`
      : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Input
          variant="slider"
          label={label}
          value={fee}
          min={0}
          max={10000}
          step={1}
          onChange={(_e, v) => { setFee(v); setSuccess(false); setIsDirty(true); }}
          aria-label={label}
        />
        <span className="font-geist-mono min-w-[4rem] text-right text-sm tabular-nums text-ink">
          {fee} bps
        </span>
        <Button
          variant="primary"
          onClick={handleApply}
          disabled={applying || isRestarting}
        >
          Apply
        </Button>
      </div>
      {earningsPreview && (
        <p className="font-geist-mono text-xs text-ink/50">{earningsPreview}</p>
      )}
      {statusText && (
        <p className={`text-xs ${error ? 'text-red-500' : 'text-ink/60'}`}>
          {statusText}
        </p>
      )}
    </div>
  );
}

interface MillCardProps {
  node: NodeInfo;
  isRestarting: boolean;
  onApplyFee: (nodeId: string, fee: number) => Promise<void>;
}

function MillCard({ node, isRestarting, onApplyFee }: MillCardProps) {
  const nodeId = node.id;

  const { metrics, refetch: refetchMetrics } = useNodeMetrics({ nodeType: node.type });
  const { buckets, status: chartStatus } = usePacketTimeseries({ nodeType: 'mill' });
  const { health } = useNodeHealth<MillHealthShape>({ nodeId });
  const { data: swapsRecent, refetch: refetchSwaps } = useMillSwapsRecent({
    nodeId,
    windowSec: 300,
  });

  // Rebal-pulse: detect inventory delta per inventory key (e.g. 'USDC:evm:8453').
  const prevInventoryRef = useRef<Record<string, string>>({});
  const [pulseChains, setPulseChains] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!health?.inventoryAvailable) return;
    const current = health.inventoryAvailable;
    const prev = prevInventoryRef.current;
    const pulsing = new Set<string>();
    for (const [key, val] of Object.entries(current)) {
      if (prev[key] !== undefined && prev[key] !== val) {
        pulsing.add(key);
      }
    }
    if (pulsing.size > 0) {
      setPulseChains(pulsing);
      const timer = setTimeout(() => setPulseChains(new Set()), 1000);
      prevInventoryRef.current = { ...current };
      return () => clearTimeout(timer);
    }
    prevInventoryRef.current = { ...current };
  }, [health?.inventoryAvailable]);

  const cardState: 'loading' | 'ready' | 'error' | 'empty' = isRestarting ? 'loading' : 'ready';

  const swapPairs: SwapPairShape[] = health?.swapPairs ?? [];
  const inventory = health?.inventory ?? {};
  const inventoryAvailable = health?.inventoryAvailable ?? {};
  const chainFamilies = health?.chains ?? [];

  // Derive a default assetScale from the first swap pair (USDC scale 6 if absent).
  const assetScaleDefault = swapPairs[0]?.from.assetScale ?? 6;

  // Sum of in-flight swap volume across all pairs in the 5-minute window.
  // AC-13: `inActiveSwaps` per-chain is computed by attributing this sum to
  // chains whose pair appears in `byPair`. Since `byPair` keys by ILP address
  // (which doesn't directly carry a chain), we apportion the total volume
  // proportionally to each chain's `total` size.
  const totalInFlightVolume = sumByPairVolume(swapsRecent?.byPair);

  // Resolve each chain family to its full-chain identifier, asset code, and
  // inventory entries up-front so we can compute totals for proportional
  // in-flight allocation.
  const resolvedChains = chainFamilies
    .map((family) => resolveChain(family, swapPairs, inventory, inventoryAvailable))
    .filter((r): r is ChainResolution => r !== null);
  const summedTotal = resolvedChains.reduce((acc, r) => acc + r.total, 0n);

  // 5-minute volume in display units (used by the slider's earnings preview).
  const volumeDisplay = swapsRecent
    ? Number(formatVolume(swapsRecent.volume, assetScaleDefault))
    : null;
  const averageVolume =
    swapsRecent && swapsRecent.count > 0
      ? volumeDisplay !== null
        ? volumeDisplay / swapsRecent.count
        : null
      : null;

  return (
    <article
      className="shadow-border flex flex-col gap-4 rounded-lg bg-canvas p-5"
      aria-label={`${nodeId} mill node`}
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusDot
            state={node.state === 'running' ? 'ok' : node.state === 'stopped' ? 'down' : 'degraded'}
            aria-label={`${nodeId} status: ${node.state}`}
          />
          <span className="font-geist-mono text-sm text-ink">{nodeId}</span>
        </div>
        <TypeChip type="mill" />
      </header>

      <StateShell state={cardState}>
        <div className="flex flex-col gap-4">
          {/* Active swaps + 5-min volume */}
          <div className="flex flex-wrap gap-4">
            <MetricBlock
              value={swapsRecent?.count ?? '—'}
              label="Active swaps"
              variant="compact"
              aria-label={swapsRecent == null ? 'metric unavailable' : undefined}
            />
            <MetricBlock
              value={swapsRecent ? formatVolume(swapsRecent.volume, assetScaleDefault) : '—'}
              label="Volume (5m)"
              variant="compact"
              aria-label={swapsRecent == null ? 'metric unavailable' : undefined}
            />
          </div>

          {/* LiquidityBar per chain */}
          {resolvedChains.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="font-geist-sans text-xs text-ink/50">Liquidity</p>
              {resolvedChains.map((r) => {
                // Apportion in-flight swap volume to this chain proportional
                // to its share of total inventory; cap to (total - available).
                const proportional = summedTotal > 0n
                  ? (totalInFlightVolume * r.total) / summedTotal
                  : 0n;
                const headroom = r.total > r.available ? r.total - r.available : 0n;
                const inActiveSwaps = proportional > headroom ? headroom : proportional;
                const allocated = headroom > inActiveSwaps ? headroom - inActiveSwaps : 0n;

                return (
                  <LiquidityBar
                    key={r.fullChain}
                    allocated={allocated}
                    inActiveSwaps={inActiveSwaps}
                    available={r.available}
                    total={r.total}
                    chainLabel={r.fullChain}
                    assetCode={r.assetCode}
                    pulse={pulseChains.has(r.invKey) || pulseChains.has(r.fullChain)}
                  />
                );
              })}
            </div>
          )}

          {/* PairChip row */}
          <div>
            <p className="font-geist-sans mb-1 text-xs text-ink/50">Swap pairs</p>
            <StateShell
              state={swapPairs.length === 0 ? 'empty' : 'ready'}
              emptySlot={<p className="text-xs text-ink/40">No swap pairs configured.</p>}
            >
              <div className="flex flex-wrap gap-2 overflow-x-auto">
                {swapPairs.map((p, i) => (
                  <PairChip
                    key={i}
                    from={{ asset: p.from.assetCode, chain: p.from.chain }}
                    to={{ asset: p.to.assetCode, chain: p.to.chain }}
                    rate={p.rate}
                  />
                ))}
              </div>
            </StateShell>
          </div>

          {/* Volume chart */}
          <div>
            <p className="font-geist-sans mb-1 text-xs text-ink/50">Swap volume per hour</p>
            {(() => {
              const cnt = swapsRecent?.count ?? 0;
              const STABLE_THRESHOLD = 3;
              const earningsEst =
                metrics.currentFee !== null &&
                averageVolume !== null &&
                cnt >= STABLE_THRESHOLD &&
                buckets.length > 0
                  ? `Approx earnings at current fee: ~${((cnt * averageVolume * metrics.currentFee) / 10000).toFixed(4)}`
                  : cnt > 0 && metrics.currentFee !== null
                    ? 'Approx earnings at current fee: —'
                    : null;
              return (
                <ThroughputChart
                  buckets={buckets}
                  status={chartStatus}
                  count={cnt}
                  color={colors.type.mill}
                  earningsEst={earningsEst}
                />
              );
            })()}
          </div>

          {/* Fee slider */}
          <div>
            <p className="font-geist-sans mb-1 text-xs text-ink/50">Swap fee</p>
            <MillFeeSlider
              nodeId={nodeId}
              initialFee={metrics.currentFee ?? 0}
              volumeDisplay={volumeDisplay}
              onApply={async (fee) => {
                await onApplyFee(nodeId, fee);
                refetchMetrics();
                refetchSwaps();
              }}
              isRestarting={isRestarting}
            />
          </div>

          {/* Add Funds */}
          <AddFunds nodeId={nodeId} />
        </div>
      </StateShell>
    </article>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function MillView() {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loadStatus, setLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [isRestarting, setIsRestarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);

    async function load() {
      try {
        const res = await fetch('/api/nodes', { signal: controller.signal });
        if (!res.ok) throw new Error(`GET /api/nodes failed: ${res.status}`);
        const all = await res.json() as NodeInfo[];
        if (cancelled) return;
        const millNodes = all.filter((n) => n.type === 'mill' && n.enabled);
        setNodes(millNodes);
        setLoadStatus('ready');
      } catch {
        if (cancelled) return;
        setLoadStatus('error');
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
  }, []);

  // Connector restart awareness (mirror Town.tsx pattern)
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let backoffMs = 1_000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/api/metrics`;

    function connect() {
      if (closed) return;
      ws = new WebSocket(wsUrl);

      ws.addEventListener('message', (event) => {
        backoffMs = 1_000;
        try {
          type Msg = { type: string; messages?: { type: string }[] };
          const msg = JSON.parse(String(event.data)) as Msg;

          function handle(m: { type: string }) {
            if (m.type === 'connectorRestarting') setIsRestarting(true);
            if (m.type === 'connectorRestarted') setIsRestarting(false);
          }

          if (msg.type === 'batch' && msg.messages) {
            msg.messages.forEach(handle);
          } else {
            handle(msg);
          }
        } catch { /* ignore malformed */ }
      });

      ws.addEventListener('error', () => {});

      ws.addEventListener('close', () => {
        if (closed) return;
        setIsRestarting(false);
        const delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, 30_000);
        reconnectTimer = setTimeout(connect, delay);
      });
    }

    connect();

    return () => {
      closed = true;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* best-effort */ }
    };
  }, []);

  async function handleApplyFee(_nodeId: string, fee: number) {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`/api/nodes/mill/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feeBasisPoints: fee }),
      });

      if (res.ok) return;

      if (res.status === 409 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const body = await res.json() as { message?: string };
      lastError = new Error(body.message ?? `PATCH failed: ${res.status}`);
      break;
    }

    if (lastError) {
      // Note: don't reset `isRestarting` here — that state is owned by the WS
      // handler, racing it can stomp a legitimate concurrent restart.
      throw lastError;
    }
  }

  const uiState: 'loading' | 'ready' | 'error' | 'empty' =
    loadStatus === 'loading' ? 'loading' :
    loadStatus === 'error' ? 'error' :
    nodes.length === 0 ? 'empty' : 'ready';

  return (
    <Shell
      header={
        <div className="flex items-center justify-between gap-3">
          <span className="font-semibold tracking-tight-16">Mill nodes</span>
          <Link to="/" className="font-geist-sans text-xs text-ink/50 hover:text-ink">
            ← Dashboard
          </Link>
        </div>
      }
    >
      <div className="mx-auto max-w-6xl">
        <h1 className="font-geist-sans tracking-tight-32 mb-6 text-2xl font-semibold text-ink">
          Mill swap instances
        </h1>

        <StateShell
          state={uiState}
          emptySlot={
            <div
              role="status"
              className="flex flex-col items-center justify-center gap-4 py-16 text-center"
            >
              <p className="font-geist-sans max-w-md text-sm text-ink/60">
                No Mill nodes are enabled. Enable one on the Home dashboard.
              </p>
              <Link to="/" className={buttonVariants({ variant: 'primary' })}>
                Go to Dashboard
              </Link>
            </div>
          }
          errorSlot={
            <div
              role="alert"
              className="flex flex-col items-center justify-center gap-4 py-16 text-center"
            >
              <p className="font-geist-sans max-w-md text-sm text-ink">
                Could not load Mill nodes. Is{' '}
                <code className="font-geist-mono text-xs">pnpm dev:docker</code> running?
              </p>
              <Button variant="secondary" onClick={() => window.location.reload()}>
                Retry
              </Button>
            </div>
          }
        >
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {nodes.map((node) => (
              <MillCard
                key={node.id}
                node={node}
                isRestarting={isRestarting}
                onApplyFee={handleApplyFee}
              />
            ))}
          </div>
        </StateShell>
      </div>
    </Shell>
  );
}
