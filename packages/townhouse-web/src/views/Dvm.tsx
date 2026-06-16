import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Shell } from '@/components/primitives/Shell';
import { StatusDot } from '@/components/primitives/StatusDot';
import { TypeChip } from '@/components/primitives/TypeChip';
import { MetricBlock } from '@/components/primitives/MetricBlock';
import { StateShell } from '@/components/primitives/StateShell';
import { Button, buttonVariants } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import { BreakdownPill } from '@/components/primitives/BreakdownPill';
import { ThroughputChart } from '@/components/charts/ThroughputChart';
import { AddFunds } from '@/components/AddFunds';
import { useNodeMetrics } from '@/hooks/useNodeMetrics';
import { usePacketTimeseries } from '@/hooks/usePacketTimeseries';
import { useNodeHealth } from '@/hooks/useNodeHealth';
import { useDvmJobsRecent } from '@/hooks/useDvmJobsRecent';
import { formatVolume } from '@/lib/format-volume';
import type { NodeInfo } from '@toon-protocol/hub';
import type { DvmHealthResponse } from '@toon-protocol/sdk';
import { colors } from '@/theme/tokens';

// ── Constants ─────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<number, string> = {
  5094: 'Arweave',
  5250: 'Dungeon',
};

// Asset scale 6 for USDC
const USDC_SCALE = 6;

// ── Sub-components ────────────────────────────────────────────────────────────

interface DvmFeeSliderProps {
  kind: number;
  initialValue: number;
  /** Override the auto-derived label (used by the no-handlerKinds fallback). */
  labelOverride?: string;
  onApply: (kind: number, value: number) => Promise<void>;
  isRestarting: boolean;
}

function DvmFeeSlider({ kind, initialValue, labelOverride, onApply, isRestarting }: DvmFeeSliderProps) {
  const [value, setValue] = useState(initialValue);
  const [isDirty, setIsDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!isDirty) setValue(initialValue);
  }, [initialValue, isDirty]);

  const handleApply = async () => {
    setApplying(true);
    setError(null);
    setSuccess(false);
    try {
      await onApply(kind, value);
      setSuccess(true);
      setIsDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply');
    } finally {
      setApplying(false);
    }
  };

  const kindLabel =
    labelOverride ??
    (KIND_LABELS[kind] ? `Fee for ${KIND_LABELS[kind]} (kind:${kind})` : `Fee for kind:${kind}`);
  const statusText = isRestarting
    ? 'Applying — connector restarting…'
    : success
      ? 'Updated.'
      : error ?? null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Input
          variant="slider"
          label={kindLabel}
          value={value}
          min={0}
          max={10000}
          step={1}
          onChange={(_e, v) => { setValue(v); setSuccess(false); setIsDirty(true); }}
          aria-label={kindLabel}
        />
        <span className="font-geist-mono min-w-[4rem] text-right text-sm tabular-nums text-ink">
          {value}
        </span>
        <Button
          variant="primary"
          onClick={handleApply}
          disabled={applying || isRestarting}
        >
          Apply
        </Button>
      </div>
      {statusText && (
        <p className={`text-xs ${error ? 'text-red-500' : 'text-ink/60'}`}>
          {statusText}
        </p>
      )}
    </div>
  );
}

interface DvmCardProps {
  node: NodeInfo;
  isRestarting: boolean;
  onApplyKindFee: (nodeId: string, kind: number, value: number) => Promise<void>;
}

