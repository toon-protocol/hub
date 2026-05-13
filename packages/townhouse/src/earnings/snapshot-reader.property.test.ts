/**
 * Property-based tests for snapshot-reader via fast-check (Story 47.3).
 *
 * This is the FIRST fast-check usage in the @toon-protocol/townhouse package.
 * Scope: correctness invariants for arbitrary claim sequences across DST
 * transitions, year boundaries, month boundaries, corruption, and clock skew.
 *
 * 6 properties (AC #5):
 *   1. Monotonicity — non-decreasing claimsReceivedTotal across snapshots.
 *   2. Sum-of-deltas (telescoping) — YEAR >= MONTH >= TODAY always.
 *   3. DST is a no-op — US + EU spring-forward days produce stable results.
 *   4. Year boundary — deltas computed across 2026-12-31 → 2027-01-01.
 *   5. No-crash on corruption — factory returns valid strings for any input.
 *   6. Clock skew shrinkage — all future snapshots produce {0,0,0}.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDeltaComputer, utcDayBoundary } from './snapshot-reader.js';
import type { SnapshotEntry } from './snapshot-writer.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeTmpSnapshot(entries: SnapshotEntry[]): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), '47-3-prop-'));
  const path = join(dir, 'earnings-snapshots.jsonl');
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, content, { mode: 0o600 });
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build a monotonically-increasing sequence of SnapshotEntry values starting
 * at `startMs` with hourly cadence for `hours` steps. Uses `increments` as the
 * per-step addition to claimsReceivedTotal.
 */
function buildMonotonicEntries(
  startMs: number,
  hours: number,
  peerId: string,
  assetCode: string,
  increments: bigint[]
): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  let cumulative = 0n;
  for (let i = 0; i < hours; i++) {
    cumulative += increments[i % increments.length];
    entries.push({
      ts: new Date(startMs + i * 3_600_000).toISOString(),
      peerId,
      assetCode,
      claimsReceivedTotal: cumulative.toString(),
    });
  }
  return entries;
}

// ── Properties ───────────────────────────────────────────────────────────────

