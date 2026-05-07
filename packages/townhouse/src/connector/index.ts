/**
 * Connector module — public API (Story 21.3).
 */

export {
  ConnectorConfigGenerator,
  DEFAULT_ATOR_PROXY,
} from './config-generator.js';
export { ConnectorAdminClient } from './admin-client.js';
export { TransportProbe } from './transport-probe.js';
export type {
  ConnectorRuntimeConfig,
  PeerEntry,
  HealthResponse,
  MetricsResponse,
  MetricsPeerEntry,
  PeerStatus,
  PeersResponse,
  PacketLogFilter,
  PacketLogEntry,
  PacketLogResponse,
} from './types.js';
