/**
 * API Server Factory.
 *
 * SECURITY: Only binds to loopback address by default (localhost-only for v1).
 * Set TOWNHOUSE_API_ALLOW_REMOTE=1 to override this security boundary.
 */

import { join, dirname } from 'node:path';
import { WebSocket } from 'ws';
import { buildFastifyApp } from './build-app.js';
import type { ApiServer, ApiDeps } from './types.js';
import { SnapshotWriter } from '../earnings/snapshot-writer.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerWalletRoutes } from './routes/wallet.js';
import { registerWalletBalancesRoutes } from './routes/wallet-balances.js';
import { registerWalletRevealRoutes } from './routes/wallet-reveal.js';
import { registerWalletWithdrawRoutes } from './routes/wallet-withdraw.js';
import { registerConfigPatchRoutes } from './routes/nodes-patch.js';
import { registerNodeLifecycleRoutes } from './routes/nodes-lifecycle.js';
import {
  registerMetricsWsRoutes,
  getOpenWebSockets,
} from './routes/metrics-ws.js';
import { registerWizardRoutes } from './routes/wizard.js';
import { registerTransportRoutes } from './routes/transport.js';
import { registerChainsRoutes } from './routes/chains.js';
import { registerNetworkRoutes } from './routes/network.js';
import { registerEarningsRoutes } from './routes/earnings.js';
import { registerLogsRoutes } from './routes/logs.js';

/**
 * Create the Fastify API server. Caller MUST supply a `transportProbe` in
 * `deps` (constructed from the config and started if mode === 'hs').
 */
export async function createApiServer(deps: ApiDeps): Promise<ApiServer> {
  const { config, logger } = deps;

  const snapshotPath = join(
    dirname(deps.configPath),
    'earnings-snapshots.jsonl'
  );
  const snapshotWriter = new SnapshotWriter({
    connectorAdmin: deps.connectorAdmin,
    snapshotPath,
    logger: logger as { warn(obj: object, msg?: string): void } | undefined,
  });

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

  // Register settlement-chain config routes (EVM/Solana/Mina)
  registerChainsRoutes(app, deps);

  // Register network-mode route (mainnet/testnet/devnet/custom)
  registerNetworkRoutes(app, deps);

  // Register all normal routes
  registerNodeRoutes(app, deps);
  registerWalletRoutes(app, deps);
  registerWalletBalancesRoutes(app, deps);
  registerWalletRevealRoutes(app, deps);
  registerWalletWithdrawRoutes(app, deps);
  registerConfigPatchRoutes(app, deps);
  registerNodeLifecycleRoutes(app, deps);
  registerEarningsRoutes(app, deps);
  registerLogsRoutes(app, deps);
  registerMetricsWsRoutes(app, deps);

  snapshotWriter.start();

  const CLOSE_TIMEOUT_MS = 5000;
  async function close(): Promise<void> {
    try {
      snapshotWriter.stop();
    } catch {
      /* best-effort */
    }
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
