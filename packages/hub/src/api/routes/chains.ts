/**
 * Settlement-chain configuration routes (connector `chainProviders`).
 *
 * GET   /api/chains — current settlement chains (keyId redacted — it is a
 *                     signing secret and must never be read back over the API).
 *                     Reports BOTH the editable `chainProviders` (what `chains
 *                     add/remove` mutate) and a `resolved` view of the chains
 *                     the connector actually runs — see the GET handler.
 * PATCH /api/chains — replace the chain list, persist, and regenerate the
 *                     connector config. Mirrors the /api/transport pattern
 *                     (config mutex + validate + save + rollback).
 */

import type { FastifyInstance, FastifySchema } from 'fastify';
import type { ApiDeps, NodeType } from '../types.js';
import type { ChainProviderEntry } from '../../config/schema.js';
import { validateConfig } from '../../config/validator.js';
import { saveConfig } from '../../config/loader.js';
import { acquireConfigMutex, releaseConfigMutex } from '../config-mutex.js';
import { resolveConfigNetworkProfile } from '../../config/network-profile.js';

/** Placeholder returned in GET (and accepted in PATCH to mean "unchanged"). */
const REDACTED = '***';

interface ChainsPatchRequest {
  chainProviders: ChainProviderEntry[];
}

/** Redact the signing key so it is never read back over the API. */
function redactKeyId(
  providers: readonly ChainProviderEntry[]
): readonly unknown[] {
  return providers.map((p) => {
    const hasKey = (p as { keyId?: string }).keyId !== undefined;
    return hasKey ? { ...p, keyId: REDACTED } : { ...p };
  });
}

const patchBodySchema: FastifySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['chainProviders'],
    properties: {
      chainProviders: {
        type: 'array',
        maxItems: 32,
        items: {
          type: 'object',
          // Deep per-chain validation runs in validateConfig() below; keep the
          // JSON schema permissive about the discriminated fields, but pin the
          // discriminator + chainId so obviously-bad payloads fail fast.
          required: ['chainType', 'chainId'],
          additionalProperties: true,
          properties: {
            chainType: { type: 'string', enum: ['evm', 'solana', 'mina'] },
            chainId: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
  },
};

export function registerChainsRoutes(
  app: FastifyInstance,
  deps: ApiDeps
): void {
  // ── GET /api/chains ─────────────────────────────────────────────────────
  app.get('/api/chains', async (_request, reply) => {
    // `chainProviders` is the EDITABLE config list (what `chains add/remove`
    // mutate and what the dashboard round-trips via GET→edit→PATCH). When the
    // operator relies on the `network` preset instead of explicit `chains add`,
    // this list is empty / EVM-only even though the connector runs the full
    // preset set (EVM + Solana + Mina) — which made `hub_chains list`
    // under-report (issue #232). `resolved` closes that gap: it reports the
    // chains the connector actually registers, derived from the SAME network
    // profile the apex connector config is generated from. For explicit
    // `chains add` configs the two lists match (custom providers pass through
    // verbatim). The preset path only builds provider entries when a keyId is
    // supplied (a settlement provider is useless without a signing key), so we
    // pass the REDACTED sentinel purely to materialise the entries — the real
    // signing key is never needed, read, or returned here.
    const profile = resolveConfigNetworkProfile(deps.config, REDACTED);
    return reply.status(200).send({
      chainProviders: redactKeyId(deps.config.chainProviders ?? []),
      resolved: {
        network: profile.network,
        chainProviders: redactKeyId(
          profile.chainProviders as unknown as ChainProviderEntry[]
        ),
        status: profile.status,
      },
      ts: Date.now(),
    });
  });

  // ── PATCH /api/chains ───────────────────────────────────────────────────
  app.patch<{ Body: ChainsPatchRequest }>(
    '/api/chains',
    { schema: patchBodySchema },
    async (request, reply) => {
      const incoming = request.body.chainProviders;

      if (!acquireConfigMutex()) {
        return reply.status(409).send({ error: 'config_mutation_in_flight' });
      }

      const prior = deps.config.chainProviders;
      const priorByChainId = new Map(
        (prior ?? []).map((p) => [p.chainId, p as { keyId?: string }])
      );

      try {
        // Preserve write-only keyId: a submitted entry with a missing or
        // redacted keyId keeps the prior key for that chainId (so the dashboard
        // can GET masked values, edit other fields, and PATCH back safely).
        const merged = incoming.map((entry) => {
          const incomingKeyId = (entry as { keyId?: string }).keyId;
          if (incomingKeyId === undefined || incomingKeyId === REDACTED) {
            const priorKeyId = priorByChainId.get(entry.chainId)?.keyId;
            if (priorKeyId !== undefined) {
              return { ...entry, keyId: priorKeyId } as ChainProviderEntry;
            }
            // No prior key: drop the placeholder so validateConfig reports a
            // clear "keyId is required" rather than persisting "***".
            if (incomingKeyId === REDACTED) {
              const { keyId: _drop, ...rest } = entry as { keyId?: string };
              return rest as ChainProviderEntry;
            }
          }
          return entry;
        });

        deps.config.chainProviders = merged.length > 0 ? merged : undefined;

        try {
          validateConfig(deps.config);
        } catch (validationError) {
          deps.config.chainProviders = prior;
          return reply.status(400).send({
            error: 'config_validation_error',
            message:
              validationError instanceof Error
                ? validationError.message
                : 'Invalid chain configuration',
          });
        }

        try {
          await saveConfig(deps.configPath, deps.config);
        } catch (saveError) {
          deps.config.chainProviders = prior;
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
          // Roll back in-memory + on-disk so the connector and config stay in sync.
          deps.config.chainProviders = prior;
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
          chainProviders: redactKeyId(deps.config.chainProviders ?? []),
          restartTriggered: true,
          restartedAt: Date.now(),
        });
      } finally {
        releaseConfigMutex();
      }
    }
  );
}