function DvmCard({ node, isRestarting, onApplyKindFee }: DvmCardProps) {
  const nodeId = node.id;

  const { metrics, refetch: refetchMetrics } = useNodeMetrics({ nodeType: node.type });
  const { buckets, status: chartStatus } = usePacketTimeseries({ nodeType: 'dvm' });
  const { health, refetch: refetchHealth } = useNodeHealth<DvmHealthResponse>({ nodeId });
  const { data: jobsRecent, refetch: refetchJobs } = useDvmJobsRecent({
    nodeId,
    windowSec: 300,
  });

  const dotState = (() => {
    if (!health) return 'unknown' as const;
    if (health.status === 'ok') return 'ok' as const;
    if (health.status === 'starting') return 'unknown' as const;
    return 'degraded' as const;
  })();

  const handlerKinds = health?.handlerKinds ?? [];
  const kindPricing = health?.kindPricing ?? {};
  const feePerJobFallback = metrics.currentFee ?? 0;

  const activeJobs = jobsRecent?.byStatus.processing ?? 0;
  const totalJobs = jobsRecent?.count ?? 0;
  const completedJobs = jobsRecent?.byStatus.success ?? 0;
  const failedJobs = jobsRecent?.byStatus.error ?? 0;

  const revenueFormatted = jobsRecent
    ? formatVolume(jobsRecent.volume, USDC_SCALE)
    : null;
  const revenueIsZero =
    !revenueFormatted || revenueFormatted === '0' || revenueFormatted === '0.00';

  const jobsQueueEmpty = totalJobs === 0;

  // Earnings estimate for chart — AC-18: count × averageVolume × kindPricing[primaryKind] / 1_000_000.
  // averageVolume is derived from `jobs/recent` (totalVolume / totalJobs).
  const primaryKind = jobsRecent?.byKind.reduce(
    (max, e) => (e.count > (max?.count ?? 0) ? e : max),
    null as { kind: number; count: number; volume: string } | null
  );
  // Read raw kindPricing through nullish-coalescing so a legitimate "free"
  // ('0') stays 0 instead of being silently bumped up to feePerJobFallback.
  const rawPrimaryFee =
    primaryKind != null ? kindPricing[String(primaryKind.kind)] : undefined;
  const primaryKindFee =
    rawPrimaryFee != null ? Number(rawPrimaryFee) : feePerJobFallback;

  let averageVolumeBig = 0n;
  if (jobsRecent && jobsRecent.count > 0) {
    try {
      averageVolumeBig = BigInt(jobsRecent.volume) / BigInt(jobsRecent.count);
    } catch {
      averageVolumeBig = 0n;
    }
  }

  const STABLE_THRESHOLD = 3;
  const earningsEst = (() => {
    if (totalJobs < STABLE_THRESHOLD || primaryKindFee <= 0) return null;
    if (averageVolumeBig === 0n) {
      // Counts are stable but no volume data yet — render placeholder
      // rather than a misleading numeric estimate.
      return 'Approx earnings at current fee: —';
    }
    // BigInt domain throughout to preserve precision for large fees/volumes.
    // (count × averageVolume × kindPricing[primaryKind]) / 1_000_000
    const num =
      BigInt(totalJobs) *
      averageVolumeBig *
      BigInt(Math.max(0, Math.trunc(primaryKindFee)));
    const usdcDisplay = formatVolume(num.toString(), USDC_SCALE + 6);
    return `Approx earnings at current fee: ~${usdcDisplay} USDC`;
  })();

  return (
    <div className="shadow-border flex flex-col gap-6 rounded-xl bg-canvas p-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <StatusDot state={dotState} />
        <span className="font-geist-mono text-sm text-ink">{nodeId}</span>
        <TypeChip type="dvm" />
      </div>

      {/* Top metrics */}
      <div className="flex gap-4">
        <MetricBlock
          value={activeJobs > 0 ? String(activeJobs) : '—'}
          label="Active jobs"
        />
        <MetricBlock
          value={revenueFormatted && !revenueIsZero ? `${revenueFormatted} USDC` : '—'}
          label="Revenue (5m)"
        />
      </div>

      {/* Job queue counters */}
      <StateShell
        state={jobsQueueEmpty ? 'empty' : 'ready'}
        emptySlot={
          <p className="text-xs text-ink/40">No jobs in the last 5 minutes.</p>
        }
      >
        <div className="flex gap-4">
          <MetricBlock value={String(activeJobs)} label="Active" />
          <MetricBlock value={String(completedJobs)} label="Completed" />
          <MetricBlock value={String(failedJobs)} label="Failed" />
        </div>
      </StateShell>

      {/* Handler kinds row — TypeChip-style accent-tinted badges */}
      {handlerKinds.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {handlerKinds.map((kind) => (
            <span
              key={kind}
              className="font-geist-mono bg-type-dvm/10 text-type-dvm inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium tracking-wider"
            >
              kind:{kind}{KIND_LABELS[kind] ? ` ${KIND_LABELS[kind]}` : ''}
            </span>
          ))}
        </div>
      )}

      {/* Per-kind pricing sliders. AC-17: refetch health + jobs after a
          successful PATCH so the slider's initialValue picks up the new
          server-side state without waiting for the next 5 s poll tick. */}
      {(() => {
        const apply = async (kind: number, value: number) => {
          await onApplyKindFee(nodeId, kind, value);
          await Promise.all([
            refetchHealth(),
            refetchJobs(),
            Promise.resolve(refetchMetrics()),
          ]);
        };
        return handlerKinds.length > 0 ? (
          <div className="flex flex-col gap-4">
            <p className="font-geist-sans text-xs text-ink/50">Job pricing</p>
            {handlerKinds.map((kind) => {
              // Read kindPricing through nullish-coalescing so a legitimate
              // "free" ('0') stays 0 instead of being silently bumped up.
              const raw = kindPricing[String(kind)];
              const currentVal = raw != null ? Number(raw) : feePerJobFallback;
              return (
                <DvmFeeSlider
                  key={kind}
                  kind={kind}
                  initialValue={currentVal}
                  onApply={apply}
                  isRestarting={isRestarting}
                />
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="font-geist-sans text-xs text-ink/50">Job pricing</p>
            <DvmFeeSlider
              // -1 sentinel = "no specific kind"; the apply handler will
              // send `{ feePerJob }` instead of `{ kindPricing[…] }`. The
              // label override prevents the slider from rendering "Fee for
              // kind:0", which would lie about what the slider changes.
              kind={-1}
              labelOverride="Fee per job (no handler kinds reported)"
              initialValue={feePerJobFallback}
              onApply={apply}
              isRestarting={isRestarting}
            />
          </div>
        );
      })()}

      {/* Jobs-per-hour chart */}
      <div>
        <p className="font-geist-sans mb-1 text-xs text-ink/50">Jobs per hour</p>
        <ThroughputChart
          buckets={buckets}
          status={chartStatus}
          count={totalJobs}
          color={colors.type.dvm}
          earningsEst={earningsEst}
        />
      </div>

      {/* BreakdownPill: Revenue vs Storage cost vs Net.
          Per AC-19, when revenue is zero or unavailable all values render
          as "—" (the truthy `formatVolume('0', 6) === '0'` would otherwise
          render "0 USDC", which the AC explicitly forbids). */}
      <BreakdownPill
        segments={[
          {
            label: 'Revenue 5m',
            value: revenueFormatted && !revenueIsZero ? `${revenueFormatted} USDC` : '—',
            tone: revenueFormatted && !revenueIsZero ? 'positive' : 'neutral',
          },
          {
            label: 'Storage cost',
            value: '—',
            tone: 'neutral',
          },
          {
            label: 'Net',
            value: revenueFormatted && !revenueIsZero ? `${revenueFormatted} USDC` : '—',
            tone: revenueFormatted && !revenueIsZero ? 'positive' : 'neutral',
          },
        ]}
      />
      <p className="font-geist-sans text-xs text-ink/40">
        Operator pays Turbo bundlers separately. Storage cost tracking coming in a future release.
      </p>

      {/* Add Funds */}
      <AddFunds nodeId={nodeId} />
    </div>
  );
}

// ── View ─────────────────────────────────────────────────────────────────────

export function DvmView() {
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
        const dvmNodes = all.filter((n) => n.type === 'dvm' && n.enabled);
        setNodes(dvmNodes);
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

  // Connector restart awareness — mirrors Mill.tsx pattern
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
          interface Msg { type: string; messages?: { type: string }[] }
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

      ws.addEventListener('error', () => {
        /* errors surface via onclose */
      });

      ws.addEventListener('close', () => {
        if (closed) return;
        // Note: do NOT clear `isRestarting` on WS close. The flag is owned
        // by the explicit `connectorRestarted` message; clearing it here
        // races with a real in-flight connector restart (network jitter
        // dropping the WS would prematurely unblock Apply).
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

  async function handleApplyKindFee(nodeId: string, kind: number, value: number) {
    void nodeId; // future: per-instance PATCH (deferred — see deferred-work.md)
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const body = kind >= 0
        ? { kindPricing: { [String(kind)]: value } }
        : { feePerJob: value };

      const res = await fetch('/api/nodes/dvm/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) return;

      if (res.status === 409 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      // Server may not return JSON (e.g. proxy 502 with HTML body); fall
      // back to a status-code message rather than letting res.json() throw
      // an unhandled rejection.
      let message: string | undefined;
      try {
        const respBody = await res.json() as { message?: string };
        message = respBody.message;
      } catch {
        message = undefined;
      }
      lastError = new Error(message ?? `PATCH failed: ${res.status}`);
      break;
    }

    if (lastError) throw lastError;
  }

  const uiState: 'loading' | 'ready' | 'error' | 'empty' =
    loadStatus === 'loading' ? 'loading' :
    loadStatus === 'error' ? 'error' :
    nodes.length === 0 ? 'empty' : 'ready';

  return (
    <Shell
      header={
        <div className="flex items-center justify-between gap-3">
          <span className="font-semibold tracking-tight-16">DVM nodes</span>
          <Link to="/" className="font-geist-sans text-xs text-ink/50 hover:text-ink">
            ← Dashboard
          </Link>
        </div>
      }
    >
      <div className="mx-auto max-w-6xl">
        <h1 className="font-geist-sans tracking-tight-32 mb-6 text-2xl font-semibold text-ink">
          DVM compute instances
        </h1>

        <StateShell
          state={uiState}
          emptySlot={
            <div
              role="status"
              className="flex flex-col items-center justify-center gap-4 py-16 text-center"
            >
              <p className="font-geist-sans max-w-md text-sm text-ink/60">
                No DVM nodes are enabled. Enable one on the Home dashboard.
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
                Could not load DVM nodes. Is{' '}
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
              <DvmCard
                key={node.id}
                node={node}
                isRestarting={isRestarting}
                onApplyKindFee={handleApplyKindFee}
              />
            ))}
          </div>
        </StateShell>
      </div>
    </Shell>
  );
}
