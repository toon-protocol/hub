import { Link } from 'react-router-dom';
import { Shell } from '@/components/primitives/Shell';
import { StatusDot } from '@/components/primitives/StatusDot';
import { TypeChip } from '@/components/primitives/TypeChip';
import { MetricBlock } from '@/components/primitives/MetricBlock';
import { StateShell } from '@/components/primitives/StateShell';
import { Button } from '@/components/primitives/Button';
import { buttonVariants } from '@/components/primitives/Button';
import { useNodes } from '@/hooks/useNodes';
import { useNodeStatusStream } from '@/hooks/useNodeStatusStream';
import type { StreamConnectionStatus } from '@/hooks/useNodeStatusStream';
import { mapToStatusDot, formatUptime } from '@/lib/node-status';
import type { NodeInfo, NodeType, MetricsPayload } from '@toon-protocol/townhouse';

const NODE_LABELS: Record<NodeType, string> = {
  town: 'town',
  mill: 'mill',
  dvm: 'dvm',
};

/** Management view routes per node type — extended as views ship. */
const VIEW_LINKS: Partial<Record<NodeType, string>> = {
  town: '/town',
  mill: '/mill',
};

interface NodeCardProps {
  node: NodeInfo;
  /** Live raw Docker state from `WS /api/metrics`, if newer than fetch-time state. */
  liveState: string | undefined;
  metrics: MetricsPayload | null | undefined;
}

function NodeCard({ node, liveState, metrics }: NodeCardProps) {
  const effectiveState = liveState ?? node.state;
  const dotState = mapToStatusDot(effectiveState);
  const viewLink = VIEW_LINKS[node.type];

  // AC-4: per-node attribution is not available from the v1 API
  // (`metrics.attribution === 'aggregate'`). Surface the workspace aggregate
  // with a footnote until 21.10 lands packet-log per-node aggregation.
  // TODO(21.10): swap to per-node packet counter when API exposes it.
  let eventsValue: number | string;
  let isAggregate = false;
  let metricUnavailable = false;
  if (metrics == null || metrics.available === false) {
    eventsValue = '—';
    metricUnavailable = true;
  } else {
    eventsValue = metrics.packetsForwarded;
    // Explicit `=== 'aggregate'` (not `!== 'per-peer'`) so a malformed payload
    // missing `attribution` doesn't get a misleading "(all nodes)" footnote.
    isAggregate = metrics.attribution === 'aggregate';
  }

  const uptimeText = formatUptime(node.uptimeSeconds);
  const uptimeAriaLabel = node.uptimeSeconds == null ? 'Uptime: unknown' : `Uptime: ${uptimeText}`;

  return (
    <article
      className="shadow-border flex flex-col gap-4 rounded-lg bg-canvas p-5"
      aria-label={`${NODE_LABELS[node.type]} node`}
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusDot
            state={dotState}
            aria-label={`${NODE_LABELS[node.type]} node status: ${dotState}`}
          />
          <span className="font-geist-mono text-sm text-ink">{node.type}</span>
        </div>
        <div className="flex items-center gap-2">
          {viewLink && (
            <Link
              to={viewLink}
              className="font-geist-sans text-xs text-ink/40 hover:text-ink"
              aria-label={`View ${NODE_LABELS[node.type]} node details`}
            >
              View →
            </Link>
          )}
          <TypeChip type={node.type} />
        </div>
      </header>
      <div className="flex items-end justify-between gap-4">
        <div>
          <MetricBlock
            value={eventsValue}
            label="Events today"
            variant="compact"
            aria-label={metricUnavailable ? 'metric unavailable' : undefined}
          />
          {isAggregate && (
            <span className="font-geist-sans mt-1 block text-xs text-ink/40">
              (all nodes)
            </span>
          )}
        </div>
        <dl className="flex flex-col items-end">
          <dt className="font-geist-sans text-xs text-ink/50">uptime</dt>
          <dd
            className="font-geist-mono tabular-nums text-sm text-ink"
            aria-label={uptimeAriaLabel}
          >
            {uptimeText}
          </dd>
        </dl>
      </div>
    </article>
  );
}

interface HomeHeaderProps {
  transportMode: 'direct' | 'ator' | 'unknown';
  streamStatus: StreamConnectionStatus;
}

function streamStatusToDot(status: StreamConnectionStatus): 'ok' | 'degraded' | 'down' {
  switch (status) {
    case 'open':
      return 'ok';
    case 'degraded':
    case 'connecting':
      return 'degraded';
    case 'closed':
      return 'down';
  }
}

function streamStatusLabel(status: StreamConnectionStatus): string {
  switch (status) {
    case 'open':
      return 'Live updates: connected';
    case 'connecting':
      return 'Live updates: connecting';
    case 'degraded':
      return 'Live updates: degraded — reconnecting';
    case 'closed':
      return 'Live updates: disconnected';
  }
}

