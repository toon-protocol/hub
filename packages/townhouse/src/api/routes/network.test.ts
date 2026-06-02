/**
 * Network-mode config routes — GET + PATCH /api/network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { registerNetworkRoutes } from './network.js';
import { resetConfigMutex } from '../config-mutex.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import type { TransportProbe } from '../../connector/transport-probe.js';
import { getDefaultConfig } from '../../config/index.js';

class MockOrchestrator {
  calls: string[] = [];
  shouldFail = false;
  async regenerateConnectorConfig(types: string[]): Promise<void> {
    this.calls.push(`regen(${types.join(',')})`);
    if (this.shouldFail) throw new Error('restart failed');
  }
}

vi.mock('../../config/loader.js', () => ({
  saveConfig: vi.fn(),
  loadConfig: vi.fn(),
}));
import { saveConfig } from '../../config/loader.js';
const mockSaveConfig = vi.mocked(saveConfig);

function build(overrides: Partial<ApiDeps> = {}) {
  const app = Fastify({ logger: false });
  const orchestrator = new MockOrchestrator();
  const config = getDefaultConfig();
  config.nodes.town = { ...config.nodes.town, enabled: true };
  const deps: ApiDeps = {
    configPath: '/tmp/test-network.yaml',
    config,
    orchestrator: orchestrator as unknown as DockerOrchestrator,
    wallet: {} as unknown as WalletManager,
    connectorAdmin: {} as unknown as ConnectorAdminClient,
    transportProbe: {} as unknown as TransportProbe,
    ...overrides,
  };
  return { app, deps, orchestrator };
}

describe('GET /api/network', () => {
  beforeEach(() => resetConfigMutex());
  afterEach(() => vi.clearAllMocks());

  it('defaults to mainnet and surfaces the resolved Base profile', async () => {
    const { app, deps } = build();
    registerNetworkRoutes(app, deps);
    const res = await app.inject({ method: 'GET', url: '/api/network' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.network).toBe('mainnet');
    expect(body.nodeEnv.EVM_CHAIN).toBe('base-mainnet');
    expect(body.status.evm).toBe('unconfigured'); // no TOON contracts yet
    await app.close();
  });
});

describe('PATCH /api/network', () => {
  beforeEach(() => resetConfigMutex());
  afterEach(() => vi.clearAllMocks());

  it('sets the mode, persists, regenerates connector, and echoes the profile', async () => {
    const { app, deps, orchestrator } = build();
    registerNetworkRoutes(app, deps);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/network',
      payload: { network: 'testnet' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.network).toBe('testnet');
    expect(body.nodeEnv.EVM_CHAIN).toBe('base-sepolia');
    expect(body.restartTriggered).toBe(true);
    expect(deps.config.network).toBe('testnet');
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(orchestrator.calls).toEqual(['regen(town)']);
    await app.close();
  });

  it('rejects an unknown mode (schema enum)', async () => {
    const { app, deps } = build();
    registerNetworkRoutes(app, deps);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/network',
      payload: { network: 'moonbase' },
    });
    expect(res.statusCode).toBe(400);
    expect(deps.config.network).toBeUndefined();
    await app.close();
  });

  it('rolls back the mode when the connector restart fails', async () => {
    const { app, deps, orchestrator } = build();
    orchestrator.shouldFail = true;
    registerNetworkRoutes(app, deps);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/network',
      payload: { network: 'devnet' },
    });
    expect(res.statusCode).toBe(500);
    expect(deps.config.network).toBeUndefined(); // rolled back
    await app.close();
  });
});
