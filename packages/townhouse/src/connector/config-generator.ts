/**
 * Connector Config Generator for Townhouse (Story 21.3).
 *
 * Generates runtime configuration for the standalone ILP connector
 * based on the Townhouse config and currently active nodes.
 */

import { stringify as yamlStringify } from 'yaml';

import type { TownhouseConfig } from '../config/schema.js';
import type { NodeType } from '../docker/types.js';
import { CONTAINER_PREFIX, NODE_BTP_PORT } from '../constants.js';
import type { ConnectorRuntimeConfig, PeerEntry } from './types.js';

/** Default ILP address for the Townhouse connector */
const DEFAULT_ILP_ADDRESS = 'g.townhouse';

/** Default ATOR SOCKS proxy address */
export const DEFAULT_ATOR_PROXY = 'socks5h://proxy.ator.io:9050';

/** Default asset configuration for ILP peers */
const DEFAULT_ASSET_CODE = 'USD';
const DEFAULT_ASSET_SCALE = 6;

/**
 * ConnectorConfigGenerator produces runtime configuration for the standalone
 * ILP connector based on Townhouse config and active node list.
 *
 * Key design: peer BTP URLs are deterministic Docker DNS names, so nodes
 * don't need to be running for config generation to work.
 */
export class ConnectorConfigGenerator {
  private readonly config: TownhouseConfig;

  constructor(config: TownhouseConfig) {
    this.config = config;
  }

  /**
   * Generate a ConnectorRuntimeConfig for the given set of active nodes.
   *
   * @param activeNodes - Node types currently running or about to start
   * @returns Typed configuration object (not serialized)
   */
  generate(activeNodes: NodeType[]): ConnectorRuntimeConfig {
    const peers = this.generatePeerList(activeNodes);
    const transport = this.generateTransportConfig();

    return {
      adminPort: this.config.connector.adminPort,
      ilpAddress: DEFAULT_ILP_ADDRESS,
      peers,
      transport,
    };
  }

  /**
   * Serialize a ConnectorRuntimeConfig into environment variable key-value pairs.
   *
   * @returns Record of env var name to string value
   */
  toEnvVars(runtimeConfig: ConnectorRuntimeConfig): Record<string, string> {
    const env: Record<string, string> = {
      CONNECTOR_ADMIN_PORT: String(runtimeConfig.adminPort),
      CONNECTOR_ILP_ADDRESS: runtimeConfig.ilpAddress,
      CONNECTOR_PEERS: JSON.stringify(runtimeConfig.peers),
      TRANSPORT_MODE: runtimeConfig.transport.mode,
    };

    if (runtimeConfig.transport.socksProxy) {
      env['SOCKS_PROXY'] = runtimeConfig.transport.socksProxy;
    }

    // Hidden-service env vars surface for tooling that wants the .anyone
    // address out-of-band (e.g., `townhouse status` reading the hostname
    // file). The connector itself reads these from the YAML config block
    // produced by toYaml(), not env.
    if (runtimeConfig.transport.hiddenService) {
      env['TRANSPORT_HIDDEN_SERVICE_DIR'] =
        runtimeConfig.transport.hiddenService.dir;
      env['TRANSPORT_HIDDEN_SERVICE_PORT'] = String(
        runtimeConfig.transport.hiddenService.port
      );
    }

    return env;
  }

  /**
   * Convert a ConnectorRuntimeConfig into the string[] format expected by
   * dockerode's container create API (Env option: ['KEY=VALUE', ...]).
   *
   * @returns Array of 'KEY=VALUE' strings
   */
  toEnvArray(runtimeConfig: ConnectorRuntimeConfig): string[] {
    const envVars = this.toEnvVars(runtimeConfig);
    return Object.entries(envVars).map(([key, value]) => `${key}=${value}`);
  }

  /**
   * Render a connector YAML config string the connector image at 3.3.x can
   * load via its `CONFIG_FILE` env var (default `./config.yaml`).
   *
   * The shape mirrors `docker/configs/townhouse-dev-connector.yaml` (the
   * working dev fixture) — peers list is empty because child nodes dial
   * INTO the connector at startup; the connector accepts BTP connections
   * (no-auth in dev) without needing pre-configured peer entries.
   *
   * Added in the orchestrator-bug-fix: env vars set on the container were
   * silently ignored by the connector image, which only reads from this
   * YAML file. Caller writes the returned string to disk and mounts it
   * at `/config/connector.yaml` in the container.
   */
  toYaml(runtimeConfig: ConnectorRuntimeConfig): string {
    // Translate operator-facing `mode: 'ator' | 'direct'` into the
    // connector's internal discriminated union (Epic 35 / Story 35.3):
    //   { type: 'direct' }
    //     → unchanged direct TCP
    //   { type: 'socks5', socksProxy, externalUrl, managed, managedOptions? }
    //     → SOCKS5 outbound + (optionally) managed inbound hidden service
    //
    // Historical bug we're fixing here: the previous shape was
    // `{ mode: 'ator', socksProxy }`, which the connector at 3.3.x
    // does NOT recognize. The connector's validateTransport() saw an
    // unknown `mode` field, defaulted `type` to 'direct', and silently
    // discarded socksProxy. Operators toggling mode='ator' got direct
    // traffic anyway. The new shape is what the connector actually reads.
    const transportBlock = this.buildConnectorTransportBlock(
      runtimeConfig.transport
    );

    const yamlObj: Record<string, unknown> = {
      nodeId: runtimeConfig.ilpAddress,
      btpServerPort: NODE_BTP_PORT,
      healthCheckPort: 8080,
      environment: 'development',
      deploymentMode: 'standalone',
      logLevel: this.config.logging?.level ?? 'info',
      adminApi: {
        enabled: true,
        port: runtimeConfig.adminPort,
        host: '0.0.0.0',
        // Permissive for the demo loopback environment. Production deployments
        // would lock this to specific operator IPs.
        allowedIPs: ['0.0.0.0/0'],
      },
      transport: transportBlock,
      peers: [],
      routes: [],
    };

    return yamlStringify(yamlObj);
  }

