/**
 * Transport configuration routes.
 *
 * GET  /api/transport — live transport status (mode, reachability, latency)
 * PATCH /api/transport — flip transport mode + trigger connector restart
 */

import type { FastifyInstance, FastifySchema } from 'fastify';
import type {
  ApiDeps,
  NodeType,
  TransportStatusPayload,
  TransportPatchRequest,
  TransportPatchResponse,
} from '../types.js';
import { validateConfig } from '../../config/validator.js';
import { saveConfig } from '../../config/loader.js';
import { acquireConfigMutex, releaseConfigMutex } from '../config-mutex.js';

const DEFAULT_ATOR_PROXY = 'socks5h://proxy.ator.io:9050';

export interface RegisterTransportOptions {
  /**
   * 'wizard'    — registers GET only (no PATCH at all). Caller must call
   *               registerTransportPatchRoute() after wizard transition completes.
   * 'patch-only'— registers PATCH only (used by the wizard-to-normal transition).
   * 'normal'    — registers both GET and PATCH (the standalone-server case).
   */
  mode?: 'normal' | 'wizard' | 'patch-only';
}

/** Normalize a SOCKS5 URL for byte-comparable equality (trailing slash, casing). */
function normalizeProxyUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

const patchBodySchema: FastifySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['mode'],
    properties: {
      mode: { type: 'string', enum: ['direct', 'ator'] },
      socksProxy: { type: 'string', minLength: 1, maxLength: 2048 },
    },
  },
};

/**
 * Register transport routes on the given Fastify instance.
 */
