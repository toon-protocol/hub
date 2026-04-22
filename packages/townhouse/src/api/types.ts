/**
 * Townhouse API — type definitions.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { DockerOrchestrator } from '../docker/orchestrator.js';
import type { WalletManager } from '../wallet/index.js';
import type { ConnectorAdminClient } from '../connector/index.js';
import type { TownhouseConfig } from '../config/schema.js';

/** Node types supported by Townhouse */
export type NodeType = 'town' | 'mill' | 'dvm';

/** Runtime state of a node container */
export type NodeState = 'running' | 'stopped' | 'error' | 'not-created';

/** Response shape for GET /nodes */
export interface NodeInfo {
  type: NodeType;
  enabled: boolean;
  state: NodeState;
  uptimeSeconds: number | null;
  image: string;
}

/** Detailed response shape for GET /nodes/:type */
export interface NodeDetail extends NodeInfo {
  config: {
    feePerEvent?: number;
    feeBasisPoints?: number;
    feePerJob?: number;
    enabled: boolean;
  };
  metrics: MetricsPayload | null;
}

/** Metrics payload from connector admin — narrowed per connector-team agreement 2026-04-21 */
export interface MetricsPayload {
  packetsForwarded: number;
  packetsRejected: number;
  bytesSent: number;
  attribution: 'aggregate' | 'per-peer';
  available: boolean;
}

/** WebSocket message shapes */
export interface WsMetricsMessage {
  type: 'metrics';
  payload: MetricsPayload;
  ts: number;
}

export interface WsNodeStateMessage {
  type: 'nodeState';
  payload: NodeStatePayload;
  ts: number;
}

export interface WsHeartbeatMessage {
  type: 'heartbeat';
  ts: number;
}

export interface WsBatchMessage {
  type: 'batch';
  messages: WsMessage[];
  ts: number;
}

export interface NodeStatePayload {
  name: string;
  state: string;
}

export type WsMessage =
  | WsMetricsMessage
  | WsNodeStateMessage
  | WsHeartbeatMessage
  | WsBatchMessage;

/** API server returned by createApiServer */
export interface ApiServer {
  app: FastifyInstance;
  close: () => Promise<void>;
}

/** Dependencies required to create the API server */
export interface ApiDeps {
  configPath: string;
  config: TownhouseConfig;
  orchestrator: DockerOrchestrator;
  wallet: WalletManager;
  connectorAdmin: ConnectorAdminClient;
  logger?: FastifyBaseLogger;
}
