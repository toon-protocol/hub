/**
 * GET /api/earnings — earnings aggregator route (Story D4).
 *
 * Returns per-source totals + recent items. The actual aggregation logic
 * lives in `../../earnings/aggregator.ts`; this route is a thin wrapper that
 *   1. Resolves the leases.json path the same way the demo preset does.
 *   2. Parses the optional `?since=` ms-epoch query parameter.
 *   3. Hands off to the aggregator and returns its payload verbatim.
 *
 * The route is non-streaming — for the D4 milestone we keep it as a poll
 * target (the dashboard polls every 5 s). When the metrics WebSocket gets
 * a settlement-event channel (post-D4), an SSE/WS upgrade can land without
 * changing the response shape.
 */

import { resolve } from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../types.js';
import {
  aggregateEarnings,
  DEFAULT_SINCE_MS,
  type EarningsPayload,
} from '../../earnings/aggregator.js';

/**
 * Optional knob for tests — lets the test suite pin the leases.json path
 * without depending on `process.cwd()`. Production callers always rely on
 * the default (`<cwd>/deploy/akash/leases.json`, mirroring `presets/demo.ts`).
 */
export interface RegisterEarningsRoutesOptions {
  /**
   * Override the resolved leases.json path. Pass `null` to force "no leases"
   * (skips file system entirely). Pass `undefined` (default) to use
   * `<cwd>/deploy/akash/leases.json`.
   */
  leasesPath?: string | null;
}

/** Default location of the Akash leases file (mirrors `presets/demo.ts`). */
function defaultLeasesPath(): string {
  return resolve(process.cwd(), 'deploy', 'akash', 'leases.json');
}

interface EarningsQuery {
  /** ms-epoch lower bound. Validated as a non-negative integer. */
  since?: string;
}

export function registerEarningsRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  opts: RegisterEarningsRoutesOptions = {}
): void {
  // Resolve the leases path once at registration time. `null` opts the
  // route into "no leases" mode (no explorerUrl in items) without touching
  // the file system on every request.
  const leasesPath: string | null =
    opts.leasesPath === null ? null : (opts.leasesPath ?? defaultLeasesPath());

  app.get<{ Querystring: EarningsQuery }>(
    '/api/earnings',
    async (request: FastifyRequest<{ Querystring: EarningsQuery }>, reply) => {
      const sinceRaw = request.query.since;
      let sinceMs: number | undefined;

      if (sinceRaw !== undefined) {
        // Reject scientific notation / non-decimal — silent parseInt
        // truncation would let `?since=1e10` quietly become `?since=1`.
        if (!/^\d+$/.test(sinceRaw)) {
          return reply.status(400).send({
            error: 'invalid_since',
            message: 'since must be a non-negative ms-epoch integer',
          });
        }
        const parsed = Number(sinceRaw);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return reply.status(400).send({
            error: 'invalid_since',
            message: 'since must be a non-negative ms-epoch integer',
          });
        }
        sinceMs = parsed;
      }

      try {
        const payload: EarningsPayload = await aggregateEarnings({
          connectorAdmin: deps.connectorAdmin,
          orchestrator: deps.orchestrator,
          leasesPath,
          sinceMs,
        });
        return payload;
      } catch (err) {
        // The aggregator already swallows per-source errors; an outer throw
        // means something more fundamental is broken. Surface as 500 with a
        // structured shape so the dashboard can render an error state.
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err: msg }, 'earnings aggregation failed');
        return reply.status(500).send({
          error: 'earnings_aggregation_failed',
          message: msg,
        });
      }
    }
  );
}

/** Re-export so `index.ts` can export the same default in one place. */
export { DEFAULT_SINCE_MS };
