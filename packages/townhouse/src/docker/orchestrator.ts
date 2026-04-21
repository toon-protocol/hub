/**
 * Docker Orchestration Engine for Townhouse (Story 21.2).
 *
 * Manages the full container lifecycle: network creation, image pulling,
 * container creation/start/stop/removal, and health check polling.
 * Uses dockerode for programmatic Docker control with DI for testability.
 */

import { EventEmitter } from 'node:events';
import type Docker from 'dockerode';
import type { TownhouseConfig } from '../config/schema.js';
import { ConnectorConfigGenerator } from '../connector/config-generator.js';
import { CONTAINER_PREFIX } from '../constants.js';
import type { NodeType, HealthCheckOptions } from './types.js';

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
  private activeNodes: NodeType[] = [];

  constructor(docker: Docker, config: TownhouseConfig) {
    super();
    this.docker = docker;
    this.config = config;
    this.configGenerator = new ConnectorConfigGenerator(config);
  }

  /**
   * Orchestrate full startup sequence:
   * 1. Ensure network exists
   * 2. Pull images (with progress)
   * 3. Start connector, wait for health
   * 4. Start enabled node containers in parallel
   */
  async up(profiles: NodeType[]): Promise<void> {
    this.activeNodes = [...profiles];
    await this.ensureNetwork();
    await this.pullImages(profiles);
    await this.startConnector();
    await this.waitForHealth('townhouse-connector');

    // Start all node containers in parallel
    await Promise.all(profiles.map((type) => this.startNode(type)));
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

    // Stop and remove existing connector
    const connectorName = `${CONTAINER_PREFIX}connector`;
    try {
      const container = this.docker.getContainer(connectorName);
      await container.stop({ t: 5 });
      await container.remove();
    } catch {
      // Container may not exist — proceed with creation
    }

    // Start new connector with updated config
    await this.startConnector();
    await this.waitForHealth(connectorName);

    this.emit('connectorRestarted', { peers: activeNodes });
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
   * Graceful shutdown — stops containers in reverse order:
   * 1. Stop all node containers in parallel
   * 2. Stop connector
   * 3. Remove network
   */
  async down(): Promise<void> {
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

  /**
   * Return status for all townhouse containers.
   */
  async status(): Promise<{ name: string; state: string; health?: string }[]> {
    const containers = await this.docker.listContainers({ all: true });
    const allTypes = ['connector', 'town', 'mill', 'dvm'] as const;

    const results: { name: string; state: string; health?: string }[] = [];
    for (const type of allTypes) {
      const containerName = `${CONTAINER_PREFIX}${type}`;
      const info = containers.find((c) =>
        c.Names.some((n) => n === `/${containerName}` || n === containerName)
      );
      if (!info) {
        results.push({ name: type, state: 'stopped' });
        continue;
      }

      let health: string | undefined;
      try {
        const container = this.docker.getContainer(containerName);
        const detail = await container.inspect();
        health = detail.State?.Health?.Status ?? undefined;
      } catch {
        // Inspect may fail if container is being removed — skip health
      }

      results.push({
        name: type,
        state: info.State ?? 'stopped',
        ...(health !== undefined ? { health } : {}),
      });
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

    // Check which images exist locally
    const existingImages = await this.docker.listImages();
    const existingTags = new Set<string>();
    for (const img of existingImages) {
      if (img.RepoTags) {
        for (const tag of img.RepoTags) {
          existingTags.add(tag);
        }
      }
    }

    // Pull missing images
    for (const image of imagesToPull) {
      if (existingTags.has(image)) {
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
   */
  private async startConnector(): Promise<void> {
    const name = `${CONTAINER_PREFIX}connector`;
    const env = this.buildConnectorEnv();

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
        PortBindings: {
          [`${this.config.connector.adminPort}/tcp`]: [
            { HostIp: '127.0.0.1', HostPort: String(this.config.connector.adminPort) },
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
        break;
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
