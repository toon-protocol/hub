/**
 * Docker orchestration module — public API (Story 21.2).
 */

export { DockerOrchestrator, OrchestratorError } from './orchestrator.js';
export type {
  NodeType,
  ContainerSpec,
  OrchestratorEvents,
  HealthCheckOptions,
  BandwidthStats,
} from './types.js';
