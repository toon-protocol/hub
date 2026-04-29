/**
 * Connector module — public API (Story 21.3).
 */

export { ConnectorConfigGenerator } from './config-generator.js';
export { ConnectorAdminClient } from './admin-client.js';
export type {
  ConnectorRuntimeConfig,
  PeerEntry,
  HealthResponse,
  MetricsResponse,
  MetricsPeerEntry,
  PeerStatus,
  PeersResponse,
} from './types.js';