function HomeHeader({ transportMode, streamStatus }: HomeHeaderProps) {
  // AC-5: ATOR live-status is a 21.15 surface. Until `GET /api/transport-status`
  // exists (or `/api/nodes` extends with `transportStatus`), this dot reflects
  // only the configured transport mode — not connectivity.
  // TODO(21.15): wire to live ATOR proxy reachability.
  const transportDotState = transportMode === 'unknown' ? 'unknown' : 'ok';
  const transportLabel =
    transportMode === 'ator'
      ? 'ATOR transport: configured'
      : transportMode === 'direct'
        ? 'Direct transport'
        : 'Transport: unknown';

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-semibold tracking-tight-16">Townhouse</span>
      <div className="flex items-center gap-4 text-xs text-ink/60">
        <div className="flex items-center gap-2">
          <span className="font-geist-mono uppercase tracking-wider" aria-hidden="true">
            {transportMode}
          </span>
          <StatusDot state={transportDotState} aria-label={transportLabel} />
        </div>
        <StatusDot
          state={streamStatusToDot(streamStatus)}
          aria-label={streamStatusLabel(streamStatus)}
        />
      </div>
    </div>
  );
}

interface HomeProps {
  /**
   * Override the configured transport mode for testing or storybook.
   * In product mode we default to `'unknown'` rather than guessing — the live
   * Townhouse config is only available once `/api/transport-status` ships
   * in 21.15.
   */
  transportMode?: 'direct' | 'ator' | 'unknown';
}

function NodeCardSkeleton() {
  return (
    <div
      className="shadow-border flex flex-col gap-4 rounded-lg bg-canvas p-5"
      aria-hidden="true"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-ink/10" />
          <span className="h-3 w-12 rounded bg-ink/10" />
        </div>
        <span className="h-5 w-12 rounded-md bg-ink/5" />
      </div>
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <span className="h-6 w-10 rounded bg-ink/10" />
          <span className="h-3 w-20 rounded bg-ink/5" />
        </div>
        <span className="h-3 w-10 rounded bg-ink/5" />
      </div>
    </div>
  );
}

export function Home({ transportMode = 'unknown' }: HomeProps = {}) {
  const { nodes, metricsByType, status, refetch } = useNodes();
  const { statesByName, connectionStatus, reconnect } = useNodeStatusStream();

  const enabledNodes = nodes.filter((n) => n.enabled);

  const uiState =
    status === 'loading'
      ? 'loading'
      : status === 'error'
        ? 'error'
        : enabledNodes.length === 0
          ? 'empty'
          : 'ready';

  // Retry needs to bring both data sources back at once — REST refetch alone
  // leaves the live feed stuck in its backoff timer.
  const handleRetry = () => {
    refetch();
    reconnect();
  };

  return (
    <Shell
      header={
        <HomeHeader
          transportMode={transportMode}
          streamStatus={connectionStatus}
        />
      }
    >
      <div className="mx-auto max-w-6xl">
        <h1 className="font-geist-sans tracking-tight-32 mb-6 text-2xl font-semibold text-ink">
          Your nodes
        </h1>
        <StateShell
          state={uiState}
          loadingSlot={
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NodeCardSkeleton />
              <NodeCardSkeleton />
              <NodeCardSkeleton />
            </div>
          }
          emptySlot={
            <div
              role="status"
              className="flex flex-col items-center justify-center gap-4 py-16 text-center"
            >
              <p className="font-geist-sans max-w-md text-sm text-ink/60">
                No nodes configured. Run the first-run wizard to enable Town,
                Mill, or DVM.
              </p>
              {/* Spec AC-7: link to `/` until the wizard ships in 21.14;
                  flip back to `/wizard` then. */}
              <Link to="/" className={buttonVariants({ variant: 'primary' })}>
                Run wizard
              </Link>
            </div>
          }
          errorSlot={
            <div
              role="alert"
              className="flex flex-col items-center justify-center gap-4 py-16 text-center"
            >
              <p className="font-geist-sans max-w-md text-sm text-ink">
                Could not reach Townhouse API. Is{' '}
                <code className="font-geist-mono text-xs">
                  pnpm dev:docker
                </code>{' '}
                running?
              </p>
              <Button variant="secondary" onClick={handleRetry}>
                Retry
              </Button>
            </div>
          }
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {enabledNodes.map((node) => (
              <NodeCard
                key={node.type}
                node={node}
                liveState={statesByName[node.type]}
                metrics={metricsByType[node.type]}
              />
            ))}
          </div>
        </StateShell>
      </div>
    </Shell>
  );
}
