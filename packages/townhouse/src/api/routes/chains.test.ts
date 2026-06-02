/**
 * Settlement-chain config routes — GET + PATCH /api/chains.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { registerChainsRoutes } from './chains.js';
import { resetConfigMutex } from '../config-mutex.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import type { TransportProbe } from '../../connector/transport-probe.js';
import type { ChainProviderEntry } from '../../config/schema.js';
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
    configPath: '/tmp/test-chains.yaml',
    config,
    orchestrator: orchestrator as unknown as DockerOrchestrator,
    wallet: {} as unknown as WalletManager,
    connectorAdmin: {} as unknown as ConnectorAdminClient,
    transportProbe: {} as unknown as TransportProbe,
    ...overrides,
  };
  return { app, deps, orchestrator };
}

const EVM: ChainProviderEntry = {
  chainType: 'evm',
  chainId: 'evm:base:8453',
  rpcUrl: 'https://base',
  registryAddress: '0xaaa',
  tokenAddress: '0xbbb',
  keyId: '0xccc',
};
const SOL: ChainProviderEntry = {
  chainType: 'solana',
  chainId: 'solana:devnet',
  rpcUrl: 'https://sol',
  programId: 'Prog',
  keyId: 'k',
};

describe('GET /api/chains', () => {
  beforeEach(() => mockSaveConfig.mockReset());
  afterEach(() => resetConfigMutex());

  it('returns chainProviders with keyId redacted', async () => {
    const { app, deps } = build();
    deps.config.chainProviders = [EVM];
    registerChainsRoutes(app, deps);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/chains' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chainProviders).toHaveLength(1);
    expect(body.chainProviders[0].chainType).toBe('evm');
    expect(body.chainProviders[0].keyId).toBe('***');
    expect(body.chainProviders[0].registryAddress).toBe('0xaaa');
  });

  it('returns an empty array when none configured', async () => {
    const { app, deps } = build();
    registerChainsRoutes(app, deps);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/chains' });
    expect(res.json().chainProviders).toEqual([]);
  });
});

describe('PATCH /api/chains', () => {
  beforeEach(() => mockSaveConfig.mockReset());
  afterEach(() => resetConfigMutex());

  it('replaces chains, persists, and regenerates the connector', async () => {
    const { app, deps, orchestrator } = build();
    registerChainsRoutes(app, deps);
    await app.ready();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/chains',
      payload: { chainProviders: [EVM, SOL] },
    });
    expect(res.statusCode).toBe(200);
    expect(deps.config.chainProviders).toHaveLength(2);
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(orchestrator.calls.some((c) => c.startsWith('regen'))).toBe(true);
    const body = res.json();
    expect(body.restartTriggered).toBe(true);
    expect(body.chainProviders[0].keyId).toBe('***');
  });

  it('rejects an invalid entry (solana missing programId) with 400 and rolls back', async () => {
    const { app, deps } = build();
    deps.config.chainProviders = [EVM];
    registerChainsRoutes(app, deps);
    await app.ready();
    const bad = {
      chainType: 'solana',
      chainId: 'solana:devnet',
      rpcUrl: 'https://s',
      keyId: 'k',
    };
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/chains',
      payload: { chainProviders: [bad] },
    });
    expect(res.statusCode).toBe(400);
    expect(deps.config.chainProviders).toHaveLength(1);
    expect(deps.config.chainProviders?.[0]?.chainType).toBe('evm');
  });

  it('preserves the prior keyId when a redacted *** is re-submitted', async () => {
    const { app, deps } = build();
    deps.config.chainProviders = [EVM];
    registerChainsRoutes(app, deps);
    await app.ready();
    const masked = { ...EVM, keyId: '***' };
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/chains',
      payload: { chainProviders: [masked] },
    });
    expect(res.statusCode).toBe(200);
    const saved = deps.config.chainProviders?.[0] as { keyId?: string };
    expect(saved.keyId).toBe('0xccc');
  });

  it('rolls back when the connector restart fails (500)', async () => {
    const { app, deps, orchestrator } = build();
    orchestrator.shouldFail = true;
    deps.config.chainProviders = [EVM];
    registerChainsRoutes(app, deps);
    await app.ready();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/chains',
      payload: { chainProviders: [SOL] },
    });
    expect(res.statusCode).toBe(500);
    expect(deps.config.chainProviders?.[0]?.chainType).toBe('evm');
  });
});
