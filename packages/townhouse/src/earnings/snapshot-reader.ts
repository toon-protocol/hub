/**
 * Snapshot reader + `DeltaComputer` factory (Story 47.3).
 *
 * Reads `earnings-snapshots.jsonl` and computes TODAY/MONTH/YEAR deltas vs.
 * UTC boundaries (midnight, 1st-of-month, 1st-of-year). Tolerates malformed
 * lines (skip) and clock-skewed snapshots (filter `ts > now`). Returns `'0'`
 * when no boundary snapshot exists yet.
 *
 * @module
 * @since 47.3
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { DeltaComputer } from './aggregator.js';
import type { SnapshotEntry } from './snapshot-writer.js';

export type { SnapshotEntry };

/** ISO of the most recent UTC midnight <= ref. */
export function utcDayBoundary(ref: Date): string {
  const d = new Date(ref);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** ISO of the first instant of the current calendar month in UTC. */
export function utcMonthBoundary(ref: Date): string {
  const d = new Date(ref);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** ISO of the first instant of the current calendar year in UTC. */
export function utcYearBoundary(ref: Date): string {
  const d = new Date(ref);
  d.setUTCMonth(0, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Read all snapshot entries for any (scope, assetCode) pair from the JSONL
 * file, filtered to those with `ts <= nowMs` (exclude future snapshots).
 * Returns a map keyed by `(peerId, assetCode)`; the caller picks the best
 * match per boundary from the array.
 *
 * Reads the file once via readline (streaming), so all three boundaries
 * share a single file scan. On stream I/O error, returns an empty map
 * (caller treats as "no snapshots" rather than acting on a partial read).
 */
async function readSnapshotMap(
  snapshotPath: string,
  nowMs: number
): Promise<Map<string, SnapshotEntry[]>> {
  const map = new Map<string, SnapshotEntry[]>();

  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(snapshotPath, { encoding: 'utf-8' });
  } catch {
    return map;
  }

  let streamFailed = false;
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return; // malformed — skip
      }
      if (!isSnapshotEntry(entry)) return;
      const tsMs = Date.parse(entry.ts);
      if (!Number.isFinite(tsMs)) return; // unparseable ts — skip
      if (tsMs > nowMs) return; // clock-skewed future snapshot — exclude

      const key = `${entry.peerId}\0${entry.assetCode}`;
      let arr = map.get(key);
      if (!arr) {
        arr = [];
        map.set(key, arr);
      }
      arr.push(entry);
    });

    rl.on('close', resolve);
    rl.on('error', () => {
      streamFailed = true;
      resolve();
    });
    stream.on('error', () => {
      streamFailed = true;
      rl.close();
      resolve();
    });
  });

  // Surface I/O errors as empty rather than returning a partial map the caller
  // would treat as authoritative.
  if (streamFailed) return new Map();
  return map;
}

/**
 * Find the entry with the greatest `tsMs <= boundaryMs` from the entries
 * for a (scope, assetCode) pair. Input is not assumed sorted — does a
 * linear scan tracking the running max.
 */
function findBestMatch(
  entries: SnapshotEntry[] | undefined,
  boundaryMs: number
): SnapshotEntry | null {
  if (!entries || entries.length === 0) return null;
  let best: SnapshotEntry | null = null;
  let bestMs = -Infinity;
  for (const e of entries) {
    const eMs = Date.parse(e.ts);
    if (!Number.isFinite(eMs)) continue;
    if (eMs <= boundaryMs && eMs > bestMs) {
      best = e;
      bestMs = eMs;
    }
  }
  return best;
}

/**
 * Construct a `DeltaComputer` (Story 47.2's type) backed by the snapshot
 * file at `snapshotPath`. The returned function is the one wired into
 * `aggregateEarnings({ ..., deltaComputer })` by Story 47.4's route.
 *
 * Reads the snapshot file once per DeltaComputer call (single-pass), then
 * resolves all three boundaries (today/month/year) in-memory from the parsed
 * map. No cross-call cache in v1 — see Open Question 6 in story notes.
 */
export function createDeltaComputer(opts: {
  snapshotPath: string;
  /** Optional clock injection for tests. Default `() => new Date()`. */
  now?: () => Date;
}): DeltaComputer {
  return async ({ scope, assetCode, currentLifetime }) => {
    const ref = (opts.now ?? (() => new Date()))();
    const nowMs = ref.getTime();
    if (!Number.isFinite(nowMs)) {
      // Defensive: bad clock injection (NaN time) would throw from toISOString.
      return { today: '0', month: '0', year: '0' };
    }

    const dayMs = Date.parse(utcDayBoundary(ref));
    const monthMs = Date.parse(utcMonthBoundary(ref));
    const yearMs = Date.parse(utcYearBoundary(ref));

    // Single file scan for all three boundaries.
    const map = await readSnapshotMap(opts.snapshotPath, nowMs);
    const key = `${scope}\0${assetCode}`;
    const entries = map.get(key);

    const daySnap = findBestMatch(entries, dayMs);
    const monthSnap = findBestMatch(entries, monthMs);
    const yearSnap = findBestMatch(entries, yearMs);

    let cur: bigint;
    try {
      cur = BigInt(currentLifetime);
    } catch {
      return { today: '0', month: '0', year: '0' };
    }

    const subOrZero = (snap: SnapshotEntry | null): string => {
      if (!snap) return '0';
      try {
        const base = BigInt(snap.claimsReceivedTotal);
        // Clamp negative BASELINE (not just negative diff) — a corrupt row
        // with claimsReceivedTotal = '-N' would otherwise INFLATE the delta
        // because `cur - (-Nn) = cur + Nn`.
        if (base < 0n) return '0';
        const diff = cur - base;
        return diff < 0n ? '0' : diff.toString();
      } catch {
        return '0';
      }
    };

    return {
      today: subOrZero(daySnap),
      month: subOrZero(monthSnap),
      year: subOrZero(yearSnap),
    };
  };
}

function isSnapshotEntry(v: unknown): v is SnapshotEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e['ts'] === 'string' &&
    typeof e['peerId'] === 'string' &&
    typeof e['assetCode'] === 'string' &&
    typeof e['claimsReceivedTotal'] === 'string'
  );
}
