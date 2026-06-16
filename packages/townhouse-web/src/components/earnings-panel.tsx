/**
 * EarningsPanel — operator earnings dashboard view (Story 47.2).
 *
 * Polls `GET /api/earnings` every 5 s and renders the aggregator's
 * `{ status, apex, peers }` shape. The panel shows:
 *   - Apex routing fees by asset (connector-level fees).
 *   - Per-peer earnings table grouped by node type.
 *   - Banner when `status === 'connector_unavailable'` (route returned 200
 *     but the connector itself was unreachable).
 *
 * Delta columns render only when a row has non-stub deltas — until Story
 * 47.3 wires the snapshot-backed delta computer, today/month/year are '0'.
 *
 * @since 47.2
 */

import * as React from 'react';
import type {
  AggregatedEarnings,
  NodeEarnings,
  PerAsset,
} from '@toon-protocol/hub';
import { MetricBlock } from './primitives/MetricBlock';

const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_ENDPOINT = '/api/earnings';

// Re-export the aggregator types so callers of this module continue to
// import them from here (back-compat with pre-review imports).
export type { AggregatedEarnings, NodeEarnings, PerAsset };

export interface EarningsPanelProps {
  /** Override the API endpoint (test injection only). */
  endpoint?: string;
  /** Test-only override for the polling interval. */
  pollIntervalMs?: number;
  /** Test injection for initial data — bypasses fetch entirely. */
  initialData?: AggregatedEarnings | null;
  /** Test injection — disables fetch entirely. */
  fetchEnabled?: boolean;
}

/**
 * Format a BigInt-safe decimal string with thousands separators. Falls
 * through to the raw string if BigInt parsing fails.
 */
export function formatSats(amount: string): string {
  try {
    const big = BigInt(amount);
    return big.toLocaleString('en-US');
  } catch {
    return amount;
  }
}

/**
 * Truncate a tx hash for inline display: `0xabcd…1234`. Plays nicely with
 * both EVM hashes (66 chars) and Solana base58 signatures (~88 chars).
 */
export function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

/**
 * Returns true when the delta fields are unset / stubbed. Tolerates
 * malformed payloads (`undefined` / missing fields) so a wonky mock body
 * never crashes the panel — earlier defensive comments documented this.
 */
function deltasStubbed(asset: PerAsset | undefined): boolean {
  if (!asset) return true;
  return asset.today === '0' && asset.month === '0' && asset.year === '0';
}

const NODE_TYPE_LABEL: Record<NodeEarnings['type'], string> = {
  town: 'Town',
  mill: 'Mill',
  dvm: 'DVM',
  external: 'External',
};

/** Defensive label lookup — falls back to "Unknown" if a future node type slips through. */
function nodeTypeLabel(type: NodeEarnings['type'] | string): string {
  return (NODE_TYPE_LABEL as Record<string, string>)[type] ?? 'Unknown';
}

