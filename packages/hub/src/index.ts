/**
 * @toon-protocol/hub — public API.
 */

export type {
  HubConfig,
  TownNodeConfig,
  MillNodeConfig,
  DvmNodeConfig,
  NodesConfig,
  WalletConfig,
  ConnectorConfig,
  TransportConfig,
  ApiConfig,
  LoggingConfig,
  ChainType,
  NetworkMode,
  ChainProviderEntry,
  EvmChainProvider,
  SolanaChainProvider,
  MinaChainProvider,
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

// Story 47.3 — hourly earnings snapshot writer + reader (DeltaComputer factory).
export { SnapshotWriter } from './earnings/snapshot-writer.js';
export type {
  SnapshotEntry,
  SnapshotWriterOptions,
} from './earnings/snapshot-writer.js';
export {
  createDeltaComputer,
  utcDayBoundary,
  utcMonthBoundary,
  utcYearBoundary,
} from './earnings/snapshot-reader.js';

// Story 47.2 — aggregated earnings types (AggregatedEarnings, NodeEarnings,
// PerAsset, DeltaComputer, AggregateEarningsInput, AggregatedEarningsStatus,
// AggregatorLogger).
export type {
  AggregatedEarnings,
  AggregatedEarningsStatus,
  AggregateEarningsInput,
  AggregatorLogger,
  NodeEarnings,
  PerAsset,
  DeltaComputer,
} from './earnings/aggregator.js';

// Story 46.1 — nodes.yaml schema, peer-type resolver, boot reconciler.
// Exported so Epic 47's aggregator (and downstream consumers) can import
// without reaching into relative paths.
export {
  readNodesYaml,
  writeNodesYaml,
  NodesYamlSchema,
  NodesYamlEntrySchema,
} from './state/nodes-yaml.js';
export type { NodesYaml, NodesYamlEntry } from './state/nodes-yaml.js';

// Story 46.2 — image manifest reader (POST /api/nodes step 2).
export {
  readImageManifest,
  ImageManifestSchema,
} from './state/image-manifest.js';
export type { ImageManifest } from './state/image-manifest.js';
export { PeerTypeResolver } from './registry/peer-type-resolver.js';
export { BootReconciler } from './reconciler.js';
export type {
  DivergenceAction,
  DivergenceLog,
  ReconcileSummary,
} from './reconciler.js';
