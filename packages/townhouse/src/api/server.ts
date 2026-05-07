/**
 * API Server Factory.
 *
 * SECURITY: Only binds to loopback address by default (localhost-only for v1).
 * Set TOWNHOUSE_API_ALLOW_REMOTE=1 to override this security boundary.
 */

import { WebSocket } from 'ws';
import { buildFastifyApp } from './build-app.js';
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
import { registerWizardRoutes } from './routes/wizard.js';
import { registerTransportRoutes } from './routes/transport.js';

/**
 * Create the Fastify API server. Caller MUST supply a `transportProbe` in
 * `deps` (constructed from the config and started if mode === 'ator').
 */
export async function createApiServer(deps: ApiDeps): Promise<ApiServer> {
  const { config, logger } = deps;

  const app = await buildFastifyApp({
    logger: logger ?? true,
    bindHost: config.api.host ?? '127.0.0.1',
  });

  // Register wizard state route in normal mode so the SPA can check state
  registerWizardRoutes(
    app,
    {
      configPath: deps.configPath,
      walletPath: config.wallet.encrypted_path,
    },
    { mode: 'normal' }
  );

  // Register transport routes (before nodes routes)
  registerTransportRoutes(app, deps);

  // Register all normal routes
  registerNodeRoutes(app, deps);
  registerWalletRoutes(app, deps);
  registerWalletBalancesRoutes(app, deps);
  registerWalletRevealRoutes(app, deps);
  registerWalletWithdrawRoutes(app, deps);
  registerConfigPatchRoutes(app, deps);
  registerMetricsWsRoutes(app, deps);

  const CLOSE_TIMEOUT_MS = 5000;
  async function close(): Promise<void> {
    try {
      deps.transportProbe.stop();
    } catch {
      /* best-effort — must not block shutdown */
    }

    const openSockets = getOpenWebSockets();
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

    await Promise.race([
      app.close(),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]);
  }

  return { app, close };
}