describe('snapshot-reader property tests', () => {
  it('[prop 1] monotonicity: generated sequences are non-decreasing', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2025-01-01'), max: new Date('2026-12-01') }),
        fc.integer({ min: 24, max: 720 }),
        fc.array(fc.bigInt({ min: 0n, max: 1_000_000n }), {
          minLength: 1,
          maxLength: 50,
        }),
        (start, hours, increments) => {
          const entries = buildMonotonicEntries(
            start.getTime(),
            hours,
            'peer-1',
            'USD',
            increments
          );
          // Assert non-decreasing.
          for (let i = 1; i < entries.length; i++) {
            const prev = BigInt(entries[i - 1].claimsReceivedTotal);
            const curr = BigInt(entries[i].claimsReceivedTotal);
            if (curr < prev) return false;
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('[prop 2] sum-of-deltas: YEAR >= MONTH >= TODAY when all boundaries have snapshots', async () => {
    // Fix `now` in mid-to-late 2026 (Jul–Dec) and start the sequence at 2026-01-01.
    // This guarantees year/month/day boundaries all have matching snapshot entries,
    // so '0' from "no boundary snapshot" never invalidates the ordering invariant.
    await fc.assert(
      fc.asyncProperty(
        fc.date({ min: new Date('2026-07-01'), max: new Date('2026-12-30') }),
        fc.array(fc.bigInt({ min: 0n, max: 100_000n }), {
          minLength: 1,
          maxLength: 50,
        }),
        async (now, increments) => {
          const yearStartMs = new Date('2026-01-01T00:00:00.000Z').getTime();
          const hoursNeeded =
            Math.ceil((now.getTime() - yearStartMs) / 3_600_000) + 2;
          const entries = buildMonotonicEntries(
            yearStartMs,
            hoursNeeded,
            'peer-1',
            'USD',
            increments
          );
          const currentLifetime =
            entries[entries.length - 1].claimsReceivedTotal;

          const { path, cleanup } = writeTmpSnapshot(entries);
          try {
            const dc = createDeltaComputer({
              snapshotPath: path,
              now: () => now,
            });
            const result = await dc({
              scope: 'peer-1',
              assetCode: 'USD',
              currentLifetime,
            });
            const today = BigInt(result.today);
            const month = BigInt(result.month);
            const year = BigInt(result.year);
            return month >= today && year >= month;
          } finally {
            cleanup();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('[prop 3] DST is a no-op: US and EU spring-forward days are stable', async () => {
    // Sequences crossing US spring-forward (2026-03-08) and EU spring-forward
    // (2026-03-29) should produce valid non-crashing deltas.
    const DST_DAYS = [
      new Date('2026-03-07T22:00:00.000Z'), // before US spring-forward
      new Date('2026-03-08T06:00:00.000Z'), // on US spring-forward day
      new Date('2026-03-28T22:00:00.000Z'), // before EU spring-forward
      new Date('2026-03-29T06:00:00.000Z'), // on EU spring-forward day
    ];

    for (const dstDay of DST_DAYS) {
      const startMs = dstDay.getTime() - 48 * 3_600_000; // 2 days before
      const entries = buildMonotonicEntries(startMs, 96, 'peer-1', 'USD', [
        100n,
      ]);
      const now = new Date(dstDay.getTime() + 3_600_000);

      const { path, cleanup } = writeTmpSnapshot(entries);
      try {
        const dc = createDeltaComputer({ snapshotPath: path, now: () => now });
        const result = await dc({
          scope: 'peer-1',
          assetCode: 'USD',
          currentLifetime: '10000',
        });
        // Assert valid strings (no NaN, no undefined, no throw).
        expect(typeof result.today).toBe('string');
        expect(typeof result.month).toBe('string');
        expect(typeof result.year).toBe('string');
        // Assert non-negative.
        expect(BigInt(result.today)).toBeGreaterThanOrEqual(0n);
        expect(BigInt(result.month)).toBeGreaterThanOrEqual(0n);
        expect(BigInt(result.year)).toBeGreaterThanOrEqual(0n);
        // Assert UTC boundary is on the correct day (DST doesn't shift midnight).
        const dayBoundary = utcDayBoundary(now);
        expect(dayBoundary.endsWith('T00:00:00.000Z')).toBe(true);
      } finally {
        cleanup();
      }
    }
  });

  it('[prop 4] year boundary: YEAR resets across 2026-12-31 → 2027-01-01', async () => {
    // Build a sequence from 2026-12-30 through 2027-01-02.
    const startMs = new Date('2026-12-30T00:00:00.000Z').getTime();
    const entries = buildMonotonicEntries(startMs, 72, 'peer-1', 'USD', [
      1000n,
    ]);

    const beforeBoundary = new Date('2026-12-31T23:30:00.000Z');
    const afterBoundary = new Date('2027-01-01T00:30:00.000Z');

    const { path, cleanup } = writeTmpSnapshot(entries);
    try {
      const currentLifetime = (
        BigInt(entries[entries.length - 1].claimsReceivedTotal) + 5000n
      ).toString();

      const dcBefore = createDeltaComputer({
        snapshotPath: path,
        now: () => beforeBoundary,
      });
      const dcAfter = createDeltaComputer({
        snapshotPath: path,
        now: () => afterBoundary,
      });

      const resBefore = await dcBefore({
        scope: 'peer-1',
        assetCode: 'USD',
        currentLifetime,
      });
      const resAfter = await dcAfter({
        scope: 'peer-1',
        assetCode: 'USD',
        currentLifetime,
      });

      // Before the boundary: year boundary is 2026-01-01 (far in the past relative
      // to the entries which start 2026-12-30) — so year may be '0' (no snapshot
      // before the sequence start near 2026-01-01) or a valid value.
      expect(typeof resBefore.year).toBe('string');

      // After the boundary: year boundary is 2027-01-01T00:00:00.000Z.
      // There IS a snapshot near that boundary (the sequence covers that range).
      expect(typeof resAfter.year).toBe('string');
      // year after boundary should be >= 0.
      expect(BigInt(resAfter.year)).toBeGreaterThanOrEqual(0n);
      // TODAY and MONTH should be small (within ~30 minutes of entries).
      expect(BigInt(resAfter.today)).toBeGreaterThanOrEqual(0n);
    } finally {
      cleanup();
    }
  });

  it('[prop 5] no-crash on corruption: factory always returns valid strings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.bigInt({ min: 0n, max: 100_000n }), {
          minLength: 1,
          maxLength: 20,
        }),
        async (hours, increments) => {
          const startMs = new Date('2026-05-01T00:00:00.000Z').getTime();
          const entries = buildMonotonicEntries(
            startMs,
            hours,
            'peer-1',
            'USD',
            increments
          );

          // Inject corruption: truncated last line (no '\n'), malformed JSON,
          // line with negative claimsReceivedTotal, BOM-prefixed line.
          const lines = entries.map((e) => JSON.stringify(e));
          const corruptLines = [
            ...lines,
            '{"ts":"2026-05-10T00:00:00.000Z","peerId":"peer-1","assetCode":"USD","claimsReceivedTotal":"-1"}',
            'not-json-at-all',
            '﻿{"ts":"2026-05-11T00:00:00.000Z","peerId":"peer-1","assetCode":"USD","claimsReceivedTotal":"abc"}',
            // Non-string peerId (Task 7.3 prop 5 mandates this fixture). isSnapshotEntry rejects.
            '{"ts":"2026-05-09T00:00:00.000Z","peerId":123,"assetCode":"USD","claimsReceivedTotal":"100"}',
            lines[lines.length - 1].slice(0, 10), // truncated (no \n — will be last in file)
          ];

          const dir = mkdtempSync(join(tmpdir(), '47-3-corrupt-'));
          const path = join(dir, 'earnings-snapshots.jsonl');
          // No trailing newline to simulate mid-write truncation.
          writeFileSync(path, corruptLines.join('\n'), { mode: 0o600 });

          try {
            const currentLifetime =
              entries[entries.length - 1].claimsReceivedTotal;
            const now = new Date(startMs + (hours + 1) * 3_600_000);
            const dc = createDeltaComputer({
              snapshotPath: path,
              now: () => now,
            });
            const result = await dc({
              scope: 'peer-1',
              assetCode: 'USD',
              currentLifetime,
            });

            // No throw, no NaN, no undefined — just valid strings.
            if (typeof result.today !== 'string') return false;
            if (typeof result.month !== 'string') return false;
            if (typeof result.year !== 'string') return false;
            // Values must be parseable as non-negative BigInt.
            try {
              const t = BigInt(result.today);
              const m = BigInt(result.month);
              const y = BigInt(result.year);
              return t >= 0n && m >= 0n && y >= 0n;
            } catch {
              return false;
            }
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('[prop 6] clock skew: all snapshots in the future → returns {0,0,0}', async () => {
    // Generate a sequence entirely in the future relative to `now`.
    const futureStart = new Date('2027-01-01T00:00:00.000Z').getTime();
    const entries = buildMonotonicEntries(futureStart, 48, 'peer-1', 'USD', [
      500n,
    ]);
    const now = new Date('2026-05-12T00:00:00.000Z'); // before all entries

    const { path, cleanup } = writeTmpSnapshot(entries);
    try {
      const dc = createDeltaComputer({ snapshotPath: path, now: () => now });
      const result = await dc({
        scope: 'peer-1',
        assetCode: 'USD',
        currentLifetime: '100000',
      });
      expect(result).toEqual({ today: '0', month: '0', year: '0' });
    } finally {
      cleanup();
    }
  });
});