  // ── Private helpers ──

  /**
   * Translate the runtime config's transport block into the discriminated-
   * union shape the connector expects. See toYaml's note for why this was
   * silently broken before.
   */
  private buildConnectorTransportBlock(
    transport: ConnectorRuntimeConfig['transport']
  ): Record<string, unknown> {
    if (transport.mode === 'direct') {
      return { type: 'direct' };
    }
    const block: Record<string, unknown> = {
      type: 'socks5',
      socksProxy: transport.socksProxy ?? DEFAULT_ATOR_PROXY,
    };
    if (transport.hiddenService) {
      // Connector-managed inbound hidden service (Story 35.5). When
      // hiddenService is set, the connector spawns the anon binary itself
      // and resolves externalUrl from `${dir}/hostname` at boot.
      block['externalUrl'] = transport.externalUrl ?? 'auto';
      block['managed'] = true;
      const managedOptions: Record<string, unknown> = {
        hiddenServiceDir: transport.hiddenService.dir,
        hiddenServicePort: transport.hiddenService.port,
      };
      if (transport.hiddenService.startupTimeoutMs !== undefined) {
        managedOptions['startupTimeoutMs'] =
          transport.hiddenService.startupTimeoutMs;
      }
      if (transport.hiddenService.stopTimeoutMs !== undefined) {
        managedOptions['stopTimeoutMs'] = transport.hiddenService.stopTimeoutMs;
      }
      block['managedOptions'] = managedOptions;
    } else {
      // Operator manages anon externally — externalUrl is non-optional in
      // this branch; the validator enforces it upstream, so we trust it.
      // The connector also requires `managed: false` here.
      block['externalUrl'] = transport.externalUrl;
      block['managed'] = false;
    }
    return block;
  }

  /**
   * Generate PeerEntry list for each active node type.
   * BTP URLs use Docker DNS: btp+ws://townhouse-{type}:3000 // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
   */
  private generatePeerList(activeNodes: NodeType[]): PeerEntry[] {
    return activeNodes.map((type) => ({
      id: type,
      relation: 'child' as const,
      // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- Docker-internal BTP URL, TLS unnecessary
      btpUrl: `btp+ws://${CONTAINER_PREFIX}${type}:${NODE_BTP_PORT}`,
      assetCode: DEFAULT_ASSET_CODE,
      assetScale: DEFAULT_ASSET_SCALE,
    }));
  }

  /**
   * Generate transport config from Townhouse config.
   * When mode is 'ator', includes SOCKS proxy (uses default if not configured).
   * Carries forward externalUrl + hiddenService when set; downstream
   * buildConnectorTransportBlock handles translation to the connector's
   * wire shape.
   */
  private generateTransportConfig(): ConnectorRuntimeConfig['transport'] {
    if (this.config.transport.mode === 'ator') {
      const transport: ConnectorRuntimeConfig['transport'] = {
        mode: 'ator',
        socksProxy: this.config.transport.socksProxy ?? DEFAULT_ATOR_PROXY,
      };
      if (this.config.transport.externalUrl !== undefined) {
        transport.externalUrl = this.config.transport.externalUrl;
      }
      if (this.config.transport.hiddenService !== undefined) {
        const hs = this.config.transport.hiddenService;
        transport.hiddenService = {
          dir: hs.dir,
          port: hs.port,
          ...(hs.externalUrl !== undefined
            ? { externalUrl: hs.externalUrl }
            : {}),
          ...(hs.startupTimeoutMs !== undefined
            ? { startupTimeoutMs: hs.startupTimeoutMs }
            : {}),
          ...(hs.stopTimeoutMs !== undefined
            ? { stopTimeoutMs: hs.stopTimeoutMs }
            : {}),
        };
      }
      return transport;
    }

    return { mode: 'direct' };
  }
}
