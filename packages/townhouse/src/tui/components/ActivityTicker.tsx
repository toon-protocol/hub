import { Text } from 'ink';
import type { ReactElement } from 'react';
import type { RecentClaim } from '../types.js';
import { formatUsdcMicro, formatRelativeTime } from '../format.js';
import { COPY } from '../copy.js';

export interface ActivityTickerProps {
  recentClaims: RecentClaim[];
  now?: Date;
}

function sortKey(c: RecentClaim): number {
  const ms = Date.parse(c.at);
  return Number.isFinite(ms) ? ms : -Infinity;
}

function arrowFor(direction: RecentClaim['direction']): string {
  return direction === 'inbound' ? '←' : direction === 'outbound' ? '→' : COPY.activityOverlay.directionUnknown;
}

export function ActivityTicker({ recentClaims, now = new Date() }: ActivityTickerProps): ReactElement {
  if (recentClaims.length === 0) {
    return <Text dimColor>{COPY.activityTicker.empty}</Text>;
  }
  // Defensive sort DESC by `at` — wire ordering is not contractually guaranteed.
  const sorted = [...recentClaims].sort((a, b) => sortKey(b) - sortKey(a));
  const claim = sorted[0];
  if (!claim) {
    return <Text dimColor>{COPY.activityTicker.empty}</Text>;
  }
  const arrow = arrowFor(claim.direction);
  const amount = formatUsdcMicro(claim.amount, claim.assetScale);
  const rel = formatRelativeTime(claim.at, now);
  return (
    <Text dimColor>
      {COPY.activityTicker.prefix}{claim.peerId} {arrow} {amount} {claim.assetCode} · {rel}{COPY.activityTicker.keybind}
    </Text>
  );
}
