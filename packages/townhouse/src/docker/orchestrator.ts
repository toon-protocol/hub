/**
 * Docker Orchestration Engine for Townhouse (Story 21.2).
 *
 * Manages the full container lifecycle: network creation, image pulling,
 * container creation/start/stop/removal, and health check polling.
 * Uses dockerode for programmatic Docker control with DI for testability.
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type Docker from 'dockerode';
import type { TownhouseConfig } from '../config/schema.js';
import { ConnectorConfigGenerator } from '../connector/config-generator.js';
import { ConnectorAdminClient } from '../connector/admin-client.js';
import type { ComposeProfile } from '../compose-loader.js';
import {
  CONTAINER_PREFIX,
  TOWN_HEALTH_PORT,
  MILL_HEALTH_PORT,
  DVM_HEALTH_PORT,
} from '../constants.js';
import type { NodeType, HealthCheckOptions, BandwidthStats } from './types.js';
import type { WalletManager } from '../wallet/index.js';

interface RunDockerOptions {
  timeout?: number;
  maxBuffer?: number;
  inheritStdio?: boolean;
  /** Override the subprocess env. Defaults to process.env when omitted. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `docker <args>` as a child process and resolve with captured stderr/stdout.
 *
 * `inheritStdio: true` pipes the child's stdout straight to the parent's TTY so
 * the operator sees `docker pull` progress during a multi-minute first-time
 * pull (Story 45.3 AC #10). Stderr is always captured so we can surface
 * compose failure diagnostics through the `containerState` event channel.
 */
function runDockerCompose(
  file: string,
  args: readonly string[],
  options: RunDockerOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const {
    timeout,
    maxBuffer = 16 * 1024 * 1024,
    inheritStdio = false,
    env,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(file, Array.from(args), {
      stdio: inheritStdio
        ? ['ignore', 'inherit', 'pipe']
        : ['ignore', 'pipe', 'pipe'],
      ...(env !== undefined ? { env } : {}),
    });
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    let stderrLen = 0;
    let stdoutLen = 0;
    let timedOut = false;
    const timer =
      timeout !== undefined && timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // Force-kill if SIGTERM is ignored (5 s grace).
            setTimeout(() => {
              if (!child.killed) child.kill('SIGKILL');
            }, 5_000).unref();
          }, timeout)
        : null;
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLen < maxBuffer) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });
    // Capture stdout when piped (inheritStdio: false). When stdio inherits to
    // the parent TTY, child.stdout is null and we leave stdoutChunks empty —
    // the operator sees the output directly.
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLen < maxBuffer) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      if (timedOut) {
        const err = new Error(
          `docker subprocess timed out after ${timeout}ms`
        ) as Error & {
          stdout?: string;
          stderr?: string;
          code?: number | string;
          signal?: NodeJS.Signals | null;
        };
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = 'ETIMEDOUT';
        err.signal = signal;
        return reject(err);
      }
      if (code === 0) {
        return resolve({ stdout, stderr });
      }
      const err = new Error(
        `docker subprocess exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`
      ) as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        signal?: NodeJS.Signals | null;
      };
      err.stdout = stdout;
      err.stderr = stderr;
      if (code !== null) err.code = code;
      if (signal !== null) err.signal = signal;
      reject(err);
    });
  });
}

type ExecFileAsyncSignature = (
  file: string,
  args: readonly string[],
  options?: RunDockerOptions
) => Promise<{ stdout: string; stderr: string }>;

/** Nostr relay WebSocket port on Town containers (fixed by Dockerfile) */
const TOWN_RELAY_PORT = 7100;

/** Container stats cache TTL in milliseconds */
const STATS_CACHE_TTL_MS = 5_000;

interface CachedStats {
  data: BandwidthStats | null;
  cachedAt: number;
}

/** Docker bridge network name */
const NETWORK_NAME = 'townhouse-net';

/** Default images for node types (used when not overridden in config) */
const DEFAULT_NODE_IMAGES: Record<NodeType, string> = {
  town: 'toon:town',
  mill: 'toon:mill',
  dvm: 'toon:dvm',
};

/** Maximum number of start retries per container */
const MAX_START_RETRIES = 3;

/** Internal connector port (Docker-internal, not exposed to host) */
const CONNECTOR_INTERNAL_PORT = 3000;

/** Default ator sidecar image tag for relay hidden service publication. */
const RELAY_ATOR_SIDECAR_IMAGE = 'toon:townhouse-ator-sidecar';

/**
 * SOCKS port for the relay-side ator sidecar. Distinct from the connector
 * HS sidecar's 9050 so the two can coexist on the same Docker network if
 * both transports are enabled.
 */
const RELAY_ATOR_SOCKS_PORT = 9051;

/**
 * Relay hidden-service sidecar wiring (HS mode). These are the HS compose's
 * ACTUAL network + town container names (compose/townhouse-hs.yml: network
 * `townhouse-hs-net`, town container `townhouse-hs-town`) — NOT the dev-profile
 * `NETWORK_NAME`/`${PREFIX}town` the legacy sidecar code used (which never
 * resolved). The keypair lives in a named volume so the `.anyone` address is
 * stable across `hs down`/`up`.
 */
const RELAY_HS_NETWORK = 'townhouse-hs-net';
const RELAY_HS_KEYS_VOLUME = `${CONTAINER_PREFIX}hs-relay-anon`;
const RELAY_SIDECAR_NAME = `${CONTAINER_PREFIX}hs-ator-sidecar-relay`;
const RELAY_HS_TARGET_HOST = `${CONTAINER_PREFIX}hs-town`;

/**
 * Error thrown by DockerOrchestrator HS-path failures (Story 45.3).
 * Carries the failed-service name + subprocess diagnostics so CLI consumers
 * (Story 45.4) can render Sally's failure-state copy library (UX-DR5).
 */
export class OrchestratorError extends Error {
  readonly service?: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  constructor(
    message: string,
    options: {
      service?: string;
      exitCode?: number;
      stderr?: string;
      cause?: Error;
    } = {}
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'OrchestratorError';
    if (options.service !== undefined) this.service = options.service;
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
    if (options.stderr !== undefined) this.stderr = options.stderr;
  }
}

/**
 * Strip secret-name env assignments from compose stderr before it becomes
 * part of an error message (Story 46.2 P5). Compose stderr can echo env
 * interpolation, including injected secrets. Conservative: keep the KEY so
 * operators see which secret was involved; redact only the VALUE up to the
 * next whitespace, quote, or newline.
 */
function redactSecretsInComposeStderr(stderr: string): string {
  const SECRET_KEYS = [
    'TOWN_SECRET_KEY',
    'MILL_SECRET_KEY',
    'DVM_SECRET_KEY',
    'TOWN_SETTLEMENT_PRIVATE_KEY',
    'MILL_SETTLEMENT_PRIVATE_KEY',
    'DVM_SETTLEMENT_PRIVATE_KEY',
    'MILL_MNEMONIC',
    'TOWNHOUSE_WALLET_PASSWORD',
    'TOWNHOUSE_MNEMONIC',
  ];
  const pattern = new RegExp(`(${SECRET_KEYS.join('|')})=[^\\s"'\\n\\r]+`, 'g');
  return stderr.replace(pattern, '$1=[REDACTED]');
}

