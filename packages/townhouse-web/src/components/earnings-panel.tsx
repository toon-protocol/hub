/**
 * EarningsPanel — operator earnings dashboard view (Story D4, AC-D4-4).
 *
 * Polls `GET /api/earnings` every 5 s and renders:
 *   - Hero: total sats earned across all four sources.
 *   - Per-source breakdown: relay / mill / dvm / connector with sats counts.
 *   - Recent items list: each row hover-reveals a tooltip with txid +
 *     block-explorer link button (when an explorerUrl is available).
 *
 * For D4 the "no mock data" rule means rows without an `explorerUrl` show
 * the source label only — we deliberately do NOT render fake links. When
 * mill's live SettlementEvent emission ships (post-D4), rows will start
 * carrying `txHash` + `explorerUrl` and the tooltip's "View on explorer"
 * button will become the primary affordance.
 *
 * Provisional layout per AC-D4-5: D9 will redo the dashboard layout.
 *
 * @since D4
 */

import * as React from 'react';
import { MetricBlock } from './primitives/MetricBlock';

const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_ENDPOINT = '/api/earnings';

/** Per-source bucket — mirrors the server's `PerSourceTotals`. */
export interface EarningsAssetBucket {
  amount: string;
  decimals: number;
  symbol: string;
  chain?: string;
}

export interface EarningsPerSource {
  sats: string;
  tokens: Record<string, EarningsAssetBucket>;
}

export type EarningsSource = 'relay' | 'mill' | 'dvm' | 'connector';

export interface EarningsItem {
  ts: string;
  source: EarningsSource;
  asset: { symbol: string; decimals: number; chain?: string };
  amount: string;
  txHash?: string;
  explorerUrl?: string;
}

export interface EarningsPayload {
  since: string;
  totals: { sats: string; tokens: Record<string, EarningsAssetBucket> };
  by_source: Record<EarningsSource, EarningsPerSource>;
  items: EarningsItem[];
}

export interface EarningsPanelProps {
  /** Override the API endpoint (test injection only). */
  endpoint?: string;
  /** Test-only override for the polling interval. */
  pollIntervalMs?: number;
  /** Test injection for initial data — bypasses fetch entirely. */
  initialData?: EarningsPayload | null;
  /** Test injection — disables fetch entirely. */
  fetchEnabled?: boolean;
}

/**
 * Order the rows render in the "By source" rail. Locked here so the layout
 * is stable across polls — Object.entries() doesn't guarantee order on the
 * payload, but our spec does (relay → mill → dvm → connector).
 */
const SOURCE_ORDER: readonly EarningsSource[] = [
  'relay',
  'mill',
  'dvm',
  'connector',
] as const;

const SOURCE_LABEL: Record<EarningsSource, string> = {
  relay: 'Relay',
  mill: 'Mill',
  dvm: 'DVM',
  connector: 'Connector',
};

/**
 * Format a BigInt-safe decimal string with thousands separators. Falls
 * through to the raw string if BigInt parsing fails (defensive — the API
 * shouldn't emit garbage but we never want a panel that crashes on bad
 * data).
 */
export function formatSats(amount: string): string {
  try {
    const big = BigInt(amount);
    return big.toLocaleString('en-US');
  } catch {
    return amount;
  }
}

/** Format an ISO timestamp as HH:MM:SS — short, monospace-friendly. */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return d.toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return '--:--:--';
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

