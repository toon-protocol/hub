/**
 * Connector module — public API (Story 21.3).
 */

export {
  ConnectorConfigGenerator,
  DEFAULT_ATOR_PROXY,
} from './config-generator.js';
export { ConnectorAdminClient } from './admin-client.js';
export { TransportProbe } from './transport-probe.js';
export {
  writeHsConnectorConfig,
  writeDirectConnectorConfig,
  detectExistingHsConfig,
} from './hs-config-writer.js';
export type {
  WriteHsConnectorConfigResult,
  WriteDirectConnectorConfigResult,
} from './hs-config-writer.js';
export { writeHsNodeEnvFile } from './env-writer.js';
export type { WriteHsNodeEnvResult } from './env-writer.js';
export type {
  ConnectorRuntimeConfig,
  AssetEarnings,
  ConnectorFeeEntry,
  EarningsResponse,
  EarningsTimestamp,
  HealthResponse,
  HsHostnameResponse,
  MetricsResponse,
  MetricsPeerEntry,
  PacketLogEntry,
  PacketLogFilter,
  PacketLogResponse,
  PeerEarnings,
  PeerEntry,
  PeerStatus,
  PeersResponse,
  RecentClaim,
} from './types.js';
