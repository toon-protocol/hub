#!/usr/bin/env node
/**
 * Townhouse Fastify API server for the dev:docker loop.
 * Env vars are pre-loaded by dotenv-cli from .env.townhouse-dev.
 * Starts the API on port 9400, pointed at TOWNHOUSE_CONNECTOR_ADMIN_URL.
 */

import Docker from 'dockerode';
import {
  getDefaultConfig,
  DockerOrchestrator,
  WalletManager,
  ConnectorAdminClient,
  createApiServer,
} from '@toon-protocol/townhouse';
import { homedir } from 'node:os';
import { join } from 'node:path';

const connectorAdminUrl =
  process.env['TOWNHOUSE_CONNECTOR_ADMIN_URL'] ?? 'http://127.0.0.1:28080';

const config = getDefaultConfig();

// Dev-loop convenience: until the first-run wizard (story 21.14) ships,
// flip the three node types to enabled so the Home view (story 21.9-lite)
// has cards to render instead of bouncing into the empty state. The
// underlying Docker orchestrator still reports the real container state —
// the dev stack uses different container names (`townhouse-dev-*`) so cards
// will surface as `down` until 21.14 wires the orchestrator to dev fixtures.
config.nodes.town = { ...config.nodes.town, enabled: true };
config.nodes.mill = { ...config.nodes.mill, enabled: true };
config.nodes.dvm = { ...config.nodes.dvm, enabled: true };

const docker = new Docker();
const orchestrator = new DockerOrchestrator(docker, config);

const walletPath = config.wallet.encrypted_path ?? join(homedir(), '.townhouse', 'wallet.enc');
const wallet = new WalletManager({ encryptedPath: walletPath });

const connectorAdmin = new ConnectorAdminClient(connectorAdminUrl);

// `configPath` is the YAML config destination consumed by `nodes-patch` route's
// `saveConfig(deps.configPath, ...)`. Must NOT collide with `walletPath` — that
// would corrupt the encrypted wallet file on a `PATCH /api/nodes/:type`.
const configPath = process.env['TOWNHOUSE_CONFIG_PATH'] ?? join(homedir(), '.townhouse', 'townhouse-dev.yaml');

const apiDeps = {
  configPath,
  config,
  orchestrator,
  wallet,
  connectorAdmin,
};

const server = await createApiServer(apiDeps);

try {
  await server.app.listen({ host: '127.0.0.1', port: 9400 });
} catch (err) {
  console.error('[Townhouse API] failed to listen on 127.0.0.1:9400:', err);
  process.exit(1);
}
console.log('[Townhouse API] listening on http://127.0.0.1:9400');
console.log(`[Townhouse API] connector admin: ${connectorAdminUrl}`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await server.close().catch((err) => {
    console.error('[Townhouse API] error during shutdown:', err);
  });
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
