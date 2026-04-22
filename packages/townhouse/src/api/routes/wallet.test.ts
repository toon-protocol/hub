/**
 * Wallet routes tests - GET /wallet (AC #4)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerWalletRoutes } from './wallet.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { getDefaultConfig } from '../../config/defaults.js';

// Mock implementations
class MockDockerOrchestrator {
  on(_event: string, _callback: (data: unknown) => void): this {
    return this;
  }

  off(_event: string, _callback: (data: unknown) => void): this {
    return this;
  }

  async status() {
    return [];
  }

  async addNode() {}
  async removeNode() {}
  async regenerateConnectorConfig() {}
}

class MockConnectorAdminClient {
  async getMetrics() {
    return {
      packetsForwarded: 100,
      packetsRejected: 10,
      bytesSent: 5000,
    };
  }
}

// Real WalletManager test with ephemeral keys
describe('Wallet Routes', () => {
  let app: FastifyInstance;
  let walletManager: WalletManager;
  let deps: ApiDeps;

  beforeEach(async () => {
    // Create a real WalletManager with a test mnemonic
    walletManager = new WalletManager({ encryptedPath: '' });
    walletManager.fromMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );

    app = Fastify();
    deps = {
      configPath: '/tmp/test-config.yaml',
      config: getDefaultConfig(),
      orchestrator:
        new MockDockerOrchestrator() as unknown as DockerOrchestrator,
      wallet: walletManager as unknown as WalletManager,
      connectorAdmin:
        new MockConnectorAdminClient() as unknown as ConnectorAdminClient,
    };
    registerWalletRoutes(app, deps);
  });

  afterEach(async () => {
    walletManager.lock();
    await app.close();
  });

  describe('GET /wallet (AC #4)', () => {
    it('should return keys array', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/wallet',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('keys');
      expect(Array.isArray(body.keys)).toBe(true);
    });

    it('should include nostrPubkey for each key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/wallet',
      });

      const body = JSON.parse(response.body);
      expect(body.keys.length).toBe(3); // town, mill, dvm

      for (const key of body.keys) {
        expect(key).toHaveProperty('nostrPubkey');
        expect(key.nostrPubkey).toMatch(/^[a-fA-F0-9]{64}$/);
      }
    });

    it('should include evmAddress for each key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/wallet',
      });

      const body = JSON.parse(response.body);
      for (const key of body.keys) {
        expect(key).toHaveProperty('evmAddress');
        // EIP-55 checksummed addresses are mixed-case
        expect(key.evmAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });

    // Test that addresses ARE exposed - this is the expected behavior
    it('SHOULD include addresses (security boundary is address-only)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/wallet',
      });

      const body = JSON.parse(response.body);
      expect(body.keys[0].nostrPubkey).toBeDefined();
      expect(body.keys[0].evmAddress).toBeDefined();
      expect(body.keys[0].nostrDerivationPath).toBeDefined();
    });
  });

  describe('Secret leak assertion (AC #4)', () => {
    it('should NOT contain any secret fields in response', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/wallet',
      });

      const bodyStr = response.body;

      // Deny-list of secret substrings
      const secretPatterns = ['privateKey', 'secretKey', 'mnemonic', 'seed'];

      for (const pattern of secretPatterns) {
        expect(bodyStr.toLowerCase()).not.toContain(pattern.toLowerCase());
      }
    });
  });
});
