/**
 * Docker orchestration module — public API (Story 21.2).
 */

export { DockerOrchestrator } from './orchestrator.js';
export type {
  NodeType,
  ContainerSpec,
  OrchestratorEvents,
  HealthCheckOptions,
} from './types.js';
