/**
 * POST /api/wallet/reveal
 *
 * Password-gated seed-phrase reveal.
 * SECURITY: Mnemonic is never logged, never cached beyond the request lifecycle.
 */

import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../types.js';
import { loadWallet } from '../../wallet/storage.js';
import { decryptWallet } from '../../wallet/crypto.js';

export function registerWalletRevealRoutes(
  app: FastifyInstance,
  deps: ApiDeps
): void {
  app.post('/wallet/reveal', async (request, reply) => {
    const body = request.body as { password?: unknown };

    if (
      !body ||
      typeof body.password !== 'string' ||
      body.password.length === 0 ||
      body.password.length > 256
    ) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: 'password must be a non-empty string ≤ 256 characters',
      });
    }

    const walletPath = deps.config.wallet.encrypted_path;
    let loaded: Awaited<ReturnType<typeof loadWallet>>;
    try {
      loaded = await loadWallet(walletPath);
    } catch (e) {
      // ENOENT (or any "file not found" surface) is "wallet not initialized",
      // not "corrupted" — the user just hasn't run `townhouse init` yet.
      const code = (e as { code?: string } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return reply.status(503).send({ error: 'wallet_not_initialized' });
      }
      return reply
        .status(500)
        .send({
          error: 'wallet_corrupted',
          message: 'Failed to read wallet file',
        });
    }

    if (!loaded) {
      return reply.status(503).send({ error: 'wallet_not_initialized' });
    }

    let wallet: typeof loaded.wallet;
    try {
      wallet = loaded.wallet;
      // Validate JSON structure: all required fields present
      if (!wallet.salt || !wallet.iv || !wallet.ciphertext || !wallet.tag) {
        return reply
          .status(500)
          .send({
            error: 'wallet_corrupted',
            message: 'Wallet file is missing required fields',
          });
      }
    } catch {
      return reply
        .status(500)
        .send({
          error: 'wallet_corrupted',
          message: 'Wallet file JSON is invalid',
        });
    }

    let mnemonic: string;
    try {
      mnemonic = decryptWallet(wallet, body.password);
    } catch {
      return reply.status(401).send({ error: 'invalid_password' });
    }

    // Return mnemonic directly — not stored in any module-scoped variable
    return reply.status(200).send({ mnemonic });
  });
}
