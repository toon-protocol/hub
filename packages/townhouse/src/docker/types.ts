/**
 * Docker orchestration types for Townhouse (Story 21.2).
 *
 * STUB FILE: Created by ATDD workflow (red phase).
 * Implementation will be added during the green phase.
 */

/** Node types that can be orchestrated by Townhouse. */
export type NodeType = 'town' | 'mill' | 'dvm';

/** Specification for a container to be created by the orchestrator. */
export interface ContainerSpec {
  /** Container name (e.g., 'townhouse-town') */
  name: string;
  /** Docker image to use */
  image: string;
  /** Environment variables to pass to the container */
  env: Record<string, string>;
  /** Network to attach the container to */
  network: string;
  /** Port mappings (host:container) */
  ports?: Record<string, string>;
}

/** Events emitted by the orchestrator during operations. */
export interface OrchestratorEvents {
  /** Emitted during image pull with progress info */
  pullProgress: {
    image: string;
    status: string;
    id?: string;
    progress?: string;
  };
  /** Emitted when a container changes state */
  containerState: {
    name: string;
    state:
      | 'creating'
      | 'starting'
      | 'running'
      | 'stopping'
      | 'stopped'
      | 'error';
    /** Additional context for error states (e.g., error message) */
    detail?: string;
  };
  /** Emitted during health check polling */
  healthCheck: {
    name: string;
    status: string;
    attempt: number;
  };
  /** Emitted before connector restart during peer registration update */
  connectorRestarting: {
    reason: string;
  };
  /** Emitted after connector restart and health check passes */
  connectorRestarted: {
    peers: string[];
  };
}

/** Options for health check polling. */
export interface HealthCheckOptions {
  /** Polling interval in milliseconds (default: 2000) */
  interval?: number;
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number;
}