export function EarningsPanel({
  endpoint = DEFAULT_ENDPOINT,
  pollIntervalMs = POLL_INTERVAL_MS,
  initialData = null,
  fetchEnabled = true,
}: EarningsPanelProps): React.ReactElement {
  const [data, setData] = React.useState<EarningsPayload | null>(initialData);
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
        const payload = (await res.json()) as EarningsPayload;
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

  // Defensive access — Home.test (and other consumers) mock /api/earnings
  // with arbitrary shapes. Never crash; show "0" + ride out the next poll.
  const heroSats = data?.totals?.sats ?? '0';

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
            : status === 'error'
              ? 'unavailable'
              : 'live'}
        </span>
      </header>

      {/* Hero number — total sats. */}
      <div className="flex items-end justify-between gap-4">
        <MetricBlock
          value={status === 'error' ? '—' : formatSats(heroSats)}
          label="Total sats"
          variant="full"
          aria-label={
            status === 'error'
              ? 'earnings metric unavailable'
              : `Total sats earned: ${formatSats(heroSats)}`
          }
        />
        {data?.since && (
          <span
            className="font-geist-mono text-[11px] text-ink/40"
            aria-label={`since ${data.since}`}
          >
            since {formatTime(data.since)}
          </span>
        )}
      </div>

      {/* Per-source rail. */}
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        aria-label="Earnings by source"
      >
        {SOURCE_ORDER.map((source) => {
          const bucket = data?.by_source?.[source];
          const sats = bucket?.sats ?? '0';
          return (
            <div
              key={source}
              className="shadow-border rounded bg-ink/[0.02] p-3"
              aria-label={`${SOURCE_LABEL[source]} earnings: ${formatSats(sats)} sats`}
            >
              <span className="font-geist-sans text-xs text-ink/50">
                {SOURCE_LABEL[source]}
              </span>
              <div className="font-geist-mono mt-1 text-base font-semibold tabular-nums text-ink">
                {formatSats(sats)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent items. */}
      <RecentItems
        items={Array.isArray(data?.items) ? data.items : []}
        status={status}
      />
    </section>
  );
}

interface RecentItemsProps {
  items: EarningsItem[];
  status: 'loading' | 'ready' | 'error';
}

function RecentItems({ items, status }: RecentItemsProps): React.ReactElement {
  return (
    <div
      className="shadow-border rounded bg-ink/[0.02]"
      aria-label="Recent earnings"
    >
      <header className="shadow-border flex items-center justify-between px-3 py-2">
        <span className="font-geist-sans text-xs text-ink/50">Recent</span>
        <span className="font-geist-mono text-xs text-ink/40">
          {items.length} item{items.length === 1 ? '' : 's'}
        </span>
      </header>
      {items.length === 0 ? (
        <p className="font-geist-sans px-3 py-4 text-xs text-ink/40">
          {status === 'loading'
            ? 'Loading recent activity…'
            : status === 'error'
              ? 'Could not reach earnings API.'
              : 'No paid events in the current window.'}
        </p>
      ) : (
        <ul className="flex flex-col text-xs" aria-label="Earnings rows">
          {items.slice(0, 25).map((item, idx) => (
            <EarningsRow key={`${item.ts}-${item.source}-${idx}`} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface EarningsRowProps {
  item: EarningsItem;
}

/**
 * One earnings row. Hovering shows a tooltip with the txid + an explorer
 * link button. We use `<details>` rather than a custom popover for D4
 * because:
 *   - Works without JS (a11y win for screen readers).
 *   - Native disclosure semantics — `aria-expanded` is automatic.
 *   - Avoids dragging in a popover dep for what's a provisional layout.
 *
 * D9 will likely replace this with a richer popover; until then the
 * disclosure is a clean, predictable interaction.
 */
function EarningsRow({ item }: EarningsRowProps): React.ReactElement {
  const hasDetails = !!item.txHash || !!item.explorerUrl;
  return (
    <li
      className="shadow-border px-3 py-2"
      data-source={item.source}
    >
      <details className="group">
        <summary
          className="flex cursor-pointer items-center justify-between gap-3 hover:bg-ink/[0.03]"
          aria-label={`${item.source} earned ${formatSats(item.amount)} ${item.asset.symbol} at ${formatTime(item.ts)}`}
        >
          <span className="font-geist-mono w-16 text-ink/40 tabular-nums">
            {formatTime(item.ts)}
          </span>
          <span className="font-geist-sans w-16 text-ink/60">
            {SOURCE_LABEL[item.source]}
          </span>
          <span className="font-geist-mono flex-1 text-right tabular-nums text-ink">
            {formatSats(item.amount)}{' '}
            <span className="text-ink/40">{item.asset.symbol}</span>
          </span>
          {hasDetails && (
            <span
              className="font-geist-mono text-ink/30 group-open:rotate-90"
              aria-hidden="true"
            >
              ›
            </span>
          )}
        </summary>
        {hasDetails && (
          <div
            className="mt-2 flex flex-wrap items-center gap-2 pl-16"
            role="group"
            aria-label="Transaction details"
          >
            {item.txHash && (
              <span
                className="font-geist-mono rounded bg-ink/5 px-2 py-1 text-[11px] text-ink/70"
                aria-label={`Transaction hash ${item.txHash}`}
                title={item.txHash}
              >
                txid {truncateHash(item.txHash)}
              </span>
            )}
            {item.explorerUrl && (
              <a
                href={item.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-geist-sans rounded bg-ink/10 px-2 py-1 text-[11px] text-ink hover:bg-ink/20"
                aria-label={`View transaction on block explorer (opens in new tab)`}
              >
                View on explorer ↗
              </a>
            )}
          </div>
        )}
      </details>
    </li>
  );
}
