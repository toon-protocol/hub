/**
 * Connector Config Generator for Townhouse (Story 21.3).
 *
 * Generates runtime configuration for the standalone ILP connector
 * based on the Townhouse config and currently active nodes.
 */

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

  // ── Private helpers ──

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
   */
  private generateTransportConfig(): ConnectorRuntimeConfig['transport'] {
    if (this.config.transport.mode === 'ator') {
      return {
        mode: 'ator',
        socksProxy: this.config.transport.socksProxy ?? DEFAULT_ATOR_PROXY,
      };
    }

    return { mode: 'direct' };
  }
}
