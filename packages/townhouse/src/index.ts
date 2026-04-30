/**
 * @toon-protocol/townhouse — public API.
 */

export type {
  TownhouseConfig,
  TownNodeConfig,
  MillNodeConfig,
  DvmNodeConfig,
  NodesConfig,
  WalletConfig,
  ConnectorConfig,
  TransportConfig,
  ApiConfig,
  LoggingConfig,
} from './config/index.js';

export {
  getDefaultConfig,
  loadConfig,
  saveConfig,
  validateConfig,
  ConfigValidationError,
} from './config/index.js';

export { DockerOrchestrator } from './docker/index.js';
export type {
  NodeType,
  ContainerSpec,
  OrchestratorEvents,
  HealthCheckOptions,
} from './docker/index.js';

export {
  ConnectorConfigGenerator,
  ConnectorAdminClient,
} from './connector/index.js';
export type {
  ConnectorRuntimeConfig,
  PeerEntry,
  HealthResponse,
  MetricsResponse,
  MetricsPeerEntry,
  PeerStatus,
  PeersResponse,
} from './connector/index.js';

export { WalletManager } from './wallet/index.js';
export type {
  WalletManagerConfig,
  WalletState,
  NodeKeys,
  DerivedNodeKeys,
  NodeKeyInfo,
  EncryptedWallet,
} from './wallet/index.js';

export { createApiServer } from './api/index.js';
export type {
  ApiServer,
  ApiDeps,
  NodeState,
  NodeInfo,
  NodeDetail,
  MetricsPayload,
  WsMessage,
  WsMetricsMessage,
  WsNodeStateMessage,
  WsHeartbeatMessage,
  WsBatchMessage,
  WsRelayEventsMessage,
  WsConnectorRestartingMessage,
  WsConnectorRestartedMessage,
  NostrEventPayload,
  BandwidthPayload,
  PacketTimeseriesPayload,
  TimeseriesBucket,
} from './api/index.js';
export type { BandwidthStats } from './docker/index.js';
export type { PacketLogEntry, PacketLogFilter } from './connector/types.js';
