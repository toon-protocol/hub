/**
 * Config patch route tests - PATCH /nodes/:type/config (AC #3)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerConfigPatchRoutes, resetConfigMutex } from './nodes-patch.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { getDefaultConfig } from '../../config/index.js';

// Mock orchestrator that records calls
class MockDockerOrchestrator {
  calls: string[] = [];
  private nodeState: Record<string, boolean> = {};

  constructor(initialEnabled = { town: true, mill: true, dvm: true }) {
    this.nodeState = { ...initialEnabled };
  }

  on(_event: string, _callback: (data: unknown) => void): this {
    return this;
  }

  off(_event: string, _callback: (data: unknown) => void): this {
    return this;
  }

  async status() {
    return Object.entries(this.nodeState).map(([name, running]) => ({
      name,
      state: running ? 'running' : 'stopped',
      startedAt: running ? new Date().toISOString() : undefined,
    }));
  }

  async addNode(type: string) {
    this.calls.push(`addNode(${type})`);
    this.nodeState[type] = true;
  }

  async removeNode(type: string) {
    this.calls.push(`removeNode(${type})`);
    this.nodeState[type] = false;
  }

  async regenerateConnectorConfig(_types: string[]) {
    this.calls.push('regenerateConnectorConfig');
  }

  getCalls() {
    return [...this.calls];
  }

  clearCalls() {
    this.calls = [];
  }
}

class MockWalletManager {
  listKeys() {
    return [];
  }
}

class MockConnectorAdminClient {
  async getMetrics() {
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

describe('Config Patch Routes', () => {
  let app: FastifyInstance;
  let mockOrchestrator: MockDockerOrchestrator;
  let deps: ApiDeps;

  beforeEach(() => {
    resetConfigMutex();
    app = Fastify();
    mockOrchestrator = new MockDockerOrchestrator();
    deps = {
      configPath: '/tmp/test-config.yaml',
      config: getDefaultConfig(),
      orchestrator: mockOrchestrator as unknown as DockerOrchestrator,
      wallet: new MockWalletManager() as unknown as WalletManager,
      connectorAdmin:
        new MockConnectorAdminClient() as unknown as ConnectorAdminClient,
    };
    registerConfigPatchRoutes(app, deps);
  });

  afterEach(async () => {
    await app.close();
    mockOrchestrator.clearCalls();
  });

  describe('PATCH /nodes/:type/config (AC #3)', () => {
    it('should update config on valid patch', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/nodes/town/config',
        payload: { feePerEvent: 1000 },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return 404 for unknown node type', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/nodes/unknown/config',
        payload: { feePerEvent: 1000 },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('unknown_node_type');
    });

    it('should return 409 when mutation already in flight', async () => {
      // D2 (Round-2): deterministic mutex test. Hang
      // `regenerateConnectorConfig` (called inside the mutex, AFTER saveConfig)
      // so request 1 holds the mutex until we release it. This avoids touching
      // prod code and does not require module mocking.
      let releaseFirst!: () => void;
      const firstOrchestratorHang = new Promise<void>((res) => {
        releaseFirst = res;
      });
      const testApp = Fastify();
      const hangingMock = new MockDockerOrchestrator();
      hangingMock.regenerateConnectorConfig = async () => {
        hangingMock.calls.push('regenerateConnectorConfig');
        await firstOrchestratorHang;
      };
      const hangingDeps: ApiDeps = {
        configPath: '/tmp/test-config-mutex.yaml',
        config: getDefaultConfig(),
        orchestrator: hangingMock as unknown as DockerOrchestrator,
        wallet: new MockWalletManager() as unknown as WalletManager,
        connectorAdmin:
          new MockConnectorAdminClient() as unknown as ConnectorAdminClient,
      };
      registerConfigPatchRoutes(testApp, hangingDeps);

      // Fire request 1 — enters handler, saves, then hangs inside the mutex.
      const firstRequestP = testApp.inject({
        method: 'PATCH',
        url: '/nodes/town/config',
        payload: { feePerEvent: 1000 },
      });

      // Yield microtasks so the first handler reaches the hang point.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Fire request 2 — mutex is held, must return 409.
      const secondResponse = await testApp.inject({
        method: 'PATCH',
        url: '/nodes/town/config',
        payload: { feePerEvent: 2000 },
      });
      expect(secondResponse.statusCode).toBe(409);
      expect(JSON.parse(secondResponse.body).error).toBe(
        'config_mutation_in_flight'
      );

      // Release and let the first request finish.
      releaseFirst();
      const firstResponse = await firstRequestP;
      expect(firstResponse.statusCode).toBe(200);

      await testApp.close();
    });

    it('should call addNode when enabled flips to true', async () => {
      // Create config with town disabled
      const configWithDisabled = {
        ...getDefaultConfig(),
        nodes: {
          ...getDefaultConfig().nodes,
          town: {
            ...getDefaultConfig().nodes.town,
            enabled: false,
          },
        },
      };

      const depsWithDisabled = {
        ...deps,
        config: configWithDisabled,
      };

      const testApp = Fastify();
      const mockWithDisabled = new MockDockerOrchestrator({
        town: false,
        mill: true,
        dvm: true,
      });
      registerConfigPatchRoutes(testApp, {
        ...depsWithDisabled,
        orchestrator: mockWithDisabled as unknown as DockerOrchestrator,
      });

      const response = await testApp.inject({
        method: 'PATCH',
        url: '/nodes/town/config',
        payload: { enabled: true },
      });

      expect(response.statusCode).toBe(200);
      expect(mockWithDisabled.getCalls()).toContain('addNode(town)');

      await testApp.close();
    });

    it('should run BOTH addNode/removeNode AND regenerateConnectorConfig when enabled AND fees change in one PATCH (D2 2026-04-21)', async () => {
      // Start with town disabled; PATCH enables it AND changes feePerEvent.
      const configWithDisabled = {
        ...getDefaultConfig(),
        nodes: {
          ...getDefaultConfig().nodes,
          town: { ...getDefaultConfig().nodes.town, enabled: false },
        },
      };
      const testApp = Fastify();
      const mock = new MockDockerOrchestrator({
        town: false,
        mill: true,
        dvm: true,
      });
      registerConfigPatchRoutes(testApp, {
        ...deps,
        config: configWithDisabled,
        orchestrator: mock as unknown as DockerOrchestrator,
      });

      const response = await testApp.inject({
        method: 'PATCH',
        url: '/nodes/town/config',
        payload: { enabled: true, feePerEvent: 1234 },
      });

      expect(response.statusCode).toBe(200);
      const calls = mock.getCalls();
      expect(calls).toContain('addNode(town)');
      expect(calls).toContain('regenerateConnectorConfig');

      await testApp.close();
    });

    it('should call removeNode when enabled flips to false', async () => {
      const configWithEnabled = {
        ...getDefaultConfig(),
        nodes: {
          ...getDefaultConfig().nodes,
          town: {
            ...getDefaultConfig().nodes.town,
            enabled: true,
          },
        },
      };

      const depsWithEnabled = {
        ...deps,
        config: configWithEnabled,
      };

      const testApp = Fastify();
      const mockWithEnabled = new MockDockerOrchestrator({
        town: true,
        mill: true,
        dvm: true,
      });
      registerConfigPatchRoutes(testApp, {
        ...depsWithEnabled,
        orchestrator: mockWithEnabled as unknown as DockerOrchestrator,
      });

      const response = await testApp.inject({
        method: 'PATCH',
        url: '/nodes/town/config',
        payload: { enabled: false },
      });

      expect(response.statusCode).toBe(200);
      expect(mockWithEnabled.getCalls()).toContain('removeNode(town)');

      await testApp.close();
    });
  });
});

// ── kindPricing tests (AC-7, Story 21.12) ────────────────────────────────────

describe('PATCH /nodes/dvm/config — kindPricing support', () => {
  let app: FastifyInstance;
  let deps: ApiDeps;
  let mock: MockDockerOrchestrator;

  beforeEach(async () => {
    const config = getDefaultConfig();
    config.nodes.dvm.enabled = true;
    mock = new MockDockerOrchestrator({ town: true, mill: true, dvm: true });
    deps = {
      configPath: '/tmp/test-config.yaml',
      config,
      orchestrator: mock as unknown as DockerOrchestrator,
      wallet: {} as unknown as WalletManager,
      connectorAdmin: {} as unknown as ConnectorAdminClient,
    };
    app = Fastify();
    registerConfigPatchRoutes(app, deps);
    resetConfigMutex();
  });

  afterEach(async () => {
    await app.close();
    resetConfigMutex();
  });

  it('PATCH dvm with kindPricing succeeds and returns kindPricing', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/nodes/dvm/config',
      payload: { kindPricing: { '5094': 5 } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { kindPricing: Record<string, number> };
    expect(body.kindPricing).toEqual({ '5094': 5 });
  });

  it('PATCH dvm with both feePerJob + kindPricing succeeds', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/nodes/dvm/config',
      payload: { feePerJob: 100, kindPricing: { '5094': 5, '5250': 10000 } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { feePerJob: number; kindPricing: Record<string, number> };
    expect(body.feePerJob).toBe(100);
    expect(body.kindPricing).toEqual({ '5094': 5, '5250': 10000 });
    expect(mock.getCalls()).toContain('regenerateConnectorConfig');
  });

  it('PATCH dvm with kindPricing triggers regenerateConnectorConfig', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/nodes/dvm/config',
      payload: { kindPricing: { '5094': 5 } },
    });

    expect(response.statusCode).toBe(200);
    expect(mock.getCalls()).toContain('regenerateConnectorConfig');
  });

  it('PATCH town with kindPricing returns 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/nodes/town/config',
      payload: { kindPricing: { '5094': 5 } },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; message: string };
    expect(body.error).toBe('invalid_field');
    expect(body.message).toContain('kindPricing not supported for type=town');
  });

  it('PATCH dvm with negative kindPricing value returns 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/nodes/dvm/config',
      payload: { kindPricing: { '5094': -1 } },
    });

    expect(response.statusCode).toBe(400);
  });
});
