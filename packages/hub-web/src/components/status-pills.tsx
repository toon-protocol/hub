/**
 * StatusPills — 4-pill service health row (Story D9, AC-D9-4).
 *
 * Lives in the bottom of the dashboard's right column. Surfaces the
 * single boolean "is this thing OK?" per service so the demo audience can
 * glance and verify the stack is wired up.
 *
 * Services covered:
 *   - town   — relay node (state from `/api/nodes`)
 *   - mill   — swap peer (state from `/api/nodes`)
 *   - dvm    — data vending machine (state from `/api/nodes`)
 *   - ator   — privacy transport (mode + reachability from `/api/transport`)
 *
 * The pill is a minimum-viable surface: a colored dot, the service name,
 * a one-word state. We deliberately don't render uptime/latency here —
 * those live in the node cards / transport panel. The pills are the
 * "all green?" check.
 *
 * The component is stateless — it receives derived state via props so
 * tests can drive every branch deterministically. `Home.tsx` is the
 * single source of truth for the actual hook wiring.
 */

import * as React from 'react';
import { StatusDot } from '@/components/primitives/StatusDot';
import { mapToStatusDot, type StatusDotState } from '@/lib/node-status';
import type { TransportStatusPayload } from '@toon-protocol/hub';
import type { TransportStatusKind } from '@/hooks/useTransportStatus';

/** The four services the demo audience watches. */
export type ServicePill = 'town' | 'mill' | 'dvm' | 'ator';

/** Source-of-truth ordering — left to right, locked. */
export const PILL_ORDER: readonly ServicePill[] = [
  'town',
  'mill',
  'dvm',
  'ator',
] as const;

const PILL_LABEL: Record<ServicePill, string> = {
  town: 'town',
  mill: 'mill',
  dvm: 'dvm',
  ator: 'ator',
};

/** Per-pill input — callers pass an opaque "state string or undefined". */
export interface NodePillInput {
  /**
   * Raw state string from `/api/nodes` or the `WS /metrics` nodeState
   * stream — e.g. 'running' / 'paused' / 'exited'. `undefined` means the
   * node is disabled or unknown.
   */
  state: string | undefined;
  /** If false, the pill renders as "off" (grey, italic). */
  enabled: boolean;
}

export interface StatusPillsProps {
  town: NodePillInput;
  mill: NodePillInput;
  dvm: NodePillInput;
  /** Transport status payload + status-kind from `useTransportStatus`. */
  transport: {
    status: TransportStatusPayload | null;
    statusKind: TransportStatusKind;
  };
  className?: string;
}

interface ResolvedPill {
  service: ServicePill;
  dotState: StatusDotState;
  /** Short word rendered next to the dot. */
  caption: string;
  /** Long-form aria label. */
  ariaLabel: string;
}

/**
 * Map a node pill input to a resolved dot state + caption.
 * Exported for tests so the mapping is locked.
 */
export function resolveNodePill(
  service: 'town' | 'mill' | 'dvm',
  input: NodePillInput
): ResolvedPill {
  if (!input.enabled) {
    return {
      service,
      dotState: 'unknown',
      caption: 'off',
      ariaLabel: `${service} disabled`,
    };
  }
  const dotState = mapToStatusDot(input.state);
  const caption =
    dotState === 'ok'
      ? 'ok'
      : dotState === 'degraded'
        ? input.state ?? 'degraded'
        : dotState === 'down'
          ? input.state ?? 'down'
          : 'unknown';
  return {
    service,
    dotState,
    caption,
    ariaLabel: `${service} status: ${dotState}`,
  };
}

/** Map transport status to a pill — exported for tests. */
export function resolveTransportPill(
  status: TransportStatusPayload | null,
  statusKind: TransportStatusKind
): ResolvedPill {
  if (statusKind === 'loading') {
    return {
      service: 'ator',
      dotState: 'unknown',
      caption: '…',
      ariaLabel: 'ator status: probing',
    };
  }
  if (statusKind === 'error' || !status) {
    return {
      service: 'ator',
      dotState: 'unknown',
      caption: 'unknown',
      ariaLabel: 'ator status: unknown',
    };
  }
  if (status.mode === 'direct') {
    // Direct mode is the "ATOR is off, you're talking direct" state.
    // The pill is green-but-not-ator: dot ok, caption "direct".
    return {
      service: 'ator',
      dotState: 'ok',
      caption: 'direct',
      ariaLabel: 'ator status: direct (privacy off)',
    };
  }
  if (status.reachable) {
    return {
      service: 'ator',
      dotState: 'ok',
      caption: 'on',
      ariaLabel: 'ator status: reachable via proxy',
    };
  }
  return {
    service: 'ator',
    dotState: 'down',
    caption: 'down',
    ariaLabel: 'ator status: unreachable',
  };
}

interface PillProps {
  pill: ResolvedPill;
}

function Pill({ pill }: PillProps) {
  return (
    <li
      data-service={pill.service}
      data-state={pill.dotState}
      className="shadow-border flex items-center gap-2 rounded-full bg-ink/[0.02] px-3 py-1.5"
    >
      <StatusDot state={pill.dotState} aria-label={pill.ariaLabel} size="sm" />
      <span className="font-geist-mono text-xs text-ink/70">
        {PILL_LABEL[pill.service]}
      </span>
      <span
        className="font-geist-mono text-xs text-ink/40"
        aria-hidden="true"
      >
        {pill.caption}
      </span>
    </li>
  );
}

export function StatusPills({
  town,
  mill,
  dvm,
  transport,
  className,
}: StatusPillsProps) {
  const pills: ResolvedPill[] = [
    resolveNodePill('town', town),
    resolveNodePill('mill', mill),
    resolveNodePill('dvm', dvm),
    resolveTransportPill(transport.status, transport.statusKind),
  ];

  return (
    <section
      aria-label="Service status"
      className={`shadow-border rounded-lg bg-canvas p-3 ${className ?? ''}`}
    >
      <ul className="flex flex-wrap items-center gap-2">
        {pills.map((p) => (
          <Pill key={p.service} pill={p} />
        ))}
      </ul>
    </section>
  );
}

StatusPills.displayName = 'StatusPills';