/**
 * Normalize a Docker image reference to include an explicit tag.
 * Docker defaults to `:latest` when no tag is specified, but
 * `listImages()` RepoTags always include the explicit tag.
 * Without normalization, an untagged image like `nginx` would not
 * match `nginx:latest` in the local image cache check.
 */
function normalizeImageTag(image: string): string {
  // If there's already a tag (contains ':' after the last '/'), return as-is.
  // Handle registry prefixes like ghcr.io/org/image:tag
  const lastSlash = image.lastIndexOf('/');
  const nameAndTag = lastSlash >= 0 ? image.slice(lastSlash + 1) : image;
  if (nameAndTag.includes(':')) {
    return image;
  }
  return `${image}:latest`;
}

/**
 * DockerOrchestrator manages the lifecycle of Townhouse containers.
 *
 * Constructor accepts a dockerode instance (DI for testability) and config.
 * Emits typed events defined in OrchestratorEvents: pullProgress,
 * containerState, and healthCheck.
 */
export class DockerOrchestrator extends EventEmitter {
  private readonly docker: Docker;
  private readonly config: TownhouseConfig;
  private readonly configGenerator: ConnectorConfigGenerator;
  private readonly walletManager: WalletManager | undefined;
  private activeNodes: NodeType[] = [];
  private readonly statsCache = new Map<string, CachedStats>();
  private readonly profile: ComposeProfile;
  private readonly composePath: string | undefined;
  private readonly execFileAsync: ExecFileAsyncSignature;
  private readonly adminClientFactory: (
    baseUrl: string,
    timeoutMs: number
  ) => ConnectorAdminClient;

  constructor(
    docker: Docker,
    config: TownhouseConfig,
    walletManager?: WalletManager,
    options: {
      profile?: ComposeProfile;
      composePath?: string;
      execFileAsync?: ExecFileAsyncSignature;
      adminClientFactory?: (
        baseUrl: string,
        timeoutMs: number
      ) => ConnectorAdminClient;
    } = {}
  ) {
    super();
    this.docker = docker;
    this.config = config;
    this.configGenerator = new ConnectorConfigGenerator(config);
    this.walletManager = walletManager;
    this.profile = options.profile ?? 'dev';
    // Trim composePath so a whitespace-only string trips the same validation
    // as undefined / empty string (otherwise `   ` would slip past the falsy
    // check below and be passed verbatim to docker).
    const trimmedComposePath = options.composePath?.trim();
    this.composePath =
      trimmedComposePath !== undefined && trimmedComposePath.length > 0
        ? trimmedComposePath
        : undefined;
    this.execFileAsync = options.execFileAsync ?? runDockerCompose;
    this.adminClientFactory =
      options.adminClientFactory ??
      ((url, t) => new ConnectorAdminClient(url, t));

    // Both compose-driven profiles ('hs' and 'direct') require a composePath
    // pointing at the rendered template; 'dev' uses the dockerode path and
    // ignores composePath.
    if (
      (this.profile === 'hs' || this.profile === 'direct') &&
      !this.composePath
    ) {
      throw new OrchestratorError(
        `profile: '${this.profile}' requires a non-empty composePath. Pass ` +
          `options.composePath pointing at the rendered template (typically the ` +
          `composePath returned by materializeComposeTemplate('${this.profile}')).`
      );
    }
  }

  /**
   * Orchestrate full startup sequence. Branches on profile:
   * - 'dev' (default): dockerode-based, preserves existing dev-stack behavior
   * - 'hs': docker compose subprocess + HS hostname readiness gate
   * - 'direct': docker compose subprocess + connector /health readiness gate
   */
  async up(profiles: NodeType[]): Promise<void> {
    if (this.profile === 'hs') {
      await this.upHs(profiles);
      // defer activeNodes mutation until after upHs succeeds so a
      // failed/timed-out upHs does not leave phantom state.
      this.activeNodes = [...profiles];
    } else if (this.profile === 'direct') {
      await this.upDirect(profiles);
      this.activeNodes = [...profiles];
    } else {
      this.activeNodes = [...profiles];
      await this.upDev(profiles);
    }
  }

  private async upDev(profiles: NodeType[]): Promise<void> {
    await this.ensureNetwork();
    await this.pullImages(profiles);
    await this.startConnector();
    await this.waitForHealth('townhouse-connector');

    // Start all node containers in parallel
    await Promise.all(profiles.map((type) => this.startNode(type)));
    // The relay hidden-service sidecar (HS mode) is driven by the CLI via
    // ensureRelaySidecar() after the apex + town are up — not from the dev
    // profile path here.
  }

  /**
   * Narrow `this.composePath` to a definite string. The constructor enforces
   * this invariant for `profile: 'hs'`; this helper exists so the HS-path
   * methods don't need a non-null assertion (lint-clean) and so a constructor
   * regression surfaces as an `OrchestratorError` rather than a `TypeError`.
   */
  private requireComposePath(): string {
    if (!this.composePath) {
      throw new OrchestratorError(
        `internal: composePath unset for HS profile (constructor invariant violated)`
      );
    }
    return this.composePath;
  }

  /**
   * validate that composePath is absolute and exists on disk before
   * passing it to any subprocess call. Defence-in-depth — callers pass paths
   * from materializeComposeTemplate so this should never fire in normal use.
   */
  private validateComposePath(composePath: string): void {
    if (!isAbsolute(composePath)) {
      throw new OrchestratorError(
        `composePath must be an absolute path, got: ${composePath}`
      );
    }
    if (!existsSync(composePath)) {
      throw new OrchestratorError(
        `composePath does not exist on disk: ${composePath}`
      );
    }
  }

