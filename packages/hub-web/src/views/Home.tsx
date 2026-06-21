import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { useWizardState } from '@/hooks/useWizardState';
import { useTransportStatus } from '@/hooks/useTransportStatus';
import type { TransportStatusPayload } from '@toon-protocol/hub';
import type { TransportStatusKind } from '@/hooks/useTransportStatus';
import type {
  NodeInfo,
  NodeType,
  MetricsPayload,
} from '@toon-protocol/hub';

const NODE_LABELS: Record<NodeType, string> = {
  town: 'town',
  mill: 'mill',
  dvm: 'dvm',
};

/** Management view routes per node type — extended as views ship. */
const VIEW_LINKS: Partial<Record<NodeType, string>> = {
  town: '/town',
  mill: '/mill',
  dvm: '/dvm',
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
  const uptimeAriaLabel =
    node.uptimeSeconds == null ? 'Uptime: unknown' : `Uptime: ${uptimeText}`;

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
  streamStatus: StreamConnectionStatus;
  transportStatus: TransportStatusPayload | null;
  transportStatusKind: TransportStatusKind;
}

function streamStatusToDot(
  status: StreamConnectionStatus
): 'ok' | 'degraded' | 'down' {
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

/** Map transport status to dot state and aria-label string. */
export function formatTransportLabel(
  status: TransportStatusPayload | null,
  statusKind: TransportStatusKind
): { dotState: 'ok' | 'down' | 'unknown'; label: string } {
  if (statusKind === 'loading' || statusKind === 'error') {
    return { dotState: 'unknown', label: 'Transport: unknown' };
  }
  if (!status) {
    return { dotState: 'unknown', label: 'Transport: unknown' };
  }
  if (status.mode === 'direct') {
    return { dotState: 'ok', label: 'Direct transport' };
  }
  // ATOR mode — derive proxy host defensively; a malformed socksProxy must not
  // crash the header.
  let proxyHost = 'proxy';
  if (status.socksProxy) {
    try {
      proxyHost = new URL(status.socksProxy).host || 'proxy';
    } catch {
      proxyHost = 'proxy';
    }
  }
  if (status.reachable) {
    const latency =
      status.latencyProxyMs != null
        ? `, ~${status.latencyProxyMs} ms via proxy`
        : '';
    const direct =
      status.latencyDirectMs != null
        ? ` / ~${status.latencyDirectMs} ms direct`
        : '';
    return {
      dotState: 'ok',
      label: `ATOR transport: connected (${proxyHost}${latency}${direct})`,
    };
  }
  return {
    dotState: 'down',
    label: `ATOR transport: unreachable — ${proxyHost} not responding`,
  };
}

function HomeHeader({
  streamStatus,
  transportStatus,
  transportStatusKind,
}: HomeHeaderProps) {
  const { dotState, label } = formatTransportLabel(
    transportStatus,
    transportStatusKind
  );

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-semibold tracking-tight-16">Hub</span>
      <div className="flex items-center gap-4 text-xs text-ink/60">
        <Link
          to="/settings"
          className="font-geist-sans text-xs text-ink/60 hover:text-ink"
          aria-label="View settings"
        >
          Settings
        </Link>
        <Link
          to="/wallet"
          className="font-geist-sans text-xs text-ink/60 hover:text-ink"
          aria-label="View wallet and keys"
        >
          Wallet
        </Link>
        <StatusDot state={dotState} aria-label={label} />
        <StatusDot
          state={streamStatusToDot(streamStatus)}
          aria-label={streamStatusLabel(streamStatus)}
        />
      </div>
    </div>
  );
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

export function Home() {
  const navigate = useNavigate();
  const { nodes, metricsByType, status, refetch } = useNodes();
  const { statesByName, connectionStatus, reconnect } = useNodeStatusStream();
  const { state: wizardState, status: wizardStatus } = useWizardState();
  const { status: transportStatus, statusKind: transportStatusKind } =
    useTransportStatus();

  // AC-12: Auto-redirect to /wizard when setup hasn't been run.
  // Depend on the boolean derivation, not on the wizardState object — useWizardState
  // returns a fresh object on every poll, so depending on it would re-fire navigate()
  // every 2s and amplify any transient flap into a redirect storm.
  const shouldRedirectToWizard =
    wizardStatus === 'ready' && wizardState?.config_exists === false;
  useEffect(() => {
    if (shouldRedirectToWizard) {
      navigate('/wizard', { replace: true });
    }
  }, [shouldRedirectToWizard, navigate]);

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
          streamStatus={connectionStatus}
          transportStatus={transportStatus}
          transportStatusKind={transportStatusKind}
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
              <Link
                to="/wizard"
                className={buttonVariants({ variant: 'primary' })}
              >
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
                Could not reach Hub API. Is{' '}
                <code className="font-geist-mono text-xs">pnpm dev:docker</code>{' '}
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
