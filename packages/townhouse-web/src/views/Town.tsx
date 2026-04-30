import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Shell } from '@/components/primitives/Shell';
import { StatusDot } from '@/components/primitives/StatusDot';
import { TypeChip } from '@/components/primitives/TypeChip';
import { MetricBlock } from '@/components/primitives/MetricBlock';
import { StateShell } from '@/components/primitives/StateShell';
import { Button, buttonVariants } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  type ChartConfig,
} from '@/charts';
import { useRelayEventStream } from '@/hooks/useRelayEventStream';
import { useNodeMetrics } from '@/hooks/useNodeMetrics';
import { usePacketTimeseries } from '@/hooks/usePacketTimeseries';
import type {
  NodeInfo,
  NostrEventPayload,
  BandwidthPayload,
  TimeseriesBucket,
} from '@toon-protocol/townhouse';
import { colors } from '@/theme/tokens';

// ── Constants ─────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<number, string> = {
  0: 'meta',
  1: 'note',
  6: 'repost',
  7: 'reaction',
  9735: 'zap',
};

const FILTERABLE_KINDS = [1, 0, 7, 6, 9735];

const CHART_CONFIG: ChartConfig = {
  count: {
    label: 'Events/hr',
    color: colors.type.town,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatEventTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface EventFeedProps {
  nodeId: string;
  wsUrl?: string;
}

function EventFeed({ nodeId, wsUrl }: EventFeedProps) {
  const { events, status } = useRelayEventStream({ nodeId, url: wsUrl });
  const [activeKinds, setActiveKinds] = useState<Set<number>>(new Set(FILTERABLE_KINDS));

  const filteredEvents = events.filter((e) => activeKinds.has(e.kind));

  function toggleKind(kind: number) {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  if (status === 'degraded' || status === 'closed') {
    return (
      <div
        role="log"
        aria-live="polite"
        aria-label="Event stream"
        className="flex items-center justify-center py-4 text-sm text-ink/50"
      >
        <span>Could not connect to event stream. The Town container may be down.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Filter chips */}
      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by event kind">
        {FILTERABLE_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => toggleKind(kind)}
            className={[
              'font-geist-mono shadow-border rounded px-2 py-0.5 text-xs transition-colors',
              activeKinds.has(kind)
                ? 'bg-ink text-canvas'
                : 'bg-canvas text-ink/50',
            ].join(' ')}
            aria-pressed={activeKinds.has(kind)}
          >
            kind:{kind}
          </button>
        ))}
      </div>

      {/* Event feed */}
      <div
        role="log"
        aria-live="polite"
        aria-label="Live event feed"
        className="flex flex-col gap-0.5 max-h-48 overflow-y-auto"
      >
        {status === 'connecting' && filteredEvents.length === 0 && (
          <div role="status" className="py-4 text-center text-sm text-ink/40">
            <span className="sr-only">Loading events</span>
            {[...Array(3)].map((_, i) => (
              <div key={i} className="mb-1 h-4 rounded bg-ink/10" aria-hidden="true" />
            ))}
          </div>
        )}

        {status !== 'connecting' && filteredEvents.length === 0 && (
          <p className="py-4 text-center text-sm text-ink/40">
            No events yet — give your relay a moment.
          </p>
        )}

        {filteredEvents.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
}

interface EventRowProps {
  event: NostrEventPayload;
}

function EventRow({ event }: EventRowProps) {
  const kindLabel = KIND_LABELS[event.kind] ?? `kind:${event.kind}`;
  const pubkeyShort = (event.pubkey ?? '').slice(0, 8);
  const contentPreview = (event.content ?? '').slice(0, 200);
  const timeStr = formatEventTime(event.created_at);

  return (
    <div className="flex items-baseline gap-2 py-0.5 text-xs">
      <span className="font-geist-mono shrink-0 text-ink/50">{timeStr}</span>
      <span
        className="font-geist-mono shrink-0 rounded bg-ink/5 px-1"
        aria-label={`Event kind: ${kindLabel}`}
      >
        {kindLabel}
      </span>
      <span className="font-geist-mono shrink-0 text-ink/40">{pubkeyShort}</span>
      <span className="font-geist-sans min-w-0 truncate text-ink/70">{contentPreview}</span>
    </div>
  );
}

interface BandwidthBlocksProps {
  bandwidth: BandwidthPayload | null;
}

function BandwidthBlocks({ bandwidth }: BandwidthBlocksProps) {
  return (
    <div className="flex gap-4">
      <MetricBlock
        value={bandwidth ? formatBytes(bandwidth.bytesIn) : '—'}
        label="Bytes in"
        variant="compact"
        aria-label={bandwidth ? undefined : 'metric unavailable'}
      />
      <MetricBlock
        value={bandwidth ? formatBytes(bandwidth.bytesOut) : '—'}
        label="Bytes out"
        variant="compact"
        aria-label={bandwidth ? undefined : 'metric unavailable'}
      />
    </div>
  );
}

interface EventsChartProps {
  buckets: TimeseriesBucket[];
  status: 'loading' | 'ready' | 'error' | 'unavailable';
}

function EventsChart({ buckets, status }: EventsChartProps) {
  if (status === 'loading') {
    return (
      <div className="flex h-24 items-center justify-center" role="status" aria-label="Loading chart">
        <svg className="h-5 w-5 animate-spin text-ink/30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="31.4 31.4" />
        </svg>
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <p className="py-2 text-xs text-ink/40">
        Events-per-hour chart requires connector v3.4+ (endpoint not yet available).
      </p>
    );
  }

  if (status === 'error') {
    return (
      <p className="py-2 text-xs text-ink/40">
        Could not load chart data.
      </p>
    );
  }

  const chartData = buckets.map((b) => ({
    ts: new Date(b.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    count: b.count,
  }));

  return (
    <ChartContainer config={CHART_CONFIG} className="h-24">
      <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
        <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} width={28} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line
          type="monotone"
          dataKey="count"
          stroke={colors.type.town}
          strokeWidth={1.5}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

interface FeeSliderProps {
  nodeId: string;
  initialFee: number;
  onApply: (fee: number) => Promise<void>;
  isRestarting: boolean;
}

function FeeSlider({ nodeId, initialFee, onApply, isRestarting }: FeeSliderProps) {
  const [fee, setFee] = useState(initialFee);
  const [isDirty, setIsDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Sync with the server-fetched fee when the user hasn't touched the slider yet.
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
      setIsDirty(false);  // allow server-sync again after a successful apply
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply fee');
    } finally {
      setApplying(false);
    }
  };

  const label = `Write fee for ${nodeId} (0–10000 sats)`;
  const statusText = isRestarting
    ? 'Applying fee — connector restarting…'
    : success
      ? 'Updated.'
      : error ?? null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Input
          variant="slider"
          label={label}
          value={fee}
          min={0}
          max={10000}
          step={100}
          onChange={(_e, v) => { setFee(v); setSuccess(false); setIsDirty(true); }}
          aria-label={label}
        />
        <span className="font-geist-mono min-w-[4rem] text-right text-sm tabular-nums text-ink">
          {fee} sats
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

interface TownCardProps {
  node: NodeInfo;
  isRestarting: boolean;
  onApplyFee: (nodeId: string, fee: number) => Promise<void>;
}

function TownCard({ node, isRestarting, onApplyFee }: TownCardProps) {
  const nodeId = node.id;

  const { metrics, refetch: refetchMetrics } = useNodeMetrics({ nodeType: node.type });
  const { buckets, status: chartStatus } = usePacketTimeseries({ nodeType: node.type });

  const cardState: 'loading' | 'ready' | 'error' | 'empty' = isRestarting
    ? 'loading'
    : 'ready';

  return (
    <article
      className="shadow-border flex flex-col gap-4 rounded-lg bg-canvas p-5"
      aria-label={`${nodeId} town node`}
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusDot
            state={node.state === 'running' ? 'ok' : node.state === 'stopped' ? 'down' : 'degraded'}
            aria-label={`${nodeId} status: ${node.state}`}
          />
          <span className="font-geist-mono text-sm text-ink">{nodeId}</span>
        </div>
        <TypeChip type="town" />
      </header>

      <StateShell state={cardState}>
        <div className="flex flex-col gap-4">
          {/* Connected clients + bandwidth */}
          <div className="flex flex-wrap gap-4">
            <MetricBlock
              value={metrics.connectedClients ?? '—'}
              label="Events forwarded"
              variant="compact"
              aria-label={metrics.connectedClients == null ? 'metric unavailable' : undefined}
            />
            <BandwidthBlocks bandwidth={metrics.bandwidth} />
          </div>

          {/* Events-per-hour chart */}
          <div>
            <p className="font-geist-sans mb-1 text-xs text-ink/50">Events per hour</p>
            <EventsChart buckets={buckets} status={chartStatus} />
          </div>

          {/* Live event feed */}
          <div>
            <p className="font-geist-sans mb-1 text-xs text-ink/50">Live events</p>
            <EventFeed nodeId={nodeId} />
          </div>

          {/* Fee config */}
          <div>
            <p className="font-geist-sans mb-1 text-xs text-ink/50">Write fee</p>
            <FeeSlider
              nodeId={nodeId}
              initialFee={metrics.currentFee ?? 0}
              onApply={async (fee) => { await onApplyFee(nodeId, fee); refetchMetrics(); }}
              isRestarting={isRestarting}
            />
          </div>
        </div>
      </StateShell>
    </article>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function TownView() {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loadStatus, setLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [isRestarting, setIsRestarting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/nodes');
        if (!res.ok) throw new Error(`GET /api/nodes failed: ${res.status}`);
        const all = await res.json() as NodeInfo[];
        if (cancelled) return;
        const townNodes = all.filter((n) => n.type === 'town' && n.enabled);
        setNodes(townNodes);
        setLoadStatus('ready');
      } catch {
        if (cancelled) return;
        setLoadStatus('error');
      }
    }

    void load();
    return () => { cancelled = true; };
  }, []);

  // Listen to WS connector restart events for the fee-apply flow (AC-12).
  // Reconnects with exponential backoff so isRestarting never gets stuck true.
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

      ws.addEventListener('error', () => {
        // error is always followed by close — reconnect handled there
      });

      ws.addEventListener('close', () => {
        if (closed) return;
        // Clear stuck restarting state if we missed connectorRestarted
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

  async function handleApplyFee(nodeId: string, fee: number) {
    const node = nodes.find((n) => n.id === nodeId);
    const type = node?.type ?? 'town';
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`/api/nodes/${type}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feePerEvent: fee }),
      });

      if (res.ok) return;

      if (res.status === 409 && attempt === 0) {
        // config_mutation_in_flight — retry once after 1 s
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const body = await res.json() as { message?: string };
      lastError = new Error(body.message ?? `PATCH failed: ${res.status}`);
      break;
    }

    // On PATCH failure the connector restart may never emit connectorRestarted,
    // leaving isRestarting stuck at true. Clear it here so the UI recovers.
    if (lastError) {
      setIsRestarting(false);
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
          <span className="font-semibold tracking-tight-16">Town nodes</span>
          <Link to="/" className="font-geist-sans text-xs text-ink/50 hover:text-ink">
            ← Dashboard
          </Link>
        </div>
      }
    >
      <div className="mx-auto max-w-6xl">
        <h1 className="font-geist-sans tracking-tight-32 mb-6 text-2xl font-semibold text-ink">
          Town relay instances
        </h1>

        <StateShell
          state={uiState}
          emptySlot={
            <div
              role="status"
              className="flex flex-col items-center justify-center gap-4 py-16 text-center"
            >
              <p className="font-geist-sans max-w-md text-sm text-ink/60">
                No Town nodes are enabled. Enable one on the Home dashboard.
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
                Could not load Town nodes. Is{' '}
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
              <TownCard
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
