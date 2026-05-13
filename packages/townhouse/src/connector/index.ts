/**
 * Connector module — public API (Story 21.3).
 */

export {
  ConnectorConfigGenerator,
  DEFAULT_ATOR_PROXY,
} from './config-generator.js';
export { ConnectorAdminClient } from './admin-client.js';
export { TransportProbe } from './transport-probe.js';
export { writeHsConnectorConfig } from './hs-config-writer.js';
export type { WriteHsConnectorConfigResult } from './hs-config-writer.js';
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
