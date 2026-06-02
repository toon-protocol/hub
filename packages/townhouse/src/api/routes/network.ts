/**
 * Network-mode configuration routes.
 *
 * GET   /api/network — the current network mode plus the resolved profile
 *                      (per-family settlement status + the public endpoints the
 *                      apex + nodes will use). No secrets are involved — the
 *                      network env carries only RPC/token addresses.
 * PATCH /api/network — set the mode, persist, and regenerate the connector
 *                      config. Mirrors /api/chains (config mutex + validate +
 *                      save + rollback). Takes effect for nodes on next start.
 */

import type { FastifyInstance, FastifySchema } from 'fastify';
import {
  resolveNetworkProfile,
  type ChainProviderConfigEntry,
  type NetworkMode,
} from '@toon-protocol/core';
import type { ApiDeps, NodeType } from '../types.js';
import { validateConfig } from '../../config/validator.js';
import { saveConfig } from '../../config/loader.js';
import { acquireConfigMutex, releaseConfigMutex } from '../config-mutex.js';

const NETWORK_MODES: NetworkMode[] = ['mainnet', 'testnet', 'devnet', 'custom'];

interface NetworkPatchRequest {
  network: NetworkMode;
}

/** Build the GET/PATCH response body for a config's effective network. */
function networkView(network: NetworkMode, config: ApiDeps['config']) {
  const profile = resolveNetworkProfile(network, {
    customProviders: config.chainProviders as
      | ChainProviderConfigEntry[]
      | undefined,
  });
  return {
    network,
    status: profile.status,
    // Public endpoints only — no secrets in the network node env.
    nodeEnv: profile.nodeEnv,
  };
}

const patchBodySchema: FastifySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['network'],
    properties: {
      network: { type: 'string', enum: NETWORK_MODES },
    },
  },
};

export function registerNetworkRoutes(
  app: FastifyInstance,
  deps: ApiDeps
): void {
  // ── GET /api/network ──────────────────────────────────────────────────────
  app.get('/api/network', async (_request, reply) => {
    const network = deps.config.network ?? 'mainnet';
    return reply
      .status(200)
      .send({ ...networkView(network, deps.config), ts: Date.now() });
  });

  // ── PATCH /api/network ────────────────────────────────────────────────────
  app.patch<{ Body: NetworkPatchRequest }>(
    '/api/network',
    { schema: patchBodySchema },
    async (request, reply) => {
      const next = request.body.network;

      if (!acquireConfigMutex()) {
        return reply.status(409).send({ error: 'config_mutation_in_flight' });
      }

      const prior = deps.config.network;
      try {
        deps.config.network = next;

        try {
          validateConfig(deps.config);
        } catch (validationError) {
          deps.config.network = prior;
          return reply.status(400).send({
            error: 'config_validation_error',
            message:
              validationError instanceof Error
                ? validationError.message
                : 'Invalid network',
          });
        }

        try {
          await saveConfig(deps.configPath, deps.config);
        } catch (saveError) {
          deps.config.network = prior;
          return reply.status(500).send({
            error: 'config_save_failed',
            message:
              saveError instanceof Error
                ? saveError.message
                : 'Failed to persist config',
          });
        }

        const activeNodes = Object.entries(deps.config.nodes)
          .filter(([, cfg]) => cfg.enabled)
          .map(([t]) => t as NodeType);

        try {
          await deps.orchestrator.regenerateConnectorConfig(activeNodes);
        } catch (restartError) {
          deps.config.network = prior;
          try {
            await saveConfig(deps.configPath, deps.config);
          } catch {
            /* best-effort rollback of disk write */
          }
          return reply.status(500).send({
            error: 'connector_restart_failed',
            message:
              restartError instanceof Error
                ? restartError.message
                : 'Connector restart failed',
          });
        }

        return reply.status(200).send({
          ...networkView(next, deps.config),
          restartTriggered: true,
          restartedAt: Date.now(),
        });
      } finally {
        releaseConfigMutex();
      }
    }
  );
}
