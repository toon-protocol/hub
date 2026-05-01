import * as React from 'react';
import { StatusDot } from '@/components/primitives/StatusDot';
import { Button } from '@/components/primitives/Button';
import type { TransportStatusPayload } from '@toon-protocol/townhouse';
import type { TransportStatusKind } from '@/hooks/useTransportStatus';

function relativeTime(ms: number): string {
  if (ms === 0) return 'never';
  const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff} s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  return `${Math.floor(diff / 3600)} hr ago`;
}

export interface TransportStatusPanelProps {
  status: TransportStatusPayload | null;
  statusKind: TransportStatusKind;
  /** Called when the "Switch to Direct" recovery button is clicked. */
  onSwitchToDirect?: () => void;
  /** Disables and labels the recovery button while a flip is in flight. */
  recoveryPending?: boolean;
  /** Compact variant: heading + dot + latency only, no recovery button (wizard step). */
  compact?: boolean;
}

export function TransportStatusPanel({
  status,
  statusKind,
  onSwitchToDirect,
  recoveryPending = false,
  compact = false,
}: TransportStatusPanelProps) {
  if (statusKind === 'loading' || (statusKind === 'ready' && status === null)) {
    return (
      <div className="shadow-border rounded-lg bg-canvas p-4 flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full bg-ink/10 flex-shrink-0"
          aria-hidden="true"
        />
        <span className="font-geist-sans text-sm text-ink/50">
          Probing transport…
        </span>
      </div>
    );
  }

  if (statusKind === 'error') {
    return (
      <div className="shadow-border rounded-lg bg-canvas p-4">
        <p className="font-geist-sans text-sm text-ink/60">
          Transport status unavailable
        </p>
        <p className="font-geist-sans text-xs text-ink/40 mt-1">
          Refresh the page or check the API server.
        </p>
      </div>
    );
  }

  // status is guaranteed non-null here: loading/error/null cases returned above
  const s = status as NonNullable<typeof status>;
  const isAtor = s.mode === 'ator';
  const isUnreachable = isAtor && !s.reachable;

  const dotState = isUnreachable ? 'down' : 'ok';
  const modeLabel = isAtor ? 'ATOR' : 'Direct';
  const reachabilityLabel = isUnreachable ? 'unreachable' : 'reachable';

  return (
    <div className="shadow-border rounded-lg bg-canvas p-4 flex flex-col gap-3">
      {/* Heading row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusDot
            state={dotState}
            aria-label={`Transport ${reachabilityLabel}`}
          />
          <span className="font-geist-sans text-sm font-medium text-ink">
            {modeLabel} · {isUnreachable ? 'Unreachable' : 'Reachable'}
          </span>
        </div>
        <span className="font-geist-mono text-xs text-ink/40">
          Probed {relativeTime(s.lastProbedAt)}
        </span>
      </div>

      {/* Mode line */}
      <dl className="flex flex-col gap-1">
        <div className="flex gap-2">
          <dt className="font-geist-sans text-xs text-ink/50 w-12 flex-shrink-0">
            Mode
          </dt>
          <dd className="font-geist-mono text-xs text-ink">{modeLabel}</dd>
        </div>

        {/* Proxy line (ATOR only) */}
        {isAtor && !compact && s.socksProxy && (
          <div className="flex gap-2">
            <dt className="font-geist-sans text-xs text-ink/50 w-12 flex-shrink-0">
              Proxy
            </dt>
            <dd className="font-geist-mono text-xs text-ink break-all">
              {s.socksProxy}
            </dd>
          </div>
        )}

        {/* Latency block — ATOR mode only. Direct mode renders only the dot + mode line per AC-21. */}
        {isAtor &&
          (s.latencyDirectMs !== null || s.latencyProxyMs !== null) && (
            <div className="flex gap-2">
              <dt className="font-geist-sans text-xs text-ink/50 w-12 flex-shrink-0">
                Latency
              </dt>
              <dd className="font-geist-mono text-xs text-ink">
                {s.latencyDirectMs !== null && (
                  <span>Direct: ~{s.latencyDirectMs} ms</span>
                )}
                {s.latencyProxyMs !== null && s.latencyDirectMs !== null && (
                  <span className="text-ink/40"> · </span>
                )}
                {s.latencyProxyMs !== null && (
                  <span>Via proxy: ~{s.latencyProxyMs} ms</span>
                )}
              </dd>
            </div>
          )}
      </dl>

      {/* Recovery action: only when ATOR + unreachable, not in compact mode */}
      {isUnreachable && !compact && onSwitchToDirect && (
        <Button
          variant="secondary"
          onClick={onSwitchToDirect}
          disabled={recoveryPending}
          aria-busy={recoveryPending}
          className="self-start"
        >
          {recoveryPending ? 'Switching…' : 'Switch to Direct'}
        </Button>
      )}
    </div>
  );
}
