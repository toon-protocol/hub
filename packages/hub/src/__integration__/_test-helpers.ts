/**
 * Shared helpers for Hub integration tests (Story 21.16, AC-5).
 *
 * Mirrors conventions from dev-stack-smoke.test.ts and connector-image-contract.test.ts:
 *   - isTruthyEnv: identical truthy-env parsing across every integration test file
 *   - runCli: spawns the real hub CLI binary as a long-lived subprocess,
 *             so `hub up` can keep the API + orchestrator alive until SIGTERM.
 *   - waitForExit: awaits subprocess exit with a timeout + SIGKILL fallback.
 *   - waitForUrl: polls a URL until HTTP 200 or deadline.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths ─────────────────────────────────────────────────────────────────────

const _DIR = fileURLToPath(import.meta.url);
// packages/hub/src/__integration__/_test-helpers.ts → workspace root
export const WORKSPACE_ROOT = join(_DIR, '..', '..', '..', '..', '..');

/** Path to the built hub CLI binary. Requires `pnpm build` to have run. */
export const CLI_BIN = join(
  WORKSPACE_ROOT,
  'packages',
  'hub',
  'dist',
  'cli.js'
);

/** Path to the hub-test-infra.sh script. */
export const INFRA_SCRIPT = join(
  WORKSPACE_ROOT,
  'scripts',
  'hub-test-infra.sh'
);

// ── isTruthyEnv ───────────────────────────────────────────────────────────────

/** Truthy-value parser for env flags: accepts 1/true/yes (case-insensitive). */
export function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

// ── apex target resolution (Phase 5: HS vs direct) ──────────────────────────

/**
 * Whether the live loop is running against a DIRECT-BTP apex (Phase 5) rather
 * than the hidden-service apex. The orchestrator
 * (`scripts/hub-e2e-local-hs.sh up` with `TRANSPORT_MODE=direct`) does not
 * publish a `.anon`/`host.json`; the client routes by env (`APEX_BTP_URL`), so
 * the smoke's publish body just needs a placeholder `targetHostname` the
 * entrypoint ignores. Selected via `TRANSPORT=direct` or `DIRECT_BTP=1`.
 */
export function isDirectTransport(): boolean {
  const t = process.env['TRANSPORT']?.trim().toLowerCase();
  return t === 'direct' || isTruthyEnv(process.env['DIRECT_BTP']);
}

export interface ApexTarget {
  /** 'direct' (no .anon) or 'hs' (hidden-service). */
  mode: 'direct' | 'hs';
  /**
   * The `targetHostname` to send in POST /publish. In HS mode this is the real
   * `.anon` hostname (read from host.json by the caller); in direct mode it is a
   * placeholder the entrypoint ignores (routing is env-driven via APEX_BTP_URL).
   */
  targetHostname: string;
}

/**
 * Resolve the publish `targetHostname` for the active transport.
 *
 * - HS mode: requires `host.json` (the orchestrator wrote the published .anon
 *   hostname there); the supplied `readHostJson` callback returns it.
 * - direct mode: returns a static placeholder — there is no `.anon`/host.json,
 *   and the client's direct-BTP routing ignores `targetHostname`.
 *
 * Keeping the HS branch behind a callback lets each smoke keep its existing
 * host.json read + regex assertion verbatim while sharing the direct branch.
 */
export function resolveApexTarget(readHostJson: () => string): ApexTarget {
  if (isDirectTransport()) {
    return { mode: 'direct', targetHostname: 'direct.local' };
  }
  return { mode: 'hs', targetHostname: readHostJson() };
}

// ── runCli ────────────────────────────────────────────────────────────────────

export interface RunCliOptions {
  /** Temp config directory:
   *  - `init`/`setup` commands: passed as --config-dir <configDir>
   *  - `up`/`down`/`status` commands: passed as -c <configDir>/config.yaml */
  configDir: string;
  /** Wallet password passed via --password (non-interactive mode). */
  password?: string;
  /** Additional env vars merged with process.env. */
  env?: NodeJS.ProcessEnv;
  /** Extra positional or flag args appended after the fixed args. */
  extraArgs?: string[];
}

export interface RunCliResult {
  process: ChildProcess;
  /** Collected stdout lines (appended as they arrive; useful for grep on failure). */
  stdout: string[];
  /** Collected stderr lines (inherits to test output by default). */
  stderr: string[];
}

/**
 * Spawn the real `hub` CLI binary as a subprocess.
 *
 * Uses `spawn` (NOT `execSync`) so long-running commands like `up` can be kept
 * alive indefinitely and killed by the test via SIGTERM when done.
 *
 * Stdout is piped to a buffer for post-failure grep; stderr inherits so
 * diagnostics appear inline in the test runner output.
 *
 * @param command - CLI command: 'init' | 'up' | 'down' | 'status'
 * @param opts - configDir, password, env overrides, extraArgs
 */
export function runCli(command: string, opts: RunCliOptions): RunCliResult {
  const { configDir, password, env = {}, extraArgs = [] } = opts;

  const cliArgs: string[] = [command];

  // Routing: init/setup take --config-dir; up/down/status take -c <yaml>
  if (command === 'init' || command === 'setup') {
    cliArgs.push('--config-dir', configDir);
  } else {
    cliArgs.push('-c', join(configDir, 'config.yaml'));
  }

  if (password) {
    cliArgs.push('--password', password);
  }

  cliArgs.push(...extraArgs);

  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };

  // Strip vitest's --experimental-vm-modules injection so it doesn't bleed
  // into the CLI subprocess and cause Node version warnings.
  delete mergedEnv['NODE_OPTIONS'];

  const child = spawn('node', [CLI_BIN, ...cliArgs], {
    env: mergedEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: false,
  });

  const result: RunCliResult = { process: child, stdout: [], stderr: [] };

  child.stdout?.on('data', (chunk: Buffer) => {
    result.stdout.push(chunk.toString());
  });

  return result;
}

// ── waitForExit ───────────────────────────────────────────────────────────────

/**
 * Await CLI subprocess exit; SIGKILL + reject if it exceeds `timeoutMs`.
 */
export function waitForExit(
  child: ChildProcess,
  timeoutMs = 30_000
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI subprocess did not exit within ${timeoutMs} ms`));
    }, timeoutMs);

    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── waitForUrl ────────────────────────────────────────────────────────────────

/**
 * Poll a URL until it responds HTTP 200, or throw after the deadline.
 *
 * @param url - Full URL to poll (e.g. 'http://127.0.0.1:9401/health')
 * @param opts.maxMs - Give up after this many ms (default: 90 000)
 * @param opts.intervalMs - Pause between polls (default: 2 000)
 * @param opts.label - Human-readable name for error messages
 */
export async function waitForUrl(
  url: string,
  {
    maxMs = 90_000,
    intervalMs = 2_000,
    label = url,
  }: { maxMs?: number; intervalMs?: number; label?: string } = {}
): Promise<void> {
  const deadline = Date.now() + maxMs;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), intervalMs);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `${label} did not become healthy within ${maxMs} ms. Last error: ${msg}`
  );
}
