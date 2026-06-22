/**
 * Unit tests for snapshot-reader — boundary helpers, `createDeltaComputer`
 * factory (Story 47.3).
 *
 * Test gate matrix (AC: 3, 5, 6, 9 — 12 cases):
 *   1.  utcDayBoundary — midnight UTC of the same calendar day.
 *   2.  utcMonthBoundary — 1st of the calendar month at 00:00Z.
 *   3.  utcYearBoundary — Jan 1 at 00:00Z.
 *   4.  DST is irrelevant — US spring-forward day produces same UTC midnight.
 *   5.  Factory returns correct deltas vs. seeded snapshots.
 *   6.  Apex scope — `'__apex__'` lookup.
 *   7.  Unknown scope returns `{today:'0',month:'0',year:'0'}`.
 *   8.  Clock-skewed snapshot (ts > now) is excluded.
 *   9.  Negative delta clamped to `'0'`.
 *   10. Malformed line is skipped without crashing.
 *   11. BigInt precision: 18-decimal ETH-scale subtraction.
 *   12. Perf: 9500-entry fixture → DeltaComputer call <100ms && <2MB.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  utcDayBoundary,
  utcMonthBoundary,
  utcYearBoundary,
  createDeltaComputer,
} from './snapshot-reader.js';
import type { SnapshotEntry } from './snapshot-writer.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeSnapshot(path: string, entries: SnapshotEntry[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, content, { mode: 0o600 });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('utcDayBoundary', () => {
  it('[case 1] returns midnight UTC of the same calendar day', () => {
    const ref = new Date('2026-05-12T15:42:37.123Z');
    expect(utcDayBoundary(ref)).toBe('2026-05-12T00:00:00.000Z');
  });
});

describe('utcMonthBoundary', () => {
  it('[case 2] returns 1st of the calendar month at 00:00Z', () => {
    const ref = new Date('2026-05-12T15:42:37.123Z');
    expect(utcMonthBoundary(ref)).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('utcYearBoundary', () => {
  it('[case 3] returns Jan 1 at 00:00Z of the current year', () => {
    const ref = new Date('2026-05-12T15:42:37.123Z');
    expect(utcYearBoundary(ref)).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('utcDayBoundary — DST', () => {
  it('[case 4] US spring-forward day — UTC boundary is unaffected', () => {
    // 2026-03-08 07:42:37Z is during US DST spring-forward (02:00 local → 03:00).
    const ref = new Date('2026-03-08T07:42:37.000Z');
    expect(utcDayBoundary(ref)).toBe('2026-03-08T00:00:00.000Z');
  });
});

describe('createDeltaComputer', () => {
  let tmpHome: string;

  function setup() {
    tmpHome = mkdtempSync(join(tmpdir(), '47-3-reader-'));
    return join(tmpHome, 'earnings-snapshots.jsonl');
  }
  function teardown() {
    rmSync(tmpHome, { recursive: true, force: true });
  }

  it('[case 5] returns correct deltas vs. seeded snapshots', async () => {
    const path = setup();
    try {
      const entries: SnapshotEntry[] = [
        {
          ts: '2026-05-12T00:00:00.000Z',
          peerId: 'peer-1',
          assetCode: 'USD',
          claimsReceivedTotal: '1000000',
        },
        {
          ts: '2026-05-01T00:00:00.000Z',
          peerId: 'peer-1',
          assetCode: 'USD',
          claimsReceivedTotal: '500000',
        },
      ];
      writeSnapshot(path, entries);

      const dc = createDeltaComputer({
        snapshotPath: path,
        now: () => new Date('2026-05-12T15:42:00.000Z'),
      });

      const result = await dc({
        scope: 'peer-1',
        assetCode: 'USD',
        currentLifetime: '1234567',
      });
      expect(result.today).toBe('234567'); // 1234567 - 1000000
      expect(result.month).toBe('734567'); // 1234567 - 500000
      expect(result.year).toBe('0'); // no year-boundary snapshot → '0' per AC #3
    } finally {
      teardown();
    }
  });

  it('[case 6] apex scope uses __apex__ peerId for lookup', async () => {
    const path = setup();
    try {
      const entries: SnapshotEntry[] = [
        {
          ts: '2026-05-12T00:00:00.000Z',
          peerId: '__apex__',
          assetCode: 'USD',
          claimsReceivedTotal: '300',
        },
      ];
      writeSnapshot(path, entries);

      const dc = createDeltaComputer({
        snapshotPath: path,
        now: () => new Date('2026-05-12T08:00:00.000Z'),
      });

      const result = await dc({
        scope: '__apex__',
        assetCode: 'USD',
        currentLifetime: '500',
      });
      expect(result.today).toBe('200'); // 500 - 300
    } finally {
      teardown();
    }
  });

  it('[case 7] unknown scope returns all zeros', async () => {
    const path = setup();
    try {
      writeFileSync(path, '', { mode: 0o600 });
      const dc = createDeltaComputer({
        snapshotPath: path,
        now: () => new Date('2026-05-12T15:00:00.000Z'),
      });

      const result = await dc({
        scope: 'nobody',
        assetCode: 'USD',
        currentLifetime: '9999',
      });
      expect(result).toEqual({ today: '0', month: '0', year: '0' });
    } finally {
      teardown();
    }
  });

  it('[case 8] clock-skewed snapshot (ts > now) is excluded', async () => {
    const path = setup();
    try {
      const entries: SnapshotEntry[] = [
        // Future snapshot — should be ignored.
        {
          ts: '2026-05-15T00:00:00.000Z',
          peerId: 'peer-1',
          assetCode: 'USD',
          claimsReceivedTotal: '999999999',
        },
        // Past snapshot — should be used.
        {
          ts: '2026-05-12T00:00:00.000Z',
          peerId: 'peer-1',
          assetCode: 'USD',
          claimsReceivedTotal: '1000',
        },
      ];
      writeSnapshot(path, entries);

      const dc = createDeltaComputer({
        snapshotPath: path,
        now: () => new Date('2026-05-12T10:00:00.000Z'),
      });

      const result = await dc({
        scope: 'peer-1',
        assetCode: 'USD',
        currentLifetime: '1500',
      });
      // Uses the 2026-05-12 snapshot (500), NOT the future 999999999.
      expect(result.today).toBe('500');
    } finally {
      teardown();
    }
  });

  it('[case 9] negative delta clamped to zero', async () => {
    const path = setup();
    try {
      const entries: SnapshotEntry[] = [
        // snapshot > currentLifetime → degenerate/corrupt state
        {
          ts: '2026-05-12T00:00:00.000Z',
          peerId: 'peer-1',
          assetCode: 'USD',
          claimsReceivedTotal: '9999999',
        },
      ];
      writeSnapshot(path, entries);

      const dc = createDeltaComputer({
        snapshotPath: path,
        now: () => new Date('2026-05-12T10:00:00.000Z'),
      });

      const result = await dc({
        scope: 'peer-1',
        assetCode: 'USD',
        currentLifetime: '100',
      });
      expect(result.today).toBe('0');
    } finally {
      teardown();
    }
  });

  it('[case 10] malformed line is skipped without crashing', async () => {
    const path = setup();
    try {
      const content =
        [
          JSON.stringify({
            ts: '2026-05-12T00:00:00.000Z',
            peerId: 'peer-1',
            assetCode: 'USD',
            claimsReceivedTotal: '1000',
          }),
          'not-valid-json',
          JSON.stringify({
            ts: '2026-05-01T00:00:00.000Z',
            peerId: 'peer-1',
            assetCode: 'USD',
            claimsReceivedTotal: '500',
          }),
        ].join('\n') + '\n';
      writeFileSync(path, content, { mode: 0o600 });

      const dc = createDeltaComputer({
        snapshotPath: path,
        now: () => new Date('2026-05-12T15:00:00.000Z'),
      });

      const result = await dc({
        scope: 'peer-1',
        assetCode: 'USD',
        currentLifetime: '1500',
      });
      // Both valid lines are used; no throw.
      expect(result.today).toBe('500'); // 1500 - 1000
      expect(result.month).toBe('1000'); // 1500 - 500
    } finally {
      teardown();
    }
  });

  it('[case 11] BigInt precision: 18-decimal ETH-scale subtraction', async () => {
    const path = setup();
    try {
      const entries: SnapshotEntry[] = [
        {
          ts: '2026-05-12T00:00:00.000Z',
          peerId: 'peer-eth',
          assetCode: 'ETH',
          claimsReceivedTotal: '500000000000000000',
        },
      ];
      writeSnapshot(path, entries);

      const dc = createDeltaComputer({
        snapshotPath: path,
        now: () => new Date('2026-05-12T10:00:00.000Z'),
      });

      const result = await dc({
        scope: 'peer-eth',
        assetCode: 'ETH',
        currentLifetime: '999999999999999999',
      });
      expect(result.today).toBe('499999999999999999');
    } finally {
      teardown();
    }
  });

  it('[case 12] 9500-entry fixture: DeltaComputer call <100ms AND <2MB', async () => {
    const path = setup();
    try {
      // Generate deterministic fixture: 9500 hourly snapshots for one peer × one asset.
      const startMs = new Date('2025-04-12T00:00:00.000Z').getTime();
      const lines: string[] = [];
      for (let i = 0; i < 9500; i++) {
        const ts = new Date(startMs + i * 3_600_000).toISOString();
        const entry: SnapshotEntry = {
          ts,
          peerId: 'peer-1',
          assetCode: 'USD',
          claimsReceivedTotal: String(1000000 + i * 100),
        };
        lines.push(JSON.stringify(entry));
      }
      writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });

      // Assert file size < 2MB.
      const fileSize = statSync(path).size;
      expect(fileSize).toBeLessThan(2 * 1024 * 1024);

      const dc = createDeltaComputer({
        snapshotPath: path,
        now: () => new Date('2026-05-12T15:00:00.000Z'),
      });

      const t0 = performance.now();
      await dc({
        scope: 'peer-1',
        assetCode: 'USD',
        currentLifetime: '2000000000',
      });
      const elapsed = performance.now() - t0;

      expect(elapsed).toBeLessThan(100);
    } finally {
      teardown();
    }
  });
});
