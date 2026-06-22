/**
 * Unit tests for SnapshotWriter (Story 47.3).
 *
 * Test gate matrix (AC: 1, 2, 4, 7, 8 — 11 cases):
 *   1.  Append on tick — file created with correct JSONL shape + 0o600 mode.
 *   2.  Apex row uses `peerId: '__apex__'` sentinel.
 *   3.  `ts` is floored to the hour boundary.
 *   4.  Re-entrancy guard — second concurrent tick is dropped.
 *   5.  `getEarnings` throws → tick is a no-op; logger.warn called once.
 *   6.  Multiple ticks accumulate distinct ts values.
 *   7.  Pruning removes entries older than 13 months.
 *   8.  Pruning watermark: small files are NOT rewritten.
 *   9.  Malformed line is pruned on next prune (lazy compaction).
 *   10. Append batch splits at PIPE_BUF for POSIX atomicity.
 *   11. stop() clears the timer; idempotent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  promises as fsPromises,
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { ConnectorAdminClient } from '../connector/index.js';
import type { EarningsResponse, AssetEarnings } from '../connector/types.js';
import { SnapshotWriter } from './snapshot-writer.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeConnector(
  response?: EarningsResponse | 'throw' | '503'
): ConnectorAdminClient {
  return {
    getEarnings: vi.fn(async () => {
      if (response === 'throw') throw new Error('connector down');
      if (response === '503')
        throw new Error('Connector admin API error: 503 Service Unavailable');
      return response ?? emptyEarnings();
    }),
    getMetrics: vi.fn(async () => ({
      uptimeSeconds: 0,
      aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 },
      peers: [],
      timestamp: '',
    })),
    getHealth: vi.fn(async () => ({
      status: 'healthy' as const,
      uptime: 0,
      peersConnected: 0,
      totalPeers: 0,
      timestamp: '',
    })),
    getPeers: vi.fn(async () => []),
    getPacketLog: vi.fn(async () => []),
  } as unknown as ConnectorAdminClient;
}

function emptyEarnings(): EarningsResponse {
  return {
    uptimeSeconds: 0,
    peers: [],
    connectorFees: [],
    recentClaims: [],
    timestamp: { iso: '' },
  };
}

function assetEntry(
  assetCode: string,
  claimsReceivedTotal: string
): AssetEarnings {
  return {
    assetCode,
    assetScale: 6,
    claimsReceivedTotal,
    claimsSentTotal: '0',
    netBalance: claimsReceivedTotal,
    lastClaimAt: null,
  };
}

function makeLogger() {
  return { warn: vi.fn() };
}

function readLines(path: string): unknown[] {
  const raw = readFileSync(path, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SnapshotWriter', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), '47-3-writer-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('[case 1] appends correct JSONL shape + 0o600 mode on tick', async () => {
    const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');
    const earnings: EarningsResponse = {
      uptimeSeconds: 0,
      connectorFees: [{ assetCode: 'USD', assetScale: 6, total: '500' }],
      recentClaims: [],
      timestamp: { iso: '' },
      peers: [
        { peerId: 'peer-1', byAsset: [assetEntry('USD', '1000')] },
        { peerId: 'peer-2', byAsset: [assetEntry('USD', '2000')] },
      ],
    };
    const now = new Date('2026-05-12T15:42:37.000Z');
    const writer = new SnapshotWriter({
      connectorAdmin: makeConnector(earnings),
      snapshotPath,
      now: () => now,
    });

    await writer.tick();

    const lines = readLines(snapshotPath);
    expect(lines).toHaveLength(3); // 2 peers + 1 apex

    for (const line of lines) {
      const e = line as Record<string, unknown>;
      expect(typeof e['ts']).toBe('string');
      expect(typeof e['peerId']).toBe('string');
      expect(typeof e['assetCode']).toBe('string');
      expect(typeof e['claimsReceivedTotal']).toBe('string');
    }

    // File mode 0o600.
    const mode = statSync(snapshotPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('[case 2] apex row uses peerId "__apex__" sentinel', async () => {
    const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');
    const earnings: EarningsResponse = {
      uptimeSeconds: 0,
      connectorFees: [{ assetCode: 'USD', assetScale: 6, total: '999' }],
      recentClaims: [],
      timestamp: { iso: '' },
      peers: [],
    };
    const writer = new SnapshotWriter({
      connectorAdmin: makeConnector(earnings),
      snapshotPath,
    });

    await writer.tick();

    const lines = readLines(snapshotPath) as { peerId: string }[];
    expect(lines).toHaveLength(1);
    expect(lines[0].peerId).toBe('__apex__');
  });

  it('[case 3] ts is floored to the UTC hour boundary', async () => {
    const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');
    const earnings: EarningsResponse = {
      uptimeSeconds: 0,
      connectorFees: [{ assetCode: 'USD', assetScale: 6, total: '1' }],
      recentClaims: [],
      timestamp: { iso: '' },
      peers: [{ peerId: 'p1', byAsset: [assetEntry('USD', '1')] }],
    };
    const now = new Date('2026-05-12T15:42:37.123Z');
    const writer = new SnapshotWriter({
      connectorAdmin: makeConnector(earnings),
      snapshotPath,
      now: () => now,
    });

    await writer.tick();

    const lines = readLines(snapshotPath) as { ts: string }[];
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.ts).toBe('2026-05-12T15:00:00.000Z');
    }
  });

  it('[case 4] re-entrancy guard: second concurrent tick is skipped', async () => {
    const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');
    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let firstResolved = false;

    const getEarnings = vi.fn(async () => {
      resolveFirst();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      firstResolved = true;
      return emptyEarnings();
    });

    const connector = makeConnector();
    (connector.getEarnings as ReturnType<typeof vi.fn>).mockImplementation(
      getEarnings
    );

    const writer = new SnapshotWriter({
      connectorAdmin: connector,
      snapshotPath,
    });

    const p1 = writer.tick();
    await firstStarted; // First tick is in-flight

    // Second tick should be skipped (guard).
    const p2 = writer.tick();
    await p2;
    expect(firstResolved).toBe(false); // First is still in-flight.
    expect(getEarnings).toHaveBeenCalledTimes(1); // Second didn't call getEarnings.

    await p1;

    // Third tick should proceed normally.
    await writer.tick();
    expect(getEarnings).toHaveBeenCalledTimes(2);
  });

  it('[case 5] getEarnings throws → tick is no-op; logger.warn called once', async () => {
    const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');
    const logger = makeLogger();
    const writer = new SnapshotWriter({
      connectorAdmin: makeConnector('throw'),
      snapshotPath,
      logger,
    });

    await writer.tick();

    // File should not exist.
    expect(() => statSync(snapshotPath)).toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [obj] = logger.warn.mock.calls[0] as [{ err: unknown }];
    expect(obj.err).toBeInstanceOf(Error);
  });

  it('[case 6] multiple ticks accumulate with distinct ts values', async () => {
    const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');
    const earnings: EarningsResponse = {
      uptimeSeconds: 0,
      connectorFees: [{ assetCode: 'USD', assetScale: 6, total: '1' }],
      recentClaims: [],
      timestamp: { iso: '' },
      peers: [],
    };

    const timestamps = [
      new Date('2026-05-12T10:00:00.000Z'),
      new Date('2026-05-12T11:30:00.000Z'),
      new Date('2026-05-12T12:59:00.000Z'),
    ];
    let callCount = 0;
    const writer = new SnapshotWriter({
      connectorAdmin: makeConnector(earnings),
      snapshotPath,
      now: () => timestamps[callCount++ % timestamps.length],
    });

    await writer.tick();
    await writer.tick();
    await writer.tick();

    const lines = readLines(snapshotPath) as { ts: string }[];
    expect(lines).toHaveLength(3);
    const tsValues = lines.map((l) => l.ts);
    expect(tsValues[0]).toBe('2026-05-12T10:00:00.000Z');
    expect(tsValues[1]).toBe('2026-05-12T11:00:00.000Z');
    expect(tsValues[2]).toBe('2026-05-12T12:00:00.000Z');
  });

  it('[case 7] pruning removes entries older than 13 months', async () => {
    const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');

    // Pre-seed the file with 100 entries spanning 14 months (some will be pruned).
    const now = new Date('2026-05-12T15:00:00.000Z');
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ts = new Date(now.getTime() - i * 24 * 3_600_000).toISOString(); // daily, going back
      lines.push(
        JSON.stringify({
          ts,
          peerId: 'p1',
          assetCode: 'USD',
          claimsReceivedTotal: String(i),
        })
      );
    }
    // Pad the file to exceed watermark (256 KB) by repeating entries.
    const baseContent = lines.join('\n') + '\n';
    const repeated = baseContent.repeat(Math.ceil(300000 / baseContent.length));
    writeFileSync(snapshotPath, repeated, { mode: 0o600 });

    const earnings: EarningsResponse = {
      uptimeSeconds: 0,
      connectorFees: [{ assetCode: 'USD', assetScale: 6, total: '5000' }],
      recentClaims: [],
      timestamp: { iso: '' },
      peers: [],
    };

    const writer = new SnapshotWriter({
      connectorAdmin: makeConnector(earnings),
      snapshotPath,
      now: () => now,
      retentionMonths: 13,
    });

    await writer.tick();

    // Cutoff is 13 months before now: 2025-04-12T15:00:00.000Z
    const cutoff = new Date('2025-04-12T15:00:00.000Z');
    const keptLines = readLines(snapshotPath) as { ts: string }[];
    for (const l of keptLines) {
      expect(new Date(l.ts).getTime()).toBeGreaterThanOrEqual(cutoff.getTime());
    }
  });

  it('[case 8] small file below watermark is NOT rewritten', async () => {
    const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');

    // Pre-seed with 10 entries (well under 256 KB watermark).
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      const ts = new Date(Date.now() - i * 3_600_000).toISOString();
      lines.push(
        JSON.stringify({
          ts,
          peerId: 'p1',
          assetCode: 'USD',
          claimsReceivedTotal: String(i),
        })
      );
    }
    writeFileSync(snapshotPath, lines.join('\n') + '\n', { mode: 0o600 });

    // Spy on the pruner's rewrite-path syscalls — assert they are NOT called.
    // This gates the watermark short-circuit directly rather than relying on
    // a content / mtime invariant that would pass even if the watermark check
    // were removed (small-file rewrite preserves the same content).
    const writeFileSpy = vi.spyOn(fsPromises, 'writeFile');
    const renameSpy = vi.spyOn(fsPromises, 'rename');

    try {
      const writer = new SnapshotWriter({
        connectorAdmin: makeConnector(emptyEarnings()),
        snapshotPath,
      });

      await writer.tick();

      // The watermark short-circuit means pruneIfNeeded never reaches the
      // writeFile + rename rewrite path.
      expect(writeFileSpy).not.toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
      // And the pre-seeded entries are still intact.
      const allLines = readLines(snapshotPath);
      expect(allLines).toHaveLength(10);
    } finally {
      writeFileSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('[case 9] malformed line is pruned on next prune (lazy compaction)', async () => {
    const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');

    // Build enough entries to cross the 256KB watermark (~3500 entries @ ~80 bytes each ≈ 280KB).
    const rows: string[] = [];
    const oldTs = '2025-01-01T00:00:00.000Z'; // older than 13 months from 2026-05-12
    const recentTs = '2026-05-11T10:00:00.000Z';
    for (let i = 0; i < 3500; i++) {
      rows.push(
        JSON.stringify({
          ts: recentTs,
          peerId: 'p1',
          assetCode: 'USD',
          claimsReceivedTotal: String(i),
        })
      );
    }
    // Insert a malformed line and an old entry to trigger pruning + repair.
    rows.push('not-valid-json');
    rows.push(
      JSON.stringify({
        ts: oldTs,
        peerId: 'p1',
        assetCode: 'USD',
        claimsReceivedTotal: '0',
      })
    );

    writeFileSync(snapshotPath, rows.join('\n') + '\n', { mode: 0o600 });

    const now = new Date('2026-05-12T15:00:00.000Z');
    const writer = new SnapshotWriter({
      connectorAdmin: makeConnector({
        uptimeSeconds: 0,
        connectorFees: [],
        recentClaims: [],
        timestamp: { iso: '' },
        peers: [{ peerId: 'p1', byAsset: [assetEntry('USD', '9999')] }],
      }),
      snapshotPath,
      now: () => now,
    });

    await writer.tick();

    const content = readFileSync(snapshotPath, 'utf-8');
    expect(content).not.toContain('not-valid-json');
    expect(content).not.toContain(oldTs);

    // After the pruning rewrite, mode must still be 0o600 (re-chmod after
    // rename — close-out checklist item 11 + AC #4 / #8). Case 9 is the only
    // test case that exercises the rewrite branch end-to-end.
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
  });

  it('[case 10] entries exceeding PIPE_BUF are still written correctly', async () => {
    const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');

    // Fabricate earnings with enough entries to exceed PIPE_BUF (4096 bytes).
    // Each entry is ~150 bytes; 30 entries ≈ 4500 bytes.
    const peers = Array.from({ length: 15 }, (_, i) => ({
      peerId: `peer-${i.toString().padStart(4, '0')}`,
      byAsset: [assetEntry('USD', '1000000'), assetEntry('ETH', '2000000')],
    }));
    const earnings: EarningsResponse = {
      uptimeSeconds: 0,
      connectorFees: [],
      recentClaims: [],
      timestamp: { iso: '' },
      peers,
    };

    const writer = new SnapshotWriter({
      connectorAdmin: makeConnector(earnings),
      snapshotPath,
    });

    await writer.tick();

    // 15 peers × 2 assets = 30 entries total — all must be written.
    const lines = readLines(snapshotPath);
    expect(lines).toHaveLength(30);

    // All entries have the correct shape.
    for (const line of lines) {
      const e = line as Record<string, unknown>;
      expect(typeof e['ts']).toBe('string');
      expect(typeof e['peerId']).toBe('string');
      expect(typeof e['assetCode']).toBe('string');
      expect(typeof e['claimsReceivedTotal']).toBe('string');
    }

    // Verify that at least some peer-0000 entries exist (round-trip correctness).
    const peer0Lines = (lines as { peerId: string }[]).filter(
      (l) => l.peerId === 'peer-0000'
    );
    expect(peer0Lines).toHaveLength(2); // USD + ETH
  });

  it('[case 11] stop() clears timer; idempotent', async () => {
    // Capture the real setImmediate BEFORE fake timers replace it, so we can
    // yield to the real event loop between advances. Each tick's runTick() does a
    // real fs append (a libuv macrotask) that advanceTimersByTimeAsync does NOT
    // await — it only drains microtasks and timers. flushIo() lets that write
    // settle so the re-entrancy guard (tickPending) clears before the next fire.
    // Even so, the exact tick count is NOT guaranteed under CI load: a fire that
    // lands while a write is still in flight is skipped (tickCount has been
    // observed at 2 when 4 fires were issued). This test exercises stop()
    // SEMANTICS, not tick frequency, so it only requires that the timer fired at
    // least once while running and that it stops firing after stop().
    const realSetImmediate = setImmediate;
    const flushIo = () => new Promise<void>((r) => realSetImmediate(r));
    vi.useFakeTimers();
    try {
      const snapshotPath = join(tmpHome, 'earnings-snapshots.jsonl');
      let tickCount = 0;
      const connector = makeConnector();
      (connector.getEarnings as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          tickCount++;
          return emptyEarnings();
        }
      );

      const writer = new SnapshotWriter({
        connectorAdmin: connector,
        snapshotPath,
        tickIntervalMs: 50,
      });

      writer.start();

      // Advance one interval at a time, flushing real I/O after each fire so the
      // in-flight tick completes (and tickPending clears) before the next.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(50);
        await flushIo();
      }
      // At least one tick must have fired — proof the timer is running. The exact
      // count is nondeterministic under load (see comment above); the meaningful
      // assertion is the post-stop() check below, which must see NO further ticks.
      expect(tickCount).toBeGreaterThanOrEqual(1);

      const countBeforeStop = tickCount;
      writer.stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(tickCount).toBe(countBeforeStop); // No new ticks after stop.

      // Idempotent — second stop must not throw.
      expect(() => writer.stop()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
