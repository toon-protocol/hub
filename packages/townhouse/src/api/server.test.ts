/**
 * API Server tests - bind address and CORS (AC #6, #7)
 */

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createApiServer } from './server.js';
import { buildCorsOptions } from './cors.js';
import type { DockerOrchestrator } from '../docker/orchestrator.js';
import type { WalletManager } from '../wallet/manager.js';
import type { ConnectorAdminClient } from '../connector/admin-client.js';
import { getDefaultConfig } from '../config/defaults.js';

// Mock implementations for testing
class MockDockerOrchestrator {
  private state = 'stopped';

  on(_event: string, _callback: (data: unknown) => void): this {
    return this;
  }

  off(_event: string, _callback: (data: unknown) => void): this {
    return this;
  }

  async status() {
    return [
      { name: 'town', state: 'running', startedAt: new Date().toISOString() },
      { name: 'mill', state: 'running', startedAt: new Date().toISOString() },
      { name: 'dvm', state: 'running', startedAt: new Date().toISOString() },
    ];
  }

  async addNode() {}
  async removeNode() {}
  async regenerateConnectorConfig() {}
}

class MockWalletManager {
  listKeys() {
    return [];
  }
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

describe('API Server', () => {
  describe('bind address enforcement (AC #6)', () => {
    it('should bind to loopback address by default', async () => {
      const config = {
        ...getDefaultConfig(),
        api: { host: '127.0.0.1', port: 0 }, // Use port 0 for ephemeral
      };

      const server = await createApiServer({
        configPath: '/tmp/test-config.yaml',
        config,
        orchestrator:
          new MockDockerOrchestrator() as unknown as DockerOrchestrator,
        wallet: new MockWalletManager() as unknown as WalletManager,
        connectorAdmin:
          new MockConnectorAdminClient() as unknown as ConnectorAdminClient,
      });

      expect(server.app).toBeDefined();
      await server.close();
    });

    it('should refuse to bind to non-loopback without env var', async () => {
      const config = {
        ...getDefaultConfig(),
        api: { host: '0.0.0.0', port: 0 },
      };

      // Clear env var if set
      const oldEnv = process.env['TOWNHOUSE_API_ALLOW_REMOTE'];
      delete process.env['TOWNHOUSE_API_ALLOW_REMOTE'];

      try {
        await expect(
          createApiServer({
            configPath: '/tmp/test-config.yaml',
            config,
            orchestrator:
              new MockDockerOrchestrator() as unknown as DockerOrchestrator,
            wallet: new MockWalletManager() as unknown as WalletManager,
            connectorAdmin:
              new MockConnectorAdminClient() as unknown as ConnectorAdminClient,
          })
        ).rejects.toThrow('non-loopback host');
      } finally {
        if (oldEnv !== undefined) {
          process.env['TOWNHOUSE_API_ALLOW_REMOTE'] = oldEnv;
        }
      }
    });

    it('should bind to non-loopback when env var is set', async () => {
      const config = {
        ...getDefaultConfig(),
        api: { host: '0.0.0.0', port: 0 },
      };

      const oldEnv = process.env['TOWNHOUSE_API_ALLOW_REMOTE'];
      process.env['TOWNHOUSE_API_ALLOW_REMOTE'] = '1';

      try {
        const server = await createApiServer({
          configPath: '/tmp/test-config.yaml',
          config,
          orchestrator:
            new MockDockerOrchestrator() as unknown as DockerOrchestrator,
          wallet: new MockWalletManager() as unknown as WalletManager,
          connectorAdmin:
            new MockConnectorAdminClient() as unknown as ConnectorAdminClient,
        });

        expect(server.app).toBeDefined();
        await server.close();
      } finally {
        if (oldEnv !== undefined) {
          process.env['TOWNHOUSE_API_ALLOW_REMOTE'] = oldEnv;
        } else {
          delete process.env['TOWNHOUSE_API_ALLOW_REMOTE'];
        }
      }
    });
  });

  describe('CORS policy (AC #7)', () => {
    // These tests spin up a real Fastify + the real buildCorsOptions + the
    // real error handler wiring (mirror of server.ts) so the allow/reject
    // behaviour is exercised end-to-end.
    async function buildCorsApp() {
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const err = error as {
          message?: string;
          statusCode?: number;
          code?: string;
        };
        const isCorsRejection = err.message === 'Origin not allowed';
        const statusCode = isCorsRejection ? 403 : (err.statusCode ?? 500);
        reply.status(statusCode).send({
          error: isCorsRejection
            ? 'origin_not_allowed'
            : (err.code ?? 'internal_error'),
          message: err.message ?? 'Internal server error',
        });
      });
      await app.register(cors, buildCorsOptions());
      app.get('/test', async () => ({ ok: true }));
      return app;
    }

    it('should allow requests with no origin header', async () => {
      const app = await buildCorsApp();
      const response = await app.inject({ method: 'GET', url: '/test' });
      expect(response.statusCode).toBe(200);
      await app.close();
    });

    it('should allow localhost origins', async () => {
      const app = await buildCorsApp();
      const response = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173'
      );
      await app.close();
    });

    it('should reject non-localhost origins with 403 and no CORS header', async () => {
      const app = await buildCorsApp();
      const response = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { Origin: 'http://evil.com' },
      });
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('origin_not_allowed');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      await app.close();
    });
  });
});
