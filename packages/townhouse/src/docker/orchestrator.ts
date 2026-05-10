/**
 * Docker Orchestration Engine for Townhouse (Story 21.2).
 *
 * Manages the full container lifecycle: network creation, image pulling,
 * container creation/start/stop/removal, and health check polling.
 * Uses dockerode for programmatic Docker control with DI for testability.
 */

import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
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

// Reserved for parity with prior dev-path implementations that used
// promisify(execFile). HS path uses runDockerCompose (spawn-based) so the
// operator's TTY sees `docker pull` progress (Story 45.3 AC #10).
void promisify;
void execFile;

interface RunDockerOptions {
  timeout?: number;
  maxBuffer?: number;
  inheritStdio?: boolean;
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
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(file, Array.from(args), {
      stdio: inheritStdio
        ? ['ignore', 'inherit', 'pipe']
        : ['ignore', 'pipe', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    let stderrLen = 0;
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
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        const err = new Error(
          `docker subprocess timed out after ${timeout}ms`
        ) as Error & {
          stderr?: string;
          code?: number | string;
          signal?: NodeJS.Signals | null;
        };
        err.stderr = stderr;
        err.code = 'ETIMEDOUT';
        err.signal = signal;
        return reject(err);
      }
      if (code === 0) {
        return resolve({ stdout: '', stderr });
      }
      const err = new Error(
        `docker subprocess exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`
      ) as Error & {
        stderr?: string;
        code?: number | string;
        signal?: NodeJS.Signals | null;
      };
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

    if (this.profile === 'hs' && !this.composePath) {
      throw new OrchestratorError(
        `profile: 'hs' requires a non-empty composePath. Pass options.composePath ` +
          `pointing at the rendered HS template (typically the composePath ` +
          `returned by materializeComposeTemplate('hs')).`
      );
    }
  }

  /**
   * Orchestrate full startup sequence. Branches on profile:
   * - 'dev' (default): dockerode-based, preserves existing dev-stack behavior
   * - 'hs': docker compose subprocess + HS hostname readiness gate
   */
  async up(profiles: NodeType[]): Promise<void> {
    this.activeNodes = [...profiles];
    if (this.profile === 'hs') {
      await this.upHs(profiles);
    } else {
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

    // Optional: bring up the relay-side ator sidecar after town is started.
    // It forwards inbound HS traffic to the town container's relay WS port,
    // so it must be created after the town container exists in DNS.
    if (profiles.includes('town') && this.config.transport.relayHiddenService) {
      await this.startRelayAtorSidecar();
    }
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

  /** HS-mode startup: shell out to `docker compose up -d`, wait for HS hostname. */
  private async upHs(profiles: NodeType[]): Promise<void> {
    const composePath = this.requireComposePath();
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
        message = `docker CLI not found on PATH (ENOENT): ${stderr.trim().slice(0, 500)}`;
      } else if (e.code === 'ETIMEDOUT') {
        message = `docker compose up timed out after 180000ms: ${stderr.trim().slice(0, 500)}`;
      } else {
        message = `docker compose up failed (exit ${codeLabel}): ${stderr.trim().slice(0, 500)}`;
      }
      this.surfaceComposeFailure(stderr);
      throw new OrchestratorError(message, {
        ...(numericExit !== undefined ? { exitCode: numericExit } : {}),
        stderr,
        cause: err instanceof Error ? err : undefined,
      });
    }

    await this.waitForHsHostname();
  }

  /**
   * Parse Docker Compose stderr for failed-service names and emit a
   * containerState event per failed service so callers see the failure via
   * the same channel dev-mode uses (AC #6 — "for each failed service
   * identified, it emits..."). When no pattern matches, emit a single
   * fallback event with name `'compose-up'`.
   */
  private surfaceComposeFailure(stderr: string): void {
    const patterns = [
      /failed to start (?:service\s+)?["']([^"']+)["']/gi,
      /service\s+["']([^"']+)["']\s+failed/gi,
      /Container\s+townhouse-hs-(\w+)\s+Error/gi,
    ];
    const detail = stderr.trim().slice(0, 500);
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
    const deadline = Date.now() + 120_000;
    const pollInterval = 2_000;
    let lastResponse:
      | { hostname: string | null; publishedAt: string | null }
      | undefined;
    while (Date.now() < deadline) {
      try {
        lastResponse = await client.getHsHostname();
        if (
          lastResponse.hostname !== null &&
          lastResponse.publishedAt !== null
        ) {
          return;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // 503 anon-disabled is fatal — do NOT keep polling.
        if (msg.includes('anon-disabled')) {
          throw new OrchestratorError(
            `connector is anon-disabled — set anon.enabled: true in the connector config`,
            { cause: err instanceof Error ? err : undefined }
          );
        }
        // Network errors (ECONNREFUSED, etc.) — retry within budget.
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    throw new OrchestratorError(
      `HS hostname publication timeout after 120000ms` +
        (lastResponse
          ? ` (last response: ${JSON.stringify(lastResponse)})`
          : ' (no successful response received)')
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
    if (this.profile === 'hs') {
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
    const composePath = this.requireComposePath();
    const args = ['compose', '-f', composePath, 'down'];
    // NO -v flag — preserves the townhouse-hs-anon volume so the .anyone
    // address survives `down` (Story 45.4 AC).
    try {
      await this.execFileAsync('docker', args, {
        timeout: 60_000,
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
        message = `docker CLI not found on PATH (ENOENT): ${stderr.trim().slice(0, 500)}`;
      } else if (e.code === 'ETIMEDOUT') {
        message = `docker compose down timed out after 60000ms: ${stderr.trim().slice(0, 500)}`;
      } else {
        message = `docker compose down failed (exit ${codeLabel}): ${stderr.trim().slice(0, 500)}`;
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

    // Check which images exist locally. Match against both RepoTags (tag-form
    // refs) and RepoDigests (digest-form refs); since DEFAULT_CONNECTOR_IMAGE
    // flipped to digest form (Story 45.2), RepoTags alone never matches it
    // and we'd re-pull on every up().
    const existingImages = await this.docker.listImages();
    const existingRefs = new Set<string>();
    for (const img of existingImages) {
      for (const tag of img.RepoTags ?? []) existingRefs.add(tag);
      for (const digest of img.RepoDigests ?? []) existingRefs.add(digest);
    }

    // Pull missing images
    for (const image of imagesToPull) {
      if (existingRefs.has(image)) {
        continue;
      }

      const stream = await this.docker.pull(image);
      await this.followPullProgress(image, stream);
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
    const env = this.buildNodeEnv(type);

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
  private async startRelayAtorSidecar(): Promise<void> {
    const hsConfig = this.config.transport.relayHiddenService;
    if (!hsConfig) return;

    const name = `${CONTAINER_PREFIX}ator-sidecar-relay`;
    const env = [
      `HS_TARGET_HOST=${CONTAINER_PREFIX}town`,
      `HS_TARGET_PORT=${TOWN_RELAY_PORT}`,
      `HS_PORT=${hsConfig.port}`,
      `SOCKS_PORT=${RELAY_ATOR_SOCKS_PORT}`,
    ];

    this.emit('containerState', { name, state: 'creating' });

    const container = await this.docker.createContainer({
      name,
      Image: RELAY_ATOR_SIDECAR_IMAGE,
      Env: env,
      HostConfig: {
        NetworkMode: NETWORK_NAME,
        Binds: [`${hsConfig.dir}:/var/lib/anon/hs:rw`],
      },
    });

    this.emit('containerState', { name, state: 'starting' });
    await container.start();
    this.emit('containerState', { name, state: 'running' });
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
   */
  private buildNodeEnv(type: NodeType): string[] {
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
        // Arweave DVM (kind:5094) requires TURBO_TOKEN for authenticated
        // uploads. Without it, the entrypoint installs a stub adapter that
        // throws on first upload — dev-mode capped paths don't apply here.
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
