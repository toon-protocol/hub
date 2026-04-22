/**
 * Wallet routes: GET /wallet
 */

import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../types.js';

/**
 * Register wallet routes.
 */
export function registerWalletRoutes(
  app: FastifyInstance,
  deps: ApiDeps
): void {
  // GET /wallet - list all wallet keys (address-only, no secrets)
  app.get('/wallet', async (_request, _reply) => {
    // Returns NodeKeyInfo[] which has NO secrets
    const keys = deps.wallet.listKeys();
    return { keys };
  });
}
