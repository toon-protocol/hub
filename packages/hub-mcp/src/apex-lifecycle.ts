/**
 * Apex bring-up. NOT a daemon (the apex is Docker-resident); this only handles
 * the long-running `hub up` / `hs up` bootstrap. We reuse client-mcp's
 * detached-spawn + append-log idiom (detached + `unref()` + `openSync(log,'a')`)
 * for a different reason than client-mcp: `hub up` is a bootstrap command
 * that EXITS once Docker containers are started — Docker holds the long-lived
 * apex. Detaching + logging NDJSON to <configDir>/up.log lets a multi-minute
 * boot survive the ephemeral MCP session, and lets `up_status` read progress
 * regardless of MCP-process lifetime. See docs/hub-mcp-design.md §0/§5.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiClient } from './api-client.js';
import type { ResolvedConfig } from './config.js';

/** Path of the NDJSON boot-progress log. */
export function upLogPath(cfg: ResolvedConfig): string {
  return join(cfg.configDir, 'up.log');
}

/** Parsed view of the boot-progress log. */
export interface UpStatus {
  /** Parsed NDJSON progress events (best-effort; non-JSON lines skipped). */
  events: unknown[];
  /** True once a terminal `done`/`error` step has been observed. */
  done: boolean;
  /** True if the last terminal step was an error. */
  failed: boolean;
}

/** Is the apex API answering? */
export function isApexReachable(api: ApiClient): Promise<boolean> {
  return api.ping();
}

/**
 * Spawn `hub up` (or `hs up`) DETACHED, NDJSON progress appended to
 * up.log. Returns the child pid. The caller returns a handle immediately and
 * the agent polls {@link readUpStatus}; this never blocks on the full boot.
 */
export function spawnUpDetached(
  cfg: ResolvedConfig,
  transport: 'direct' | 'hs' = 'direct'
): number {
  mkdirSync(cfg.configDir, { recursive: true });
  // 'a' so restarts append rather than truncate the operator's boot history.
  const out = openSync(upLogPath(cfg), 'a');
  const args = transport === 'hs' ? ['hs', 'up', '--json'] : ['up', '--json'];
  const child = spawn(cfg.hubBin, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      ...(cfg.mnemonic ? { TOWNHOUSE_MNEMONIC: cfg.mnemonic } : {}),
      TOWNHOUSE_CONFIG_DIR: cfg.configDir,
    },
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error('Failed to spawn `hub up` (no pid)');
  }
  return child.pid;
}

/**
 * Read the latest boot progress from up.log. NDJSON, partial-line-safe (a
 * trailing half-written line is simply skipped). A terminal step is an event
 * whose `step` is `done` or `error`.
 */
export function readUpStatus(cfg: ResolvedConfig): UpStatus {
  const path = upLogPath(cfg);
  if (!existsSync(path)) return { events: [], done: false, failed: false };
  const raw = readFileSync(path, 'utf8');
  const events: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* skip partial / non-JSON line */
    }
  }
  let done = false;
  let failed = false;
  for (const e of events) {
    const step = (e as { step?: unknown }).step;
    if (step === 'done') {
      done = true;
      failed = false;
    } else if (step === 'error') {
      done = true;
      failed = true;
    }
  }
  return { events, done, failed };
}

/**
 * If AUTOUP is enabled and the apex is down, kick off `up` once. Best-effort
 * and non-blocking — failures surface as readable tool errors later. A
 * lightweight in-flight guard (an unfinished up.log) prevents double-up.
 */
export async function autoUpIfEnabled(
  api: ApiClient,
  cfg: ResolvedConfig
): Promise<void> {
  if (!cfg.autoUp) return;
  if (await isApexReachable(api)) return;
  const status = readUpStatus(cfg);
  if (status.events.length > 0 && !status.done) return; // an up is in flight
  try {
    spawnUpDetached(cfg, cfg.transport);
  } catch {
    /* surfaced via tool errors */
  }
}
