/**
 * Node configuration mutation routes: PATCH /nodes/:type/config
 */

import type { FastifyInstance, FastifySchema } from 'fastify';
import type { ApiDeps, NodeType } from '../types.js';
import { validateConfig } from '../../config/validator.js';
import { saveConfig } from '../../config/loader.js';

/** Mutex flag to serialize config mutations */
let isMutating = false;

/** Request body for PATCH /nodes/:type/config */
interface ConfigPatchBody {
  feePerEvent?: number;
  feeBasisPoints?: number;
  feePerJob?: number;
  enabled?: boolean;
}

/**
 * JSON Schema for PATCH body — rejects unknown keys (typos) and enforces
 * numeric fee ceiling at JS Number.MAX_SAFE_INTEGER (2^53-1). Per Task 3.1 +
 * Dev Note "Standard Guards".
 */
const patchBodySchema: FastifySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      feePerEvent: { type: 'number', minimum: 0, maximum: 9007199254740991 },
      feeBasisPoints: { type: 'number', minimum: 0, maximum: 9007199254740991 },
      feePerJob: { type: 'number', minimum: 0, maximum: 9007199254740991 },
      enabled: { type: 'boolean' },
    },
  },
};

/**
 * Register config mutation routes.
 */
export function registerConfigPatchRoutes(
  app: FastifyInstance,
  deps: ApiDeps
): void {
  app.patch<{ Params: { type: string }; Body: ConfigPatchBody }>(
    '/nodes/:type/config',
    { schema: patchBodySchema },
    async (request, reply) => {
      const { type } = request.params;
      const body = request.body ?? {};

      // Validate type
      if (type !== 'town' && type !== 'mill' && type !== 'dvm') {
        return reply.status(404).send({
          error: 'unknown_node_type',
          type,
        });
      }

      // Check mutex
      if (isMutating) {
        return reply.status(409).send({
          error: 'config_mutation_in_flight',
        });
      }

      isMutating = true;

      try {
        // Use the live reference — mutations applied to `deps.config` persist across requests
        const currentConfig = deps.config;
        const nodeConfig = currentConfig.nodes[type as NodeType];
        if (!nodeConfig) {
          return reply.status(404).send({
            error: 'unknown_node_type',
            type,
          });
        }

        // Deep merge the body into current config
        const mergedConfig = {
          ...currentConfig,
          nodes: {
            ...currentConfig.nodes,
            [type]: {
              ...nodeConfig,
              ...body,
            },
          },
        };

        // Validate merged config
        try {
          validateConfig(mergedConfig);
        } catch (validationError) {
          return reply.status(400).send({
            error: 'config_validation_error',
            message:
              validationError instanceof Error
                ? validationError.message
                : 'Invalid configuration',
          });
        }

        // Persist to disk
        await saveConfig(deps.configPath, mergedConfig);

        // Update in-memory config so subsequent requests see the new state.
        // Mutate in place on the same object reference the rest of the app holds.
        deps.config.nodes = mergedConfig.nodes;

        // Determine orchestrator action
        const nodeType = type as NodeType;
        const oldEnabled = nodeConfig.enabled;
        const newEnabled =
          body.enabled !== undefined ? body.enabled : oldEnabled;

        // D2 resolution (2026-04-21): run BOTH if enabled flips AND fee fields change
        if (oldEnabled !== newEnabled) {
          // Enabled was flipped
          if (newEnabled) {
            await deps.orchestrator.addNode(nodeType);
          } else {
            await deps.orchestrator.removeNode(nodeType);
          }
        }

        // Also regenerate if fee fields changed (even if enabled also changed)
        if (
          body.feePerEvent !== undefined ||
          body.feeBasisPoints !== undefined ||
          body.feePerJob !== undefined
        ) {
          // Fee fields changed - regenerate connector config
          const activeTypes = Object.entries(mergedConfig.nodes)
            .filter(([, config]) => config.enabled)
            .map(([type]) => type as NodeType);

          await deps.orchestrator.regenerateConnectorConfig(activeTypes);
        }

        // Return updated config subset (per-type, typed safely)
        const u = mergedConfig.nodes[type as NodeType] as {
          enabled: boolean;
          feePerEvent?: number;
          feeBasisPoints?: number;
          feePerJob?: number;
        };
        if (nodeType === 'town') {
          return { enabled: u.enabled, feePerEvent: u.feePerEvent };
        } else if (nodeType === 'mill') {
          return { enabled: u.enabled, feeBasisPoints: u.feeBasisPoints };
        } else {
          return { enabled: u.enabled, feePerJob: u.feePerJob };
        }
      } finally {
        isMutating = false;
      }
    }
  );
}

/**
 * Reset the mutation mutex (for testing).
 */
export function resetConfigMutex(): void {
  isMutating = false;
}
