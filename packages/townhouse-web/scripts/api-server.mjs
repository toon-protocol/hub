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

const docker = new Docker();
const orchestrator = new DockerOrchestrator(docker, config);

const walletPath = config.wallet.encrypted_path ?? join(homedir(), '.townhouse', 'wallet.enc');
const wallet = new WalletManager({ encryptedPath: walletPath });

const connectorAdmin = new ConnectorAdminClient(connectorAdminUrl);

const apiDeps = {
  configPath: walletPath,
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
