/**
 * API Server Factory.
 *
 * SECURITY: Only binds to loopback address by default (localhost-only for v1).
 * Set TOWNHOUSE_API_ALLOW_REMOTE=1 to override this security boundary.
 */

import Fastify, { type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import type { ApiServer, ApiDeps } from './types.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerWalletRoutes } from './routes/wallet.js';
import { registerWalletBalancesRoutes } from './routes/wallet-balances.js';
import { registerWalletRevealRoutes } from './routes/wallet-reveal.js';
import { registerWalletWithdrawRoutes } from './routes/wallet-withdraw.js';
import { registerConfigPatchRoutes } from './routes/nodes-patch.js';
import {
  registerMetricsWsRoutes,
  getOpenWebSockets,
} from './routes/metrics-ws.js';
import { buildCorsOptions } from './cors.js';

/** Allowed loopback hosts */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

/**
 * Create the Fastify API server.
 */
export async function createApiServer(deps: ApiDeps): Promise<ApiServer> {
  const { config, logger } = deps;

  // SECURITY: Validate bind address (port validated at listen() time by caller)
  const bindHost = config.api.host ?? '127.0.0.1';

  if (!LOOPBACK_HOSTS.includes(bindHost)) {
    if (process.env['TOWNHOUSE_API_ALLOW_REMOTE'] !== '1') {
      throw new Error(
        'Townhouse API refuses to bind to non-loopback host without TOWNHOUSE_API_ALLOW_REMOTE=1'
      );
    }
  }

  // Create Fastify instance
  const app = Fastify({
    logger: logger ?? true,
    bodyLimit: 16 * 1024, // 16KB max body size
  } as FastifyServerOptions);

  // Custom error handler - return safe error messages
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);

    // Narrow unknown error to a FastifyError-ish shape
    const err = error as {
      statusCode?: number;
      code?: string;
      message?: string;
    };

    // CORS rejection surfaces as an Error thrown from the origin callback —
    // per AC #7 it must return 403 (not 500).
    const isCorsRejection = err.message === 'Origin not allowed';
    const statusCode = isCorsRejection ? 403 : (err.statusCode ?? 500);
    const message =
      process.env['NODE_ENV'] === 'production'
        ? 'Internal server error'
        : (err.message ?? 'Internal server error');

    reply.status(statusCode).send({
      error: isCorsRejection
        ? 'origin_not_allowed'
        : (err.code ?? 'internal_error'),
      message,
    });
  });

  // Register CORS
  await app.register(cors, buildCorsOptions());

  // Register WebSocket support
  await app.register(websocket);

  // Register routes
  registerNodeRoutes(app, deps);
  registerWalletRoutes(app, deps);
  registerWalletBalancesRoutes(app, deps);
  registerWalletRevealRoutes(app, deps);
  registerWalletWithdrawRoutes(app, deps);
  registerConfigPatchRoutes(app, deps);
  registerMetricsWsRoutes(app, deps);

  // Graceful close function (AC #10)
  // AC #10: awaits in-flight PATCH handlers up to 5 s, then exits.
  const CLOSE_TIMEOUT_MS = 5000;
  async function close(): Promise<void> {
    const openSockets = getOpenWebSockets();

    // Send close frame (code 1001, reason "server_shutdown") to all WS clients
    for (const socket of openSockets) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1001, 'server_shutdown');
        }
      } catch {
        // Best-effort
      }
    }
    openSockets.clear();

    // Close Fastify with a hard 5 s ceiling (AC #10).
    await Promise.race([
      app.close(),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]);
  }

  return { app, close };
}
