/**
 * Node routes tests - GET /nodes, GET /nodes/:type (AC #1, #2, #9)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerNodeRoutes } from './nodes.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { getDefaultConfig } from '../../config/defaults.js';

// Mock implementations
class MockDockerOrchestrator {
  private containerState: Map<
    string,
    { name: string; type: 'connector' | 'town' | 'mill' | 'dvm'; state: string; startedAt?: string }
  >;

  constructor(
    initialState?: { name: string; type?: 'connector' | 'town' | 'mill' | 'dvm'; state: string; startedAt?: string }[]
  ) {
    this.containerState = new Map();
    (
      initialState ?? [
        { name: 'town', type: 'town' as const, state: 'running', startedAt: new Date().toISOString() },
        { name: 'mill', type: 'mill' as const, state: 'running', startedAt: new Date().toISOString() },
        { name: 'dvm', type: 'dvm' as const, state: 'stopped' },
      ]
    ).forEach((c) => this.containerState.set(c.name, { ...c, type: c.type ?? (c.name as 'connector' | 'town' | 'mill' | 'dvm') }));
  }

  on(_event: string, _callback: (data: unknown) => void): this {
    return this;
  }

  off(_event: string, _callback: (data: unknown) => void): this {
    return this;
  }

  async status() {
    return Array.from(this.containerState.values());
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
  private shouldFail = false;

  setFail(fail: boolean) {
    this.shouldFail = fail;
  }

  async getMetrics() {
    if (this.shouldFail) {
      throw new Error('Connector unavailable');
    }
    return {
      uptimeSeconds: 60,
      aggregate: {
        packetsForwarded: 100,
        packetsRejected: 10,
        bytesSent: 5000,
      },
      peers: [],
      timestamp: new Date().toISOString(),
    };
  }
}

describe('Node Routes', () => {
  let app: FastifyInstance;
  let deps: ApiDeps;

  beforeEach(() => {
    app = Fastify();
    deps = {
      configPath: '/tmp/test-config.yaml',
      config: getDefaultConfig(),
      orchestrator:
        new MockDockerOrchestrator() as unknown as DockerOrchestrator,
      wallet: new MockWalletManager() as unknown as WalletManager,
      connectorAdmin:
        new MockConnectorAdminClient() as unknown as ConnectorAdminClient,
    };
    registerNodeRoutes(app, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /nodes (AC #1)', () => {
    it('should return array of node types', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/nodes',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(3);

      // Check each node has required fields
      for (const node of body) {
        expect(node).toHaveProperty('type');
        expect(node).toHaveProperty('enabled');
        expect(node).toHaveProperty('state');
        expect(node).toHaveProperty('uptimeSeconds');
        expect(node).toHaveProperty('image');
      }
    });

    it('should include state from orchestrator', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/nodes',
      });

      const body = JSON.parse(response.body);
      const town = body.find((n: { type: string }) => n.type === 'town');
      expect(town.state).toBe('running');
    });
  });

  describe('GET /nodes/:type (AC #2)', () => {
    it('should return detail for valid type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/nodes/town',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('town');
      expect(body).toHaveProperty('config');
      expect(body).toHaveProperty('metrics');
    });

    it('should return 404 for unknown type (AC #9)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/nodes/unknown',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('unknown_node_type');
      expect(body.type).toBe('unknown');
    });

    it('should return degraded state when connector is down', async () => {
      // Create deps with a connector that fails
      const failingConnector = new MockConnectorAdminClient();
      failingConnector.setFail(true);

      const depsWithFailingConnector = {
        ...deps,
        connectorAdmin: failingConnector as unknown as ConnectorAdminClient,
      };

      const testApp = Fastify();
      registerNodeRoutes(testApp, depsWithFailingConnector);

      const response = await testApp.inject({
        method: 'GET',
        url: '/nodes/town',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // When connector is down the detail endpoint returns a degraded marker
      // (available: false), NOT null. Null is reserved for "never attempted".
      expect(body.metrics).toMatchObject({ available: false });

      await testApp.close();
    });
  });
});