export function EarningsPanel({
  endpoint = DEFAULT_ENDPOINT,
  pollIntervalMs = POLL_INTERVAL_MS,
  initialData = null,
  fetchEnabled = true,
}: EarningsPanelProps): React.ReactElement {
  const [data, setData] = React.useState<AggregatedEarnings | null>(initialData);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>(
    initialData ? 'ready' : 'loading'
  );

  React.useEffect(() => {
    if (!fetchEnabled) return;

    let cancelled = false;
    const inFlight = new Set<AbortController>();

    async function poll(): Promise<void> {
      const controller = new AbortController();
      inFlight.add(controller);
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, { signal: controller.signal });
        if (cancelled) return;
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const payload = (await res.json()) as AggregatedEarnings;
        if (cancelled) return;
        setData(payload);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('error');
      } finally {
        clearTimeout(timer);
        inFlight.delete(controller);
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
      for (const c of inFlight) c.abort();
    };
  }, [endpoint, pollIntervalMs, fetchEnabled]);

  // Combine HTTP fetch state with the wire-level `status` field. Either
  // `'error'` (HTTP non-200 / network) or `'connector_unavailable'` (HTTP
  // 200 but connector itself unreachable) drives the unavailable banner.
  const connectorUnavailable = data?.status === 'connector_unavailable';
  const isUnavailable = status === 'error' || connectorUnavailable;

  // Hero: first apex routing fee lifetime, or '0' when empty.
  // Defensive access — wire shape may be a mock with arbitrary fields.
  const apexFees = data?.apex?.routingFees ?? {};
  const apexEntries = Object.entries(apexFees);
  const firstApex = apexEntries[0];
  const heroValue = isUnavailable
    ? '—'
    : firstApex
      ? formatSats(firstApex[1]?.lifetime ?? '0')
      : '0';
  const heroUnit = firstApex ? firstApex[0] : undefined;
  const heroAriaLabel = isUnavailable
    ? 'earnings metric unavailable'
    : firstApex
      ? `Apex routing fees: ${heroValue} ${heroUnit}`
      : 'Apex routing fees: none yet';

  return (
    <section
      className="shadow-border flex flex-col gap-4 rounded-lg bg-canvas p-5"
      aria-label="Earnings"
    >
      <header className="flex items-center justify-between">
        <h2 className="font-geist-sans text-sm font-medium text-ink">
          Earnings
        </h2>
        <span
          className="font-geist-mono text-xs text-ink/40"
          aria-live="polite"
        >
          {status === 'loading'
            ? 'loading…'
            : isUnavailable
              ? 'unavailable'
              : 'live'}
        </span>
      </header>

      {/* Connector-unavailable banner (wire-level signal, not HTTP error). */}
      {connectorUnavailable && (
        <div
          role="status"
          className="shadow-border rounded bg-amber-500/[0.08] px-3 py-2"
          aria-label="Connector unavailable"
        >
          <p className="font-geist-sans text-xs text-ink/70">
            Connector unreachable — showing last-known zero. Earnings will
            resume when the apex connector reports settlement state.
          </p>
        </div>
      )}

      {/* Hero number — first apex routing fee asset. */}
      <div className="flex items-end gap-4">
        <MetricBlock
          value={heroValue}
          label="Apex routing fees"
          unit={!isUnavailable ? heroUnit : undefined}
          variant="full"
          aria-label={heroAriaLabel}
        />
      </div>

      {/* Apex routing fees breakdown. */}
      <section
        className="shadow-border rounded bg-ink/[0.02] p-3"
        aria-label="Apex routing fees"
      >
        <header className="mb-2 flex items-center justify-between">
          <span className="font-geist-sans text-xs text-ink/50">
            Apex routing fees
          </span>
          <span className="font-geist-mono text-xs text-ink/30">
            {apexEntries.length} asset{apexEntries.length === 1 ? '' : 's'}
          </span>
        </header>
        {apexEntries.length === 0 ? (
          <p className="font-geist-sans text-xs text-ink/40">
            {status === 'loading' ? 'Loading…' : 'No routing fees yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {apexEntries.map(([code, asset]) => {
              const lifetime = formatSats(asset?.lifetime ?? '0');
              return (
                <li
                  key={code}
                  className="flex items-center justify-between gap-2"
                  aria-label={`Apex ${code} lifetime: ${lifetime}`}
                >
                  <span className="font-geist-mono text-xs text-ink/60">{code}</span>
                  <span className="font-geist-mono text-sm font-semibold tabular-nums text-ink">
                    {lifetime}
                  </span>
                  {!deltasStubbed(asset) && (
                    <span className="font-geist-mono text-xs text-ink/40">
                      +{formatSats(asset.today)} today
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Per-peer earnings. */}
      <PeerEarningsTable
        peers={data?.peers ?? []}
        status={status}
        connectorUnavailable={connectorUnavailable}
      />
    </section>
  );
}

interface PeerEarningsTableProps {
  peers: NodeEarnings[];
  status: 'loading' | 'ready' | 'error';
  connectorUnavailable: boolean;
}

function PeerEarningsTable({
  peers,
  status,
  connectorUnavailable,
}: PeerEarningsTableProps): React.ReactElement {
  return (
    <section
      className="shadow-border rounded bg-ink/[0.02]"
      aria-label="Peer earnings"
    >
      <header className="shadow-border flex items-center justify-between px-3 py-2">
        <span className="font-geist-sans text-xs text-ink/50">Peer earnings</span>
        <span className="font-geist-mono text-xs text-ink/40">
          {peers.length} peer{peers.length === 1 ? '' : 's'}
        </span>
      </header>
      {peers.length === 0 ? (
        <p className="font-geist-sans px-3 py-4 text-xs text-ink/40">
          {status === 'loading'
            ? 'Loading peer earnings…'
            : status === 'error'
              ? 'Could not reach earnings API.'
              : connectorUnavailable
                ? 'Connector unavailable — no peer earnings to show.'
                : 'No peer earnings yet.'}
        </p>
      ) : (
        <ul className="flex flex-col text-xs" aria-label="Peer earnings rows">
          {peers.map((peer) => (
            <PeerRow key={peer.id} peer={peer} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface PeerRowProps {
  peer: NodeEarnings;
}

function PeerRow({ peer }: PeerRowProps): React.ReactElement {
  const typeLabel = nodeTypeLabel(peer.type);
  // Defensive: `byAsset` and inner shape may be malformed in test mocks.
  const assetEntries = Object.entries(peer.byAsset ?? {});
  const firstAsset = assetEntries[0];
  const heroLifetime = firstAsset ? formatSats(firstAsset[1]?.lifetime ?? '0') : '0';
  const heroUnit = firstAsset ? firstAsset[0] : undefined;

  return (
    <li
      className="shadow-border px-3 py-2"
      data-peer-type={peer.type}
      aria-label={`${typeLabel} peer ${peer.id}: ${heroLifetime}${heroUnit ? ' ' + heroUnit : ''} lifetime`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-geist-sans w-16 text-ink/60">{typeLabel}</span>
        <span className="font-geist-mono flex-1 truncate text-ink/40" title={peer.id}>
          {peer.id}
        </span>
        {firstAsset && (
          <div className="flex items-baseline gap-1">
            <span className="font-geist-mono tabular-nums text-ink">
              {heroLifetime}
            </span>
            <span className="font-geist-mono text-ink/40">{heroUnit}</span>
            {!deltasStubbed(firstAsset[1]) && (
              <span className="font-geist-mono text-xs text-ink/40">
                +{formatSats(firstAsset[1].today)} today
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
