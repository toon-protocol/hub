/**
 * Townhouse API — type definitions.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { DockerOrchestrator } from '../docker/orchestrator.js';
import type { WalletManager } from '../wallet/index.js';
import type { ConnectorAdminClient } from '../connector/index.js';
import type { TownhouseConfig } from '../config/schema.js';
import type { MillHealthResponse } from '@toon-protocol/mill';
import type { DvmHealthResponse } from '@toon-protocol/sdk';

/** Node types supported by Townhouse */
export type NodeType = 'town' | 'mill' | 'dvm';

/** Runtime state of a node container */
export type NodeState = 'running' | 'stopped' | 'error' | 'not-created';

/** Response shape for GET /nodes */
export interface NodeInfo {
  /**
   * Unique instance identifier — equals `type` for single-instance deployments.
   * Required in responses from this API; undefined in legacy test fixtures.
   */
  id: string;
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
    kindPricing?: Record<string, number>;
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

/** Nostr event shape forwarded in relayEvents messages */
export interface NostrEventPayload {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  sig: string;
  created_at: number;
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

/** Forwarded Nostr event from a Town relay subscription */
export interface WsRelayEventsMessage {
  type: 'relayEvents';
  nodeId: string;
  payload: NostrEventPayload;
  ts: number;
}

/** Connector restart notifications (emitted around fee-config PATCH) */
export interface WsConnectorRestartingMessage {
  type: 'connectorRestarting';
  ts: number;
}

export interface WsConnectorRestartedMessage {
  type: 'connectorRestarted';
  ts: number;
}

export interface NodeStatePayload {
  name: string;
  state: string;
}

/** Server notification when the upstream relay WebSocket for a nodeId disconnects */
export interface WsRelayEventsStatusMessage {
  type: 'relayEventsStatus';
  nodeId: string;
  connected: boolean;
  ts: number;
}

export type WsMessage =
  | WsMetricsMessage
  | WsNodeStateMessage
  | WsHeartbeatMessage
  | WsBatchMessage
  | WsRelayEventsMessage
  | WsConnectorRestartingMessage
  | WsConnectorRestartedMessage
  | WsRelayEventsStatusMessage;

/** Response shape for GET /nodes/:type/bandwidth */
export interface BandwidthPayload {
  bytesIn: number;
  bytesOut: number;
  sampleAt: number;
}

/** Packet log time-series bucket */
export interface TimeseriesBucket {
  ts: number;
  count: number;
}

/** Response shape for GET /nodes/:type/packets/timeseries */
export interface PacketTimeseriesPayload {
  buckets: TimeseriesBucket[];
}

/** Re-export for consumers that need the full Mill health shape */
export type { MillHealthResponse };

/** Re-export DvmHealthResponse so consumers don't need a direct SDK import */
export type { DvmHealthResponse };

/** Minimal common health shape; superset emitted by Town containers. */
export interface TownHealthPayload {
  status: 'ok' | 'starting' | 'stopping' | 'stopped' | 'error';
  version?: string;
  uptimeSec?: number;
  nodePubkey?: string;
}

/** Union of all node health response shapes. */
export type NodeHealthPayload =
  | MillHealthResponse
  | TownHealthPayload
  | DvmHealthResponse;

/** Per-kind job activity bucket for GET /nodes/:nodeId/jobs/recent */
export interface JobsByKindEntry {
  kind: number;
  count: number;
  volume: string;
}

/** Response shape for GET /nodes/:nodeId/jobs/recent */
export interface JobsRecentPayload {
  count: number;
  volume: string;
  byKind: JobsByKindEntry[];
  byStatus: {
    processing: number;
    success: number;
    error: number;
    partial: number;
  };
}

/** Per-pair swap activity bucket */
export interface SwapByPairEntry {
  pair: string;
  count: number;
  volume: string;
}

/** Response shape for GET /nodes/mill/swaps/recent */
export interface MillSwapsRecentPayload {
  count: number;
  volume: string;
  byPair: SwapByPairEntry[];
}

/** Per-chain deposit address entry */
export interface DepositAddressEntry {
  family: 'evm' | 'solana' | 'mina';
  address: string;
}

/** Response shape for GET /nodes/:type/deposit-addresses */
export interface DepositAddressesPayload {
  chains: DepositAddressEntry[];
}

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
