import { Text } from 'ink';
import type { ReactElement } from 'react';
import type { AggregatedEarnings } from '../types.js';
import { COPY } from '../copy.js';

const USDC_ASSET = 'USDC';
const DECIMAL_RE = /^-?\d+$/;

const LIFETIME_USDC_THRESHOLD = 1_000_000n;
const UPTIME_SECONDS_THRESHOLD = 7 * 24 * 60 * 60;
export const ROTATION_INTERVAL_MS = 30_000;

function parseDecimalOrZero(value: string | undefined): bigint {
  if (value === undefined || !DECIMAL_RE.test(value)) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function computeLifetimeUsdc(
  apex: AggregatedEarnings['apex'],
  peers: AggregatedEarnings['peers']
): bigint {
  let total = parseDecimalOrZero(apex.routingFees[USDC_ASSET]?.lifetime);
  for (const peer of peers) {
    total += parseDecimalOrZero(peer.byAsset[USDC_ASSET]?.lifetime);
  }
  return total;
}

export interface BadgeProps {
  apex: AggregatedEarnings['apex'];
  peers: AggregatedEarnings['peers'];
  uptimeSeconds: number;
  /** Override the wall clock. Default `new Date()`. Inject in tests to pin rotation. */
  now?: Date;
}

export function Badge({
  apex,
  peers,
  uptimeSeconds,
  now = new Date(),
}: BadgeProps): ReactElement | null {
  const lifetime = computeLifetimeUsdc(apex, peers);
  const lifetimeTriggers = lifetime < LIFETIME_USDC_THRESHOLD;
  const uptimeTriggers = uptimeSeconds < UPTIME_SECONDS_THRESHOLD;

  if (!lifetimeTriggers && !uptimeTriggers) return null;

  const index =
    Math.floor(now.getTime() / ROTATION_INTERVAL_MS) %
    COPY.heroEarlyRotation.length;
  const text = COPY.heroEarlyRotation[index] ?? COPY.heroEarlyRotation[0];

  return (
    <Text color="yellow" bold>
      {text}
    </Text>
  );
}
