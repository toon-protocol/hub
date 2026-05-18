import { useState, useEffect } from 'react';
import type { RecentClaim } from './types.js';

export const MAX_BUFFER_SIZE = 200;

function claimKey(c: RecentClaim): string {
  return `${c.peerId}|${c.at}|${c.amount}|${c.assetCode}|${c.direction}`;
}

function sortKey(c: RecentClaim): number {
  const ms = Date.parse(c.at);
  return Number.isFinite(ms) ? ms : -Infinity;
}

export function useActivityBuffer(
  incoming: RecentClaim[] | undefined
): RecentClaim[] {
  const [buffer, setBuffer] = useState<RecentClaim[]>([]);

  useEffect(() => {
    if (!Array.isArray(incoming)) return;
    if (incoming.length === 0 && buffer.length === 0) return;

    const seen = new Map<string, RecentClaim>();
    for (const c of buffer) seen.set(claimKey(c), c);
    for (const c of incoming) seen.set(claimKey(c), c);

    const merged = Array.from(seen.values());
    merged.sort((a, b) => sortKey(b) - sortKey(a));
    const trimmed = merged.slice(0, MAX_BUFFER_SIZE);

    const same =
      trimmed.length === buffer.length &&
      trimmed.every(
        (c, i) =>
          buffer[i] !== undefined &&
          claimKey(c) === claimKey(buffer[i] as RecentClaim)
      );
    if (!same) setBuffer(trimmed);
  }, [incoming]);

  return buffer;
}
