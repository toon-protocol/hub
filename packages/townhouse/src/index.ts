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

export { DockerOrchestrator, OrchestratorError } from './docker/index.js';
export type {
  NodeType,
  ContainerSpec,
  OrchestratorEvents,
  HealthCheckOptions,
} from './docker/index.js';

export {
  ConnectorConfigGenerator,
  ConnectorAdminClient,
  TransportProbe,
  DEFAULT_ATOR_PROXY,
} from './connector/index.js';
export type {
  ConnectorRuntimeConfig,
  PeerEntry,
  HealthResponse,
  HsHostnameResponse,
  MetricsResponse,
  MetricsPeerEntry,
  PeerStatus,
  PeersResponse,
} from './connector/index.js';

export {
  WalletManager,
  encryptWallet,
  decryptWallet,
  loadWallet,
  saveWallet,
} from './wallet/index.js';
export type {
  WalletManagerConfig,
  WalletState,
  NodeKeys,
  DerivedNodeKeys,
  NodeKeyInfo,
  EncryptedWallet,
} from './wallet/index.js';

export {
  loadComposeTemplate,
  materializeComposeTemplate,
  ComposeLoaderError,
} from './compose-loader.js';
export type { ComposeProfile, ComposeLoaderOptions } from './compose-loader.js';

export { createApiServer, createWizardApiServer } from './api/index.js';
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
  NodeHealthPayload,
  TownHealthPayload,
  DvmHealthResponse,
  MillHealthResponse,
  MillSwapsRecentPayload,
  JobsRecentPayload,
  JobsByKindEntry,
  DepositAddressesPayload,
  DepositAddressEntry,
  SwapByPairEntry,
  WalletBalanceEntry,
  WalletBalancesPayload,
  WithdrawRequest,
  WithdrawResponse,
  WithdrawSuccessResponse,
  WithdrawDryRunResponse,
  RevealRequest,
  RevealResponse,
  TransactionReceiptPayload,
  WizardStatePayload,
  WizardInitRequest,
  WizardProgressMessage,
  TransportStatusPayload,
  TransportPatchRequest,
  TransportPatchResponse,
} from './api/index.js';
export type { BandwidthStats } from './docker/index.js';
export type { PacketLogEntry, PacketLogFilter } from './connector/types.js';
