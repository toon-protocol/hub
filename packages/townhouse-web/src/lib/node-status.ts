import type { NodeState } from '@toon-protocol/townhouse';

export type StatusDotState = 'ok' | 'degraded' | 'down' | 'unknown';

/**
 * Map a node's runtime state (either the API's NodeState enum from `/api/nodes`,
 * or the raw Docker state surfaced via `WS /metrics` `nodeState` events) to the
 * StatusDot variant.
 *
 * `paused` and `restarting` (only seen via the WS path — `/api/nodes` collapses
 * `paused → stopped`) deliberately map to `degraded` so AC-10 verification
 * (`docker pause` flipping the dot) works without an API change.
 */
export function mapToStatusDot(
  state: string | NodeState | undefined
): StatusDotState {
  if (!state) return 'unknown';
  switch (state) {
    case 'running':
      return 'ok';
    case 'paused':
    case 'restarting':
      return 'degraded';
    case 'exited':
    case 'stopped':
    case 'created':
    case 'dead':
    case 'not-created':
    case 'removing':
      return 'down';
    case 'error':
      return 'down';
    default:
      return 'unknown';
  }
}

/** Format an uptime in seconds as a compact human-friendly label. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
