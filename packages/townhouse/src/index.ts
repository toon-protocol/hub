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
  PeerStatus,
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