  /**
   * Shared compose `up -d` for the compose-driven profiles ('hs', 'direct').
   * Validates the composePath, builds the profile-gated args, and runs
   * `docker compose up -d`, surfacing failures the same way for both profiles.
   * Does NOT apply any readiness gate — the caller layers that on (HS hostname
   * for 'hs'; connector /health for 'direct').
   */
  private async composeUp(profiles: NodeType[]): Promise<void> {
    const composePath = this.requireComposePath();
    this.validateComposePath(composePath);
    // Profile flags MUST come BEFORE the subcommand per Docker Compose CLI grammar.
    // Deterministic order: town → mill → dvm (matches AC #4).
    const PROFILE_ORDER: NodeType[] = ['town', 'mill', 'dvm'];
    // Reject unknown profile types up-front rather than silently dropping them
    // (they would otherwise fail the `PROFILE_ORDER.includes()` check below
    // and start no containers).
    for (const p of profiles) {
      if (!PROFILE_ORDER.includes(p)) {
        throw new OrchestratorError(
          `Unknown profile '${String(p)}'. Expected one of: ${PROFILE_ORDER.join(', ')}.`
        );
      }
    }
    const args = ['compose', '-f', composePath];
    for (const type of PROFILE_ORDER) {
      if (profiles.includes(type)) {
        args.push('--profile', type);
      }
    }
    args.push('up', '-d');

    try {
      await this.execFileAsync('docker', args, {
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        inheritStdio: true,
      });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & {
        stderr?: string;
        stdout?: string;
        code?: number | string;
        signal?: string | null;
      };
      const stderr = String(e.stderr ?? '');
      const numericExit = typeof e.code === 'number' ? e.code : undefined;
      const codeLabel = String(e.code ?? e.signal ?? 'unknown');
      let message: string;
      if (e.code === 'ENOENT') {
        message = `docker CLI not found on PATH (ENOENT): ${stderr.trim().slice(0, 2000)}`;
      } else if (e.code === 'ETIMEDOUT') {
        message = `docker compose up timed out after 180000ms: ${stderr.trim().slice(0, 2000)}`;
      } else {
        message = `docker compose up failed (exit ${codeLabel}): ${stderr.trim().slice(0, 2000)}`;
      }
      this.surfaceComposeFailure(stderr);
      throw new OrchestratorError(message, {
        ...(numericExit !== undefined ? { exitCode: numericExit } : {}),
        stderr,
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /** HS-mode startup: shell out to `docker compose up -d`, wait for HS hostname. */
  private async upHs(profiles: NodeType[]): Promise<void> {
    await this.composeUp(profiles);

    // roll back containers when waitForHsHostname times out or throws,
    // so the operator can retry without a manual `townhouse hs down`.
    try {
      await this.waitForHsHostname();
    } catch (err: unknown) {
      await this.downHs().catch(() => {
        // Best-effort rollback — ignore teardown errors so the original error
        // propagates to the caller unchanged.
      });
      throw err;
    }
  }

  /**
   * Direct-mode startup: shell out to `docker compose up -d`, then gate on the
   * connector's admin `/health` being reachable (no HS hostname to wait for).
   *
   * Readiness probe choice: a plain `:3000` BTP WebSocket-upgrade probe is
   * awkward to do portably (it needs a ws client + the BTP auth handshake), so
   * — as the plan permits — readiness here is the connector admin `/health`
   * returning 200 (via `ConnectorAdminClient.pingAdminLive`, the same admin
   * client the HS path uses). The compose healthcheck already gates the BTP
   * port: docker only reports the connector `healthy` once its admin `/health`
   * (port 9401) responds, and the connector binds its BTP server (:3000) and
   * admin server together at boot, so a healthy admin endpoint implies the BTP
   * listener is up. We poll the admin endpoint from the host (the host-mapped
   * 127.0.0.1:9401) rather than inspecting container health so the gate works
   * even when invoked against a remote daemon.
   */
  private async upDirect(profiles: NodeType[]): Promise<void> {
    await this.composeUp(profiles);

    // roll back containers when the readiness gate times out or throws, so the
    // operator can retry without a manual teardown (mirrors upHs).
    try {
      await this.waitForConnectorHealth();
    } catch (err: unknown) {
      await this.downHs().catch(() => {
        // Best-effort rollback — ignore teardown errors.
      });
      throw err;
    }
  }

  /**
   * Poll the connector admin `/health` (host-mapped 127.0.0.1:<adminPort>) until
   * it returns 200 or the deadline elapses. Used as the direct-mode readiness
   * gate. Uses a monotonic clock so suspend/resume cannot stretch the timeout.
   */
  private async waitForConnectorHealth(): Promise<void> {
    const adminUrl = `http://127.0.0.1:${this.config.connector.adminPort}`;
    const client = this.adminClientFactory(adminUrl, 5_000);
    const deadlineNs = process.hrtime.bigint() + 120_000_000_000n;
    const pollInterval = 2_000;
    let lastError: Error | undefined;
    while (process.hrtime.bigint() < deadlineNs) {
      try {
        await client.pingAdminLive();
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // ECONNREFUSED / timeout / non-2xx while the connector warms up —
        // retry within budget.
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    const tail = lastError ? ` (last error: ${lastError.message})` : '';
    throw new OrchestratorError(
      `connector health did not become ready within 120000ms` + tail,
      lastError ? { cause: lastError } : {}
    );
  }

  /**
   * Parse Docker Compose stderr for failed-service names and emit a
   * containerState event per failed service so callers see the failure via
   * the same channel dev-mode uses (AC #6 — "for each failed service
   * identified, it emits..."). When no pattern matches, emit a single
   * fallback event with name `'compose-up'`.
   */
  private surfaceComposeFailure(stderr: string): void {
    // Patterns 1 + 2 capture the SERVICE name from quoted Compose v2 stderr
    // (e.g., `failed to start "townhouse-api"`).
    // Pattern 3 was hardcoded to `townhouse-hs-` which would miss
    // Epic 46 containers (town-*, mill-*, dvm-*). The generic Compose container
    // name format is `<project>-<service>-<N>`. Capture the service name by
    // matching `Container <word>-<service>-<N> Error` without a fixed prefix.
    const patterns = [
      /failed to start (?:service\s+)?["']([^"']+)["']/gi,
      /service\s+["']([^"']+)["']\s+failed/gi,
      /Container\s+[\w-]+-([a-z][\w-]*?)(?:-\d+)?\s+Error/gi,
    ];
    const detail = stderr.trim().slice(0, 2000);
    const seen = new Set<string>();
    for (const pattern of patterns) {
      for (const match of stderr.matchAll(pattern)) {
        const name = match[1];
        if (name && !seen.has(name)) {
          seen.add(name);
          this.emit('containerState', { name, state: 'error', detail });
        }
      }
    }
    if (seen.size === 0) {
      this.emit('containerState', {
        name: 'compose-up',
        state: 'error',
        detail,
      });
    }
  }

  private async waitForHsHostname(): Promise<void> {
    const adminUrl = `http://127.0.0.1:${this.config.connector.adminPort}`;
    const client = this.adminClientFactory(adminUrl, 5_000);
    // use process.hrtime.bigint() (monotonic) instead of Date.now() so
    // laptop suspend/resume cannot jump the clock backward and extend the timeout
    // indefinitely. 120_000ms → 120_000_000_000n nanoseconds.
    const deadlineNs = process.hrtime.bigint() + 120_000_000_000n;
    const pollInterval = 2_000;
    let lastResponse:
      | { hostname: string | null; publishedAt: string | null }
      | undefined;
    let lastError: Error | undefined;
    while (process.hrtime.bigint() < deadlineNs) {
      try {
        lastResponse = await client.getHsHostname();
        lastError = undefined;
        if (
          lastResponse.hostname !== null &&
          lastResponse.publishedAt !== null
        ) {
          return;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = err instanceof Error ? err : new Error(String(err));
        // 503 anon-disabled is fatal — do NOT keep polling.
        if (msg.includes('anon-disabled')) {
          throw new OrchestratorError(
            `connector is anon-disabled — set anon.enabled: true in the connector config`,
            { cause: err instanceof Error ? err : undefined }
          );
        }
        // Connector returned 200 with malformed body (or non-JSON) — fatal.
        // Retrying for 120 s would mask a real connector regression behind a
        // generic timeout. Surface the shape error immediately.
        if (
          msg.includes('invalid hs-hostname response shape') ||
          msg.includes('invalid JSON in hs-hostname response')
        ) {
          throw new OrchestratorError(
            `connector returned a malformed /admin/hs-hostname response: ${msg}`,
            { cause: err instanceof Error ? err : undefined }
          );
        }
        // fast-fail on unexpected status codes (e.g. 404 from a pre-v3.5.0
        // connector image). The admin-client throws with 'unexpected status' in the
        // message; retrying these would burn the full 120 s budget silently.
        if (msg.includes('unexpected status')) {
          throw new OrchestratorError(msg, {
            cause: err instanceof Error ? err : undefined,
          });
        }
        // Network errors (ECONNREFUSED, request timeout, etc.) — retry within
        // budget. lastError preserves the most recent diagnostic for the
        // timeout message below.
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    // Build a timeout message that prefers the most recent observation. If the
    // last poll *failed* (e.g., connector died mid-bootstrap), report that —
    // not a stale earlier success — so the operator sees connection death
    // instead of "anon bootstrap is still in progress" misdiagnosis.
    const tail = lastError
      ? ` (last error: ${lastError.message})`
      : lastResponse
        ? ` (last response: ${JSON.stringify(lastResponse)})`
        : ' (no successful response received)';
    throw new OrchestratorError(
      `HS hostname publication timeout after 120000ms` + tail,
      lastError ? { cause: lastError } : {}
    );
  }

  /**
   * Regenerate connector config and restart the connector container
   * with updated environment variables (peer list).
   *
   * Sequence: emit connectorRestarting -> stop -> remove -> create -> start -> health -> emit connectorRestarted
   */
  async regenerateConnectorConfig(activeNodes: NodeType[]): Promise<void> {
    this.activeNodes = [...activeNodes];

    this.emit('connectorRestarting', { reason: 'peer list updated' });

    // Stop and remove existing connector.
    // Use separate try-catch blocks so a failed stop() (e.g. container in
    // Created/exited state) still allows remove() to run and clear the name.
    const connectorName = `${CONTAINER_PREFIX}connector`;
    const existingContainer = this.docker.getContainer(connectorName);
    try {
      await existingContainer.stop({ t: 5 });
    } catch {
      /* not running */
    }
    try {
      await existingContainer.remove();
    } catch {
      /* may not exist */
    }

    // Ensure the network exists — regenerate can be called independently of
    // up() (e.g. fee change), so we cannot assume ensureNetwork() already ran.
    await this.ensureNetwork();

    // Start new connector with updated config. Always emit connectorRestarted in
    // a finally block so WS clients clear the restarting state even when the
    // connector fails to start (prevents isRestarting stuck indefinitely in UI).
    try {
      await this.startConnector();
      await this.waitForHealth(connectorName);
    } finally {
      this.emit('connectorRestarted', { peers: activeNodes });
    }
  }

  /**
   * Hot-add a node after initial startup.
   * Starts the node container, then restarts the connector with updated peer list.
   */
  async addNode(type: NodeType): Promise<void> {
    if (!this.activeNodes.includes(type)) {
      this.activeNodes.push(type);
    }

    await this.startNode(type);
    await this.regenerateConnectorConfig(this.activeNodes);
  }

  /**
   * Hot-remove a node.
   * Stops the node container, then restarts the connector with updated peer list.
   */
  async removeNode(type: NodeType): Promise<void> {
    this.activeNodes = this.activeNodes.filter((n) => n !== type);

    const containerName = `${CONTAINER_PREFIX}${type}`;
    await this.stopAndRemove(containerName);
    await this.regenerateConnectorConfig(this.activeNodes);
  }

  /**
   * Graceful shutdown. Branches on profile:
   * - 'dev' (default): dockerode-based teardown
   * - 'hs': docker compose subprocess
   */
  async down(): Promise<void> {
    if (this.profile === 'hs' || this.profile === 'direct') {
      // Compose-driven teardown is profile-agnostic — it operates on the
      // composePath, so the same `docker compose down` works for both 'hs'
      // and 'direct' stacks.
      await this.downHs();
    } else {
      await this.downDev();
    }
  }

  private async downDev(): Promise<void> {
    const containers = await this.docker.listContainers({ all: true });

    // Find all townhouse containers
    const nodeContainerNames: string[] = [];
    let connectorName: string | undefined;

    for (const info of containers) {
      for (const name of info.Names) {
        const cleanName = name.startsWith('/') ? name.slice(1) : name;
        if (!cleanName.startsWith(CONTAINER_PREFIX)) continue;

        if (cleanName === `${CONTAINER_PREFIX}connector`) {
          connectorName = cleanName;
        } else {
          nodeContainerNames.push(cleanName);
        }
      }
    }

    // Stop nodes first (parallel)
    await Promise.all(
      nodeContainerNames.map((name) => this.stopAndRemove(name))
    );

    // Then stop connector
    if (connectorName) {
      await this.stopAndRemove(connectorName);
    }

    // Remove network
    await this.removeNetwork();
  }

  private async downHs(): Promise<void> {
    // Remove the relay sidecar first — it's created outside the compose project
    // (createContainer) and holds the townhouse-hs-net network, so `compose
    // down` would fail to remove the network while it's attached. Best-effort.
    await this.removeRelaySidecar().catch(() => undefined);
    const composePath = this.requireComposePath();
    const args = ['compose', '-f', composePath, 'down'];
    // NO -v flag — preserves the townhouse-hs-anon volume so the .anyone
    // address survives `down` (Story 45.4 AC).
    try {
      // 120s timeout (up from 60s) to accommodate Epic 46 multi-container
      // stacks where town+mill+dvm each need a SIGTERM grace period.
      await this.execFileAsync('docker', args, {
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & {
        stderr?: string;
        code?: number | string;
        signal?: string | null;
      };
      const stderr = String(e.stderr ?? '');
      const numericExit = typeof e.code === 'number' ? e.code : undefined;
      const codeLabel = String(e.code ?? e.signal ?? 'unknown');
      let message: string;
      if (e.code === 'ENOENT') {
        message = `docker CLI not found on PATH (ENOENT): ${stderr.trim().slice(0, 2000)}`;
      } else if (e.code === 'ETIMEDOUT') {
        message = `docker compose down timed out after 120000ms: ${stderr.trim().slice(0, 2000)}`;
      } else {
        // Compose down returns non-zero when nothing is running on some
        // Compose versions. Treat an empty-stack teardown (no containers / no
        // such service) as success so `townhouse hs down` is idempotent.
        if (
          stderr.includes('no such service') ||
          stderr.includes('no containers to remove') ||
          stderr.includes('No such container') ||
          (stderr.includes('network') && stderr.includes('not found'))
        ) {
          return;
        }
        message = `docker compose down failed (exit ${codeLabel}): ${stderr.trim().slice(0, 2000)}`;
      }
      throw new OrchestratorError(message, {
        ...(numericExit !== undefined ? { exitCode: numericExit } : {}),
        stderr,
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /**
   * Resolve the Nostr relay WebSocket URL for a Town node instance.
   *
   * Inspects the container's port bindings to get the host-bound port for
   * the relay WebSocket (7100/tcp). Falls back to the Docker-internal URL
   * when the server is running inside the Docker network or bindings are absent.
   *
   * @param nodeId - The `NodeInfo.id` value (e.g. 'town', 'dev-town-01')
   */
  async getNodeRelayEndpoint(nodeId: string): Promise<string> {
    const containerName = `${CONTAINER_PREFIX}${nodeId}`;
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      const portBindings = info.HostConfig?.PortBindings as
        | Record<string, { HostIp?: string; HostPort?: string }[] | null>
        | undefined;
      const binding = portBindings?.[`${TOWN_RELAY_PORT}/tcp`]?.[0];
      if (binding?.HostPort) {
        const host =
          binding.HostIp && binding.HostIp !== '0.0.0.0'
            ? binding.HostIp
            : '127.0.0.1';
        // nosemgrep: javascript.lang.security.detect-insecure-websocket -- operator-controlled host, not user input
        return `ws://${host}:${binding.HostPort}`;
      }
    } catch {
      // Container not found or inspect failed — fall through to Docker-internal fallback
    }
    // Docker-internal fallback (server running inside Docker network)
    // nosemgrep: javascript.lang.security.detect-insecure-websocket -- Docker-internal, TLS unnecessary
    return `ws://${containerName}:${TOWN_RELAY_PORT}`;
  }

  /**
   * Resolve the BLS health HTTP URL for a node instance.
   *
   * Inspects the container's port bindings to find the host-bound port for the
   * node's health endpoint. Falls back to Docker-internal URL when running
   * inside the Docker network or when bindings are absent.
   *
   * @param nodeId - The `NodeInfo.id` value (e.g. 'mill', 'dev-mill-01')
   * @param type - Node type (determines which internal port to use)
   */
  async getNodeHealthEndpoint(
    nodeId: string,
    type: 'town' | 'mill' | 'dvm'
  ): Promise<string> {
    const port =
      type === 'town'
        ? TOWN_HEALTH_PORT
        : type === 'mill'
          ? MILL_HEALTH_PORT
          : DVM_HEALTH_PORT;
    const containerName = `${CONTAINER_PREFIX}${nodeId}`;
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      const portBindings = info.HostConfig?.PortBindings as
        | Record<string, { HostIp?: string; HostPort?: string }[] | null>
        | undefined;
      const binding = portBindings?.[`${port}/tcp`]?.[0];
      if (binding?.HostPort) {
        const host =
          binding.HostIp && binding.HostIp !== '0.0.0.0'
            ? binding.HostIp
            : '127.0.0.1';
        return `http://${host}:${binding.HostPort}`;
      }
    } catch {
      // Container not found or inspect failed — fall through to Docker-internal fallback
    }
    return `http://${containerName}:${port}`;
  }

  /**
   * Fetch network I/O stats for a container.
   * Results are cached for 5 seconds to avoid per-request Docker API overhead.
   *
   * @param containerName - Full container name (e.g. 'townhouse-town')
   * @returns Bandwidth stats or null when container is not running
   */
  async getContainerStats(
    containerName: string
  ): Promise<BandwidthStats | null> {
    const cached = this.statsCache.get(containerName);
    if (cached && Date.now() - cached.cachedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const container = this.docker.getContainer(containerName);
      const stats = (await container.stats({
        stream: false,
      })) as unknown as Record<string, unknown>;

      const networks = stats['networks'] as
        | Record<string, { rx_bytes?: number; tx_bytes?: number }>
        | undefined;

      if (!networks) {
        const result: BandwidthStats = {
          bytesIn: 0,
          bytesOut: 0,
          sampleAt: Date.now(),
        };
        this.statsCache.set(containerName, {
          data: result,
          cachedAt: Date.now(),
        });
        return result;
      }

      let bytesIn = 0;
      let bytesOut = 0;
      for (const iface of Object.values(networks)) {
        bytesIn += iface.rx_bytes ?? 0;
        bytesOut += iface.tx_bytes ?? 0;
      }

      const result: BandwidthStats = {
        bytesIn,
        bytesOut,
        sampleAt: Date.now(),
      };
      this.statsCache.set(containerName, {
        data: result,
        cachedAt: Date.now(),
      });
      return result;
    } catch {
      // Container not running or stats unavailable
      this.statsCache.set(containerName, { data: null, cachedAt: Date.now() });
      return null;
    }
  }

  /**
   * Return status for all townhouse containers.
   *
   * Discovers both single-instance (townhouse-<type>) and multi-instance
   * (townhouse-<prefix>-<type>-<n>) containers. Multi-instance containers
   * are returned with a `name` matching their instance suffix so callers
   * can build per-instance NodeInfo entries (e.g. "dev-town-01").
   */
  async status(): Promise<
    {
      name: string;
      type: 'connector' | 'town' | 'mill' | 'dvm';
      state: string;
      health?: string;
      startedAt?: string;
    }[]
  > {
    const containers = await this.docker.listContainers({ all: true });
    const nodeTypes = ['town', 'mill', 'dvm'] as const;
    const allTypes = ['connector', ...nodeTypes] as const;

    // Collect all containers that belong to this townhouse instance
    const matching: {
      containerName: string;
      type: (typeof allTypes)[number];
      info: (typeof containers)[number];
    }[] = [];

    for (const c of containers) {
      for (const rawName of c.Names) {
        const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
        if (!name.startsWith(CONTAINER_PREFIX)) continue;
        const suffix = name.slice(CONTAINER_PREFIX.length); // e.g. "town", "dev-town-01"
        for (const type of allTypes) {
          if (
            suffix === type ||
            suffix.endsWith(`-${type}`) ||
            suffix.includes(`-${type}-`)
          ) {
            matching.push({ containerName: name, type, info: c });
            break;
          }
        }
      }
    }

    const results: {
      name: string;
      type: (typeof allTypes)[number];
      state: string;
      health?: string;
      startedAt?: string;
    }[] = [];

    for (const { containerName, type, info } of matching) {
      const suffix = containerName.slice(CONTAINER_PREFIX.length); // e.g. "town", "dev-town-01"
      let health: string | undefined;
      let startedAt: string | undefined;
      try {
        const container = this.docker.getContainer(containerName);
        const detail = await container.inspect();
        health = detail.State?.Health?.Status ?? undefined;
        startedAt = detail.State?.StartedAt ?? undefined;
      } catch {
        // Inspect may fail if container is being removed — skip health and startedAt
      }
      results.push({
        name: suffix, // "town" for single-instance, "dev-town-01" for multi
        type,
        state: info.State ?? 'stopped',
        ...(health !== undefined ? { health } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
      });
    }

    // Ensure every type has at least one entry (stopped placeholder)
    for (const type of allTypes) {
      if (!results.some((r) => r.type === type)) {
        results.push({ name: type, type, state: 'stopped' });
      }
    }

    return results;
  }

  /**
   * Pull required images before starting containers.
   * Skips images that already exist locally.
   * Emits pullProgress events during download.
   */
  async pullImages(profiles: NodeType[]): Promise<void> {
    const imagesToPull = new Set<string>();

    // Always need the connector image
    imagesToPull.add(normalizeImageTag(this.config.connector.image));

    // Add node images
    for (const type of profiles) {
      const nodeConfig = this.config.nodes[type];
      const image = nodeConfig.image ?? DEFAULT_NODE_IMAGES[type];
      imagesToPull.add(normalizeImageTag(image));
    }

    // Pull the relay ator sidecar when the operator opted in. Built locally
    // by docker/townhouse-ator-sidecar — pull may 404, which is fine; the
    // operator must have built it before `townhouse up` (see README).
    if (profiles.includes('town') && this.config.transport.relayHiddenService) {
      imagesToPull.add(normalizeImageTag(RELAY_ATOR_SIDECAR_IMAGE));
    }

    // Delegate per-image pull to the public pullImage method (reuses skip-if-exists logic).
    for (const image of imagesToPull) {
      await this.pullImage(image);
    }
  }

  /**
   * Pull a single image by its reference (tag or digest form).
   *
   * Skips the pull when the image already exists locally (matches against
   * both RepoTags and RepoDigests so digest-form refs like
   * `ghcr.io/toon-protocol/town@sha256:abc...` are found correctly).
   * Throws `OrchestratorError` on pull failure.
   */
  async pullImage(image: string): Promise<void> {
    const existingImages = await this.docker.listImages();
    const existingRefs = new Set<string>();
    for (const img of existingImages) {
      for (const tag of img.RepoTags ?? []) existingRefs.add(tag);
      for (const digest of img.RepoDigests ?? []) existingRefs.add(digest);
    }
    if (existingRefs.has(image)) {
      return;
    }
    try {
      const stream = await this.docker.pull(image);
      await this.followPullProgress(image, stream);
    } catch (err: unknown) {
      throw new OrchestratorError(
        `Failed to pull image ${image}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err : undefined }
      );
    }
  }

  /**
   * Start a child peer node via `docker compose --profile <type> up -d <type>`.
   *
   * HS-profile only — throws `OrchestratorError` when called on the dev profile.
   *
   * The `env` parameter supplies the per-node wallet secrets (e.g.
   * `TOWN_SECRET_KEY`, `MILL_MNEMONIC`). It is layered on top of `process.env`
   * so that PATH, HOME, and other process-level env vars are preserved for the
   * docker CLI subprocess.
   *
   * Logging guard: the caller (nodes-lifecycle route) must NOT log the `env`
   * argument — it contains secret keys and the wallet mnemonic.
   */
  async startNodeViaCompose(
    type: NodeType,
    env: Record<string, string>
  ): Promise<void> {
    if (this.profile === 'dev') {
      throw new OrchestratorError(
        `startNodeViaCompose is only available in HS profile; current profile is 'dev'`
      );
    }
    const composePath = this.requireComposePath();
    this.validateComposePath(composePath);

    const args = [
      'compose',
      '-f',
      composePath,
      '--profile',
      type,
      'up',
      '-d',
      type,
    ] as const;

    try {
      await this.execFileAsync('docker', args, {
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        inheritStdio: true,
        // Layer node secrets on top of process.env — preserves PATH, HOME, etc.
        env: { ...process.env, ...env },
      });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & {
        stderr?: string;
        code?: number | string;
        signal?: string | null;
      };
      // P5: redact env-value secrets before stderr ever reaches an error
      // message or response body.
      const stderr = redactSecretsInComposeStderr(String(e.stderr ?? ''));
      const numericExit = typeof e.code === 'number' ? e.code : undefined;
      const codeLabel = String(e.code ?? e.signal ?? 'unknown');
      let message: string;
      if (e.code === 'ENOENT') {
        message = `docker CLI not found on PATH (ENOENT): ${stderr.trim().slice(0, 2000)}`;
      } else if (e.code === 'ETIMEDOUT') {
        message = `docker compose up timed out after 180000ms: ${stderr.trim().slice(0, 2000)}`;
      } else {
        message = `docker compose up failed (exit ${codeLabel}): ${stderr.trim().slice(0, 2000)}`;
      }
      this.surfaceComposeFailure(stderr);
      throw new OrchestratorError(message, {
        ...(numericExit !== undefined ? { exitCode: numericExit } : {}),
        stderr,
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /**
   * Stop and remove a child peer node via `docker compose stop` + `rm -f`.
   *
   * HS-profile only — throws `OrchestratorError` when called on the dev profile.
   * Idempotent: stderr patterns indicating the service/container is already gone
   * (`'no such service'`, `'no containers to remove'`, `'No such container'`)
   * are treated as success so callers can run this as a rollback without
   * worrying about the container's prior state.
   */
  async stopNodeViaCompose(type: NodeType): Promise<void> {
    if (this.profile === 'dev') {
      throw new OrchestratorError(
        `stopNodeViaCompose is only available in HS profile; current profile is 'dev'`
      );
    }
    const composePath = this.requireComposePath();

    const idempotentStderr = (stderr: string): boolean =>
      stderr.includes('no such service') ||
      stderr.includes('no containers to remove') ||
      stderr.includes('No such container');

    // Step 1: stop the service
    try {
      await this.execFileAsync(
        'docker',
        ['compose', '-f', composePath, '--profile', type, 'stop', type],
        { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }
      );
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & {
        stderr?: string;
        code?: number | string;
      };
      const stderr = redactSecretsInComposeStderr(String(e.stderr ?? ''));
      if (!idempotentStderr(stderr)) {
        // P11: wrap raw error in OrchestratorError for parity with startNodeViaCompose.
        const numericExit = typeof e.code === 'number' ? e.code : undefined;
        const codeLabel = String(e.code ?? 'unknown');
        throw new OrchestratorError(
          `docker compose stop failed (exit ${codeLabel}): ${stderr.trim().slice(0, 2000)}`,
          {
            ...(numericExit !== undefined ? { exitCode: numericExit } : {}),
            stderr,
            cause: err instanceof Error ? err : undefined,
          }
        );
      }
    }

    // Step 2: remove the stopped container so a future `up` re-creates it cleanly
    try {
      await this.execFileAsync(
        'docker',
        ['compose', '-f', composePath, '--profile', type, 'rm', '-f', type],
        { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }
      );
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & {
        stderr?: string;
        code?: number | string;
      };
      const stderr = redactSecretsInComposeStderr(String(e.stderr ?? ''));
      if (!idempotentStderr(stderr)) {
        const numericExit = typeof e.code === 'number' ? e.code : undefined;
        const codeLabel = String(e.code ?? 'unknown');
        throw new OrchestratorError(
          `docker compose rm failed (exit ${codeLabel}): ${stderr.trim().slice(0, 2000)}`,
          {
            ...(numericExit !== undefined ? { exitCode: numericExit } : {}),
            stderr,
            cause: err instanceof Error ? err : undefined,
          }
        );
      }
    }
  }

  /**
   * Poll container health status via inspect().
   * Retries at configurable interval, throws on timeout.
   */
  async healthCheck(
    containerName: string,
    options?: HealthCheckOptions
  ): Promise<string> {
    const interval = options?.interval ?? 2000;
    const timeout = options?.timeout ?? 60000;
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < timeout) {
      attempt++;
      try {
        const container = this.docker.getContainer(containerName);
        const info = await container.inspect();

        const healthStatus = info.State?.Health?.Status ?? 'none';

        this.emit('healthCheck', {
          name: containerName,
          status: healthStatus,
          attempt,
        });

        if (healthStatus === 'healthy') {
          return 'healthy';
        }
      } catch {
        // Transient inspect failure (Docker daemon hiccup) — retry within timeout
        this.emit('healthCheck', {
          name: containerName,
          status: 'error',
          attempt,
        });
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(
      `Health check timeout: ${containerName} did not become healthy within ${timeout}ms`
    );
  }

  // ── Private helpers ──

  /**
   * Create the townhouse-net bridge network if it doesn't exist.
   */
  private async ensureNetwork(): Promise<void> {
    try {
      // Docker's name filter does substring matching, so we post-filter
      // with an exact Name comparison to avoid false positives.
      const networks = await this.docker.listNetworks({
        filters: { name: [NETWORK_NAME] },
      });

      const exists = networks.some(
        (n: { Name: string }) => n.Name === NETWORK_NAME
      );
      if (exists) return;

      await this.docker.createNetwork({
        Name: NETWORK_NAME,
        Driver: 'bridge',
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('ENOENT') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('socket')
      ) {
        throw new Error(
          `Docker is not running or not available. Please start Docker and try again. (${msg})`
        );
      }
      throw error;
    }
  }

  /**
   * Start the connector container — always runs first.
   *
   * The connector image at 3.3.x reads its config from a YAML file pointed
   * to by the `CONFIG_FILE` env var (default `./config.yaml`). We write the
   * generated YAML to `<configDir>/connector.yaml` (sibling to wallet.enc),
   * mount it as `/config/connector.yaml`, and set CONFIG_FILE accordingly.
   *
   * (Env-var-based config was set on the container historically but the
   * connector image silently ignored them — see the YAML fix landing with
   * this comment block.)
   */
  private async startConnector(): Promise<void> {
    const name = `${CONTAINER_PREFIX}connector`;
    const env = this.buildConnectorEnv();
    env.push('CONFIG_FILE=/config/connector.yaml');

    // Write the YAML config beside the wallet so it's stable across restarts.
    const configDir = dirname(this.config.wallet.encrypted_path);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const yamlPath = join(configDir, 'connector.yaml');
    const runtimeConfig = this.configGenerator.generate(this.activeNodes);
    writeFileSync(yamlPath, this.configGenerator.toYaml(runtimeConfig), {
      encoding: 'utf-8',
      mode: 0o600,
    });

    this.emit('containerState', { name, state: 'creating' });

    const container = await this.docker.createContainer({
      name,
      Image: this.config.connector.image,
      Env: env,
      ExposedPorts: {
        [`${CONNECTOR_INTERNAL_PORT}/tcp`]: {},
        [`${this.config.connector.adminPort}/tcp`]: {},
      },
      HostConfig: {
        NetworkMode: NETWORK_NAME,
        Binds: [`${yamlPath}:/config/connector.yaml:ro`],
        PortBindings: {
          [`${this.config.connector.adminPort}/tcp`]: [
            {
              HostIp: '127.0.0.1',
              HostPort: String(this.config.connector.adminPort),
            },
          ],
        },
      },
    });

    this.emit('containerState', { name, state: 'starting' });
    await container.start();
    this.emit('containerState', { name, state: 'running' });
  }

  /**
   * Start a node container (town, mill, or dvm).
   * Retries up to MAX_START_RETRIES on failure.
   */
  private async startNode(type: NodeType): Promise<void> {
    const name = `${CONTAINER_PREFIX}${type}`;
    const nodeConfig = this.config.nodes[type];
    const image = nodeConfig.image ?? DEFAULT_NODE_IMAGES[type];
    const env = await this.buildNodeEnv(type);

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_START_RETRIES; attempt++) {
      try {
        this.emit('containerState', { name, state: 'creating' });

        const container = await this.docker.createContainer({
          name,
          Image: image,
          Env: env,
          HostConfig: {
            NetworkMode: NETWORK_NAME,
          },
        });

        this.emit('containerState', { name, state: 'starting' });
        await container.start();
        this.emit('containerState', { name, state: 'running' });
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.emit('containerState', { name, state: 'error' });

        // Clean up failed container before retry
        try {
          const existing = this.docker.getContainer(name);
          await existing.remove({ force: true });
        } catch {
          // Container may not exist, ignore
        }
      }
    }

    throw new Error(
      `Failed to start container ${name} after ${MAX_START_RETRIES} restart attempts: ${lastError?.message}`
    );
  }

  /**
   * Wait for a container's health check to pass.
   */
  private async waitForHealth(containerName: string): Promise<void> {
    await this.healthCheck(containerName);
  }

  /**
   * Start the relay-side ator sidecar that publishes a v3 hidden service
   * forwarding inbound traffic to the town container's Nostr WebSocket port.
   *
   * The keypair directory is mounted read-write because the sidecar's
   * entrypoint writes the `hostname` file on first boot (see
   * docker/townhouse-ator-sidecar/Dockerfile). The town container picks up
   * the resulting .anyone URL via the operator-set externalUrl field.
   */
  /**
   * Ensure the relay hidden-service sidecar is running (HS mode). Forwards the
   * relay `.anyone` HS to the town container's Nostr port (7100) so external
   * clients can READ over the hidden service. Idempotent: a no-op if already
   * running; recreates a stale/exited one. The keypair persists in a named
   * volume → stable address across `hs down`/`up`. Requires the town container
   * to exist (the sidecar resolves its DNS at boot), so call it AFTER the town
   * is (re)started.
   */
  async ensureRelaySidecar(): Promise<void> {
    const name = RELAY_SIDECAR_NAME;
    // Idempotent: leave a running sidecar in place; remove a stale one.
    try {
      const existing = this.docker.getContainer(name);
      const info = await existing.inspect();
      if (info.State?.Running === true) return;
      await existing.remove({ force: true });
    } catch {
      // not present — create below
    }

    const env = [
      `HS_TARGET_HOST=${RELAY_HS_TARGET_HOST}`,
      `HS_TARGET_PORT=${TOWN_RELAY_PORT}`,
      `HS_PORT=${TOWN_RELAY_PORT}`,
      `SOCKS_PORT=${RELAY_ATOR_SOCKS_PORT}`,
      `NICKNAME=townhouse-relay`,
    ];

    this.emit('containerState', { name, state: 'creating' });
    const container = await this.docker.createContainer({
      name,
      Image: RELAY_ATOR_SIDECAR_IMAGE,
      Env: env,
      HostConfig: {
        NetworkMode: RELAY_HS_NETWORK,
        Binds: [`${RELAY_HS_KEYS_VOLUME}:/var/lib/anon/hs:rw`],
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    this.emit('containerState', { name, state: 'starting' });
    await container.start();
    this.emit('containerState', { name, state: 'running' });
  }

  /**
   * Read the relay sidecar's published `.anyone` hostname (it writes the file
   * once anon finishes bootstrapping). Polls until the file is non-empty or
   * `timeoutMs` elapses; returns null on timeout. The file already contains the
   * routable `.anyone` address (no scheme mapping needed).
   */
  async getRelayHsHostname(timeoutMs = 120_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await this.execFileAsync(
          'docker',
          ['exec', RELAY_SIDECAR_NAME, 'cat', '/var/lib/anon/hs/hostname'],
          { timeout: 5_000, maxBuffer: 1 << 20 }
        );
        const host = String(stdout).trim();
        if (host) return host;
      } catch {
        // sidecar not ready / file absent yet — keep polling
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return null;
  }

  /** Stop + remove the relay sidecar (called before `hs down`'s compose down). */
  async removeRelaySidecar(): Promise<void> {
    await this.stopAndRemove(RELAY_SIDECAR_NAME);
  }

  /**
   * Stop and remove a single container.
   */
  private async stopAndRemove(containerName: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerName);
      this.emit('containerState', { name: containerName, state: 'stopping' });
      await container.stop({ t: 10 });
      await container.remove();
      this.emit('containerState', { name: containerName, state: 'stopped' });
    } catch (error: unknown) {
      // Container may already be stopped/removed — only swallow expected errors
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('already stopped') ||
        msg.includes('not running') ||
        msg.includes('No such container') ||
        msg.includes('is not running') ||
        msg.includes('removal')
      ) {
        return;
      }
      // Emit error state with detail but don't throw — best-effort cleanup during shutdown
      this.emit('containerState', {
        name: containerName,
        state: 'error',
        detail: msg,
      });
    }
  }

  /**
   * Remove the townhouse-net network if it exists.
   */
  private async removeNetwork(): Promise<void> {
    try {
      const networks = await this.docker.listNetworks({
        filters: { name: [NETWORK_NAME] },
      });
      const netInfo = networks.find(
        (n: { Name: string }) => n.Name === NETWORK_NAME
      );
      if (netInfo) {
        const network = this.docker.getNetwork(netInfo.Id ?? netInfo.Name);
        await network.remove();
      }
    } catch {
      // Network may not exist, ignore
    }
  }

  /**
   * Build environment variables for the connector container.
   * Delegates to ConnectorConfigGenerator for consistent config generation.
   */
  private buildConnectorEnv(): string[] {
    const runtimeConfig = this.configGenerator.generate(this.activeNodes);
    return this.configGenerator.toEnvArray(runtimeConfig);
  }

  /**
   * Build environment variables for a node container.
   * If a WalletManager is provided, injects per-node identity keys.
   *
   * Async because the DVM path may need to derive an RSA-4096 Arweave key
   * via `walletManager.ensureArweaveKey('dvm')` — that derivation takes
   * 5–30s on first call per unlocked wallet (cached thereafter).
   */
  private async buildNodeEnv(type: NodeType): Promise<string[]> {
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- Docker-internal container-to-container URL, TLS unnecessary
    const connectorUrl = `ws://${CONTAINER_PREFIX}connector:${CONNECTOR_INTERNAL_PORT}`;
    const env: string[] = [`CONNECTOR_URL=${connectorUrl}`];

    switch (type) {
      case 'town': {
        const feePerEvent = this.config.nodes.town.feePerEvent;
        if (feePerEvent !== undefined) {
          env.push(`FEE_PER_EVENT=${feePerEvent}`);
        }
        // When the operator opts into a relay hidden service, the .anyone URL
        // is advertised via packages/town/src/cli.ts which reads
        // TOON_EXTERNAL_RELAY_URL into config.externalRelayUrl. We deliberately
        // do NOT set config.ator.enabled — that would bind the relay to
        // 127.0.0.1 inside the container, which the sidecar (reaching town via
        // Docker DNS) cannot then forward to.
        const relayHs = this.config.transport.relayHiddenService;
        if (relayHs?.externalUrl) {
          env.push(`TOON_EXTERNAL_RELAY_URL=${relayHs.externalUrl}`);
        }
        break;
      }
      case 'mill': {
        const feeBasisPoints = this.config.nodes.mill.feeBasisPoints;
        if (feeBasisPoints !== undefined) {
          env.push(`FEE_BASIS_POINTS=${feeBasisPoints}`);
        }
        break;
      }
      case 'dvm': {
        const feePerJob = this.config.nodes.dvm.feePerJob;
        if (feePerJob !== undefined) {
          env.push(`FEE_PER_JOB=${feePerJob}`);
        }
        const kindPricing = this.config.nodes.dvm.kindPricing;
        if (kindPricing) {
          for (const [kind, value] of Object.entries(kindPricing)) {
            env.push(`KIND_PRICING_${kind}=${value}`);
          }
        }
        // Arweave DVM (kind:5094) requires Arweave credit credentials for
        // authenticated uploads. Two paths are wired here:
        //   1. Preferred (Phase 4): pipe the wallet-derived AR JWK as
        //      DVM_ARWEAVE_JWK_B64 = base64(JSON(jwk)). Container picks
        //      this up first and constructs an ArweaveSigner.
        //   2. Legacy: pass through TURBO_TOKEN (raw JWK JSON env var)
        //      so existing operators are not broken.
        // Without either, the entrypoint installs a stub adapter that
        // throws on first upload with a `townhouse credits buy` CTA.
        //
        // NOTE: the JWK is secret material — DO NOT log the env-var value
        // anywhere in this path. The orchestrator's existing logging only
        // surfaces container names / lifecycle events, not env arrays.
        if (this.walletManager) {
          try {
            // Surface the 5–30s blocking call so operators know why their
            // boot is paused. Logged BEFORE the await so the message lands
            // even if derivation is slow.
            console.log(
              '[orchestrator] Deriving DVM Arweave key (first boot, this can take 5-30s)...'
            );
            await this.walletManager.ensureArweaveKey('dvm');
            const jwk = this.walletManager.getArweaveJwk('dvm');
            const jwkB64 = Buffer.from(JSON.stringify(jwk), 'utf-8').toString(
              'base64'
            );
            env.push(`DVM_ARWEAVE_JWK_B64=${jwkB64}`);
          } catch {
            // Wallet locked, unsupported platform, or derivation failed —
            // skip the preferred path silently. The legacy TURBO_TOKEN
            // path below (or the stub adapter with CTA) takes over.
          }
        }
        const turboToken = process.env['TURBO_TOKEN'];
        if (turboToken) {
          env.push(`TURBO_TOKEN=${turboToken}`);
        }
        break;
      }
    }

    // Inject wallet-derived identity keys if available
    if (this.walletManager) {
      try {
        const keys = this.walletManager.getNodeKeys(type);
        env.push(`NODE_NOSTR_PUBKEY=${keys.nostrPubkey}`);
        env.push(`NODE_EVM_ADDRESS=${keys.evmAddress}`);
        // Secret key as hex for the container to use for event signing
        const secretHex = Buffer.from(keys.nostrSecretKey).toString('hex');
        env.push(`NODE_NOSTR_SECRET_KEY=${secretHex}`);
      } catch {
        // Wallet not initialized — skip key injection (backward compatible)
      }
    }

    return env;
  }

  /**
   * Follow a Docker pull stream and emit progress events.
   */
  private async followPullProgress(
    image: string,
    stream: NodeJS.ReadableStream
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
        (event: { status?: string; id?: string; progress?: string }) => {
          this.emit('pullProgress', {
            image,
            status: event.status ?? '',
            id: event.id,
            progress: event.progress,
          });
        }
      );
    });
  }
}