export function registerTransportRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  opts: RegisterTransportOptions = {}
): void {
  const { mode = 'normal' } = opts;

  // ── GET /api/transport ────────────────────────────────────────────────────
  // Skipped for 'patch-only' mode (caller already registered GET earlier).
  if (mode !== 'patch-only') {
    app.get('/api/transport', async (_request, reply) => {
      // Read deps.transportProbe per request — the wizard server swaps the
      // probe instance on transition, so we cannot capture it at registration time.
      const probeStatus = deps.transportProbe.getStatus();
      const configTransport = deps.config.transport;

      const payload: TransportStatusPayload = {
        mode: configTransport.mode,
        reachable:
          configTransport.mode === 'direct' ? true : probeStatus.reachable,
        latencyProxyMs:
          configTransport.mode === 'direct' ? null : probeStatus.latencyProxyMs,
        latencyDirectMs:
          configTransport.mode === 'direct'
            ? null
            : probeStatus.latencyDirectMs,
        lastProbedAt: probeStatus.lastProbedAt,
        probeError:
          configTransport.mode === 'direct' ? null : probeStatus.probeError,
        ts: Date.now(),
      };

      if (configTransport.mode === 'ator') {
        payload.socksProxy = configTransport.socksProxy ?? DEFAULT_ATOR_PROXY;
      }

      return reply.status(200).send(payload);
    });
  }

  // ── PATCH /api/transport ──────────────────────────────────────────────────
  // Wizard mode: GET only — PATCH is added later via registerTransportRoutes
  // with mode 'patch-only' once the wizard transitions to normal.
  if (mode === 'wizard') {
    return;
  }

  // Probe handle for PATCH operations. Stable: PATCH is only registered for
  // the deps object the caller intends to mutate transport against.
  const probe = deps.transportProbe;

  app.patch<{ Body: TransportPatchRequest }>(
    '/api/transport',
    { schema: patchBodySchema },
    async (request, reply) => {
      const body = request.body;

      // Reject socksProxy when mode is direct — silent ignore is ambiguous to the caller
      if (body.mode === 'direct' && body.socksProxy !== undefined) {
        return reply.status(400).send({
          error: 'invalid_body',
          message: 'socksProxy is not allowed when mode is direct',
        });
      }

      // Validate socksProxy URL format if provided
      if (body.socksProxy !== undefined) {
        try {
          const u = new URL(body.socksProxy);
          if (u.protocol !== 'socks5:' && u.protocol !== 'socks5h:') {
            return reply.status(400).send({
              error: 'invalid_socksProxy',
              message: 'socksProxy must use socks5:// or socks5h:// scheme',
            });
          }
          if (!u.hostname) {
            return reply.status(400).send({
              error: 'invalid_socksProxy',
              message: 'socksProxy must have a hostname',
            });
          }
          if (u.username || u.password) {
            return reply.status(400).send({
              error: 'invalid_socksProxy',
              message: 'socksProxy must not include credentials in the URL',
            });
          }
          if (u.pathname && u.pathname !== '/') {
            return reply.status(400).send({
              error: 'invalid_socksProxy',
              message: 'socksProxy must not include a path',
            });
          }
          if (!u.port) {
            return reply.status(400).send({
              error: 'invalid_socksProxy',
              message: 'socksProxy must specify a port',
            });
          }
          const portNum = Number(u.port);
          if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
            return reply.status(400).send({
              error: 'invalid_socksProxy',
              message: 'socksProxy port must be in range 1-65535',
            });
          }
        } catch {
          return reply.status(400).send({
            error: 'invalid_socksProxy',
            message: 'socksProxy must be a valid URL',
          });
        }
      }

      const prevMode = deps.config.transport.mode;
      const prevSocksProxy = deps.config.transport.socksProxy;
      const newMode = body.mode;
      const newSocksProxy =
        newMode === 'ator'
          ? (body.socksProxy ?? prevSocksProxy ?? DEFAULT_ATOR_PROXY)
          : undefined;

      // No-op detection: same mode and (for ATOR) URL-normalized same proxy
      const noOp =
        prevMode === newMode &&
        (newMode === 'direct' ||
          normalizeProxyUrl(prevSocksProxy) ===
            normalizeProxyUrl(newSocksProxy));

      if (noOp) {
        const noOpResponse: TransportPatchResponse = {
          mode: newMode,
          ...(newMode === 'ator' ? { socksProxy: newSocksProxy } : {}),
          restartTriggered: false,
        };
        return reply.status(200).send(noOpResponse);
      }

      // Acquire shared config mutex
      if (!acquireConfigMutex()) {
        return reply.status(409).send({ error: 'config_mutation_in_flight' });
      }

      // Snapshot the prior probe URL so a failed flip can restore it.
      const priorProbeUrl =
        prevMode === 'ator' ? (prevSocksProxy ?? DEFAULT_ATOR_PROXY) : '';

      // Snapshot the full prior transport block so a failed flip can restore
      // exactly what the operator had — not just mode + socksProxy.
      // hiddenService / externalUrl / relayHiddenService are operator-managed
      // fields that the YAML may have set up independently (story 7e28ea9);
      // the PATCH must preserve them across mode flips, otherwise toggling
      // direct→ator→direct would silently strip the hidden-service setup.
      const priorTransport = { ...deps.config.transport };

      try {
        // Mutate in-memory config — carry forward all non-mode fields, then
        // override mode and socksProxy per the request.
        const { mode: _droppedMode, socksProxy: _droppedProxy, ...carryOver } =
          priorTransport;
        deps.config.transport = {
          ...carryOver,
          mode: newMode,
          ...(newMode === 'ator' ? { socksProxy: newSocksProxy } : {}),
        };

        // Defensive round-trip validation
        try {
          validateConfig(deps.config);
        } catch (validationError) {
          // Roll back in-memory edit (restore the FULL prior block — preserves
          // hiddenService/externalUrl/relayHiddenService).
          deps.config.transport = priorTransport;
          return reply.status(500).send({
            error: 'config_validation_error',
            message:
              validationError instanceof Error
                ? validationError.message
                : 'Invalid configuration',
          });
        }

        // Persist to disk — if this fails, restore in-memory state before bailing.
        try {
          await saveConfig(deps.configPath, deps.config);
        } catch (saveError) {
          deps.config.transport = priorTransport;
          return reply.status(500).send({
            error: 'config_save_failed',
            message:
              saveError instanceof Error
                ? saveError.message
                : 'Failed to persist config',
          });
        }

        // Compute active nodes
        const activeNodes = Object.entries(deps.config.nodes)
          .filter(([, cfg]) => cfg.enabled)
          .map(([t]) => t as NodeType);

        // Trigger connector restart
        try {
          await deps.orchestrator.regenerateConnectorConfig(activeNodes);
        } catch (restartError) {
          // Rollback: restore in-memory config and persist the restoration
          deps.config.transport = priorTransport;
          try {
            await saveConfig(deps.configPath, deps.config);
          } catch {
            // Best-effort rollback of disk write — if this fails, system is in
            // a bad state but we can't do anything further here.
          }
          // Restore probe to its prior target as well so the dashboard
          // doesn't keep reporting reachability for the failed-flip URL.
          try {
            probe.setProxyUrl(priorProbeUrl);
            if (prevMode === 'ator') {
              probe.start();
            } else {
              probe.stop();
            }
          } catch {
            /* best-effort */
          }
          return reply.status(500).send({
            error: 'connector_restart_failed',
            message:
              restartError instanceof Error
                ? restartError.message
                : 'Connector restart failed',
          });
        }

        // Update probe. ATOR→ATOR with a different proxy must restart the
        // probe loop so the new URL is adopted immediately rather than at
        // the next 30 s tick.
        try {
          if (newMode === 'ator') {
            const newProbeUrl = newSocksProxy ?? DEFAULT_ATOR_PROXY;
            if (prevMode === 'ator') {
              probe.stop();
            }
            probe.setProxyUrl(newProbeUrl);
            probe.start();
          } else {
            probe.stop();
          }
        } catch (probeError) {
          // The connector restart already succeeded — log and continue.
          const msg =
            probeError instanceof Error
              ? probeError.message
              : String(probeError);
          request.log.warn(`transport probe update after flip failed: ${msg}`);
        }

        const restartedAt = Date.now();
        const successResponse: TransportPatchResponse = {
          mode: newMode,
          ...(newMode === 'ator' ? { socksProxy: newSocksProxy } : {}),
          restartTriggered: true,
          restartedAt,
        };
        return reply.status(200).send(successResponse);
      } finally {
        releaseConfigMutex();
      }
    }
  );
}
