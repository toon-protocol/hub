/**
 * Hourly earnings snapshot writer (Story 47.3).
 *
 * Persists `claimsReceivedTotal` per (peerId × assetCode) — plus apex
 * `connectorFees[]` rows under `peerId: '__apex__'` — to
 * `${dirname(configPath)}/earnings-snapshots.jsonl` once per hour. Consumed
 * by `snapshot-reader.ts`'s `DeltaComputer` factory. Failure mode: any
 * per-tick error is logged via `logger.warn` and swallowed (the writer NEVER
 * throws into the apex event loop) — the next tick retries cleanly. Pruning
 * runs after each successful append (entries older than 13 months are
 * rewritten atomically). File mode is `0o600` on every write.
 *
 * @module
 * @since 47.3
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { ConnectorAdminClient } from '../connector/index.js';

/**
 * One JSONL row in `earnings-snapshots.jsonl`.
 *
 * NOTE: apex routing-fee rows use `peerId: '__apex__'`. The field name
 * `claimsReceivedTotal` is technically a misnomer for apex rows — those
 * are connector routing fees, not received claims — but the uniform column
 * name keeps the JSONL schema simple and the reader doesn't need a special
 * case.
 */
export interface SnapshotEntry {
  /** ISO-8601 UTC timestamp of the tick boundary (e.g. '2026-05-12T15:00:00.000Z'). */
  ts: string;
  /** Connector peerId, OR the literal `'__apex__'` for apex routing-fee rows. */
  peerId: string;
  assetCode: string;
  /** Decimal-string cumulative (claims received for peers, routing-fee total for apex). */
  claimsReceivedTotal: string;
}

export interface SnapshotWriterOptions {
  connectorAdmin: ConnectorAdminClient;
  /** Absolute path to `earnings-snapshots.jsonl`. */
  snapshotPath: string;
  /** Tick interval (ms). Default 3_600_000 (1 hour). */
  tickIntervalMs?: number;
  /** Injected clock for tests. Default `() => new Date()`. */
  now?: () => Date;
  /** Retention window in months. Default 13. */
  retentionMonths?: number;
  /** pino/Fastify-compatible logger; warn-only. */
  logger?: { warn(obj: object, msg?: string): void };
  /**
   * Fire one tick immediately on `start()` instead of waiting for the first
   * interval. Default `false` (production). Tests set this to `true` to
   * assert append behavior without advancing fake timers.
   */
  fireOnStart?: boolean;
}

export class SnapshotWriter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickPending = false;

  constructor(private readonly opts: SnapshotWriterOptions) {}

  start(): void {
    // Idempotent — calling start() twice without stop() must not leak the first timer.
    if (this.timer !== null) return;
    const intervalMs = this.opts.tickIntervalMs ?? 3_600_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    if (this.opts.fireOnStart) {
      void this.tick();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for test ergonomics — runs one full append+prune cycle. */
  async tick(): Promise<void> {
    if (this.tickPending) {
      // Log the skip so operators can detect a wedged getEarnings (hours of silent no-ops otherwise).
      this.opts.logger?.warn(
        { snapshotPath: this.opts.snapshotPath },
        'snapshot writer: tick skipped — previous tick still in flight'
      );
      return;
    }
    this.tickPending = true;
    try {
      await this.runTick();
    } finally {
      this.tickPending = false;
    }
  }

  private async runTick(): Promise<void> {
    const now = (this.opts.now ?? (() => new Date()))();
    const tsMs = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    const ts = new Date(tsMs).toISOString();

    let earnings: Awaited<ReturnType<ConnectorAdminClient['getEarnings']>>;
    try {
      earnings = await this.opts.connectorAdmin.getEarnings();
    } catch (err) {
      this.opts.logger?.warn(
        { err },
        'snapshot writer: getEarnings failed — skipping this tick'
      );
      return;
    }

    // Wrap append + prune so any fs error (ENOSPC, EACCES, EROFS, EIO, EXDEV)
    // is contained — the writer NEVER throws into the apex event loop.
    try {
      const entries: SnapshotEntry[] = [];
      for (const peer of earnings.peers ?? []) {
        if (peer.peerId === '__apex__') {
          // Defensive: a connector-side peer literally named '__apex__' would
          // collide with the apex routing-fee sentinel. Skip and warn once.
          this.opts.logger?.warn(
            { peerId: peer.peerId },
            'snapshot writer: peer with reserved id "__apex__" — row dropped'
          );
          continue;
        }
        for (const a of peer.byAsset ?? []) {
          entries.push({
            ts,
            peerId: peer.peerId,
            assetCode: a.assetCode,
            claimsReceivedTotal: a.claimsReceivedTotal,
          });
        }
      }
      for (const fee of earnings.connectorFees ?? []) {
        entries.push({
          ts,
          peerId: '__apex__',
          assetCode: fee.assetCode,
          claimsReceivedTotal: fee.total,
        });
      }

      if (entries.length === 0) {
        // Nothing to write — but still try pruning.
        await this.pruneIfNeeded(now);
        return;
      }

      await this.appendEntries(entries);
      await this.pruneIfNeeded(now);
    } catch (err) {
      this.opts.logger?.warn(
        { err },
        'snapshot writer: append/prune failed — skipping this tick'
      );
    }
  }

  private async appendEntries(entries: SnapshotEntry[]): Promise<void> {
    // Always mkdir + chmod: directory or file may be deleted between ticks
    // (operator cleanup, container restart). Both ops are cheap-idempotent.
    await fs.mkdir(dirname(this.opts.snapshotPath), {
      recursive: true,
      mode: 0o700,
    });

    const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(this.opts.snapshotPath, body, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    // `appendFile`'s `mode` is ignored if the file already exists; chmod ensures
    // 0o600 on both first-create and subsequent appends.
    await fs.chmod(this.opts.snapshotPath, 0o600);
  }

  private async pruneIfNeeded(now: Date): Promise<void> {
    const WATERMARK = 256 * 1024; // 256 KB
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(this.opts.snapshotPath);
    } catch {
      return; // File doesn't exist yet — nothing to prune.
    }
    if (stat.size < WATERMARK) return;

    const retentionMonths = this.opts.retentionMonths ?? 13;
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - retentionMonths);
    const cutoffMs = cutoff.getTime();

    let raw: string;
    try {
      raw = await fs.readFile(this.opts.snapshotPath, 'utf-8');
    } catch {
      return;
    }

    const lines = raw.split('\n').filter((l) => l.length > 0);
    let anyDropped = false;
    const kept: string[] = [];
    for (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        anyDropped = true;
        continue; // drop malformed line (lazy compaction)
      }
      if (!isSnapshotEntry(entry)) {
        anyDropped = true;
        continue;
      }
      const entryMs = new Date(entry.ts).getTime();
      if (isNaN(entryMs) || entryMs < cutoffMs) {
        anyDropped = true;
      } else {
        kept.push(line);
      }
    }

    if (!anyDropped) return; // No rewrite needed.

    const tmpPath = `${this.opts.snapshotPath}.tmp`;
    const newContent = kept.length > 0 ? kept.join('\n') + '\n' : '';
    await fs.writeFile(tmpPath, newContent, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmpPath, this.opts.snapshotPath);
    await fs.chmod(this.opts.snapshotPath, 0o600);
  }
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
