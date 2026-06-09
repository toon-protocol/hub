/**
 * Transport routes tests — GET + PATCH /api/transport (AC-2, AC-3, AC-5, AC-7, AC-8)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerTransportRoutes } from './transport.js';
import { resetConfigMutex } from '../config-mutex.js';
import { resetConfigMutex as legacyResetConfigMutex } from './nodes-patch.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import type { TransportProbe } from '../../connector/transport-probe.js';
import { getDefaultConfig } from '../../config/index.js';

// ── Mock helpers ──────────────────────────────────────────────────────────────

class MockDockerOrchestrator {
  calls: string[] = [];
  shouldFail = false;

  on(_e: string, _cb: unknown): this {
    return this;
  }
  off(_e: string, _cb: unknown): this {
    return this;
  }

  async regenerateConnectorConfig(types: string[]) {
    this.calls.push(`regenerateConnectorConfig(${types.join(',')})`);
    if (this.shouldFail) {
      throw new Error('docker restart failed');
    }
  }

  async addNode(type: string) {
    this.calls.push(`addNode(${type})`);
  }
  async removeNode(type: string) {
    this.calls.push(`removeNode(${type})`);
  }

  async status() {
    return [];
  }
}

class MockTransportProbe {
  calls: string[] = [];
  private _status = {
    reachable: true,
    latencyProxyMs: 45 as number | null,
    latencyDirectMs: 5 as number | null,
    lastProbedAt: Date.now(),
    probeError: null as string | null,
  };

  setMockStatus(patch: Partial<typeof this._status>) {
    Object.assign(this._status, patch);
  }

  getStatus() {
    return { ...this._status };
  }
  start() {
    this.calls.push('start');
  }
  stop() {
    this.calls.push('stop');
  }
  setProxyUrl(url: string) {
    this.calls.push(`setProxyUrl(${url})`);
  }
}

// ── Test setup ────────────────────────────────────────────────────────────────

function buildDeps(overrides?: Partial<ApiDeps>): {
  app: FastifyInstance;
  deps: ApiDeps;
  orchestrator: MockDockerOrchestrator;
  probe: MockTransportProbe;
} {
  // Match build-app.ts ajv config so additionalProperties:false rejects (not strips)
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const orchestrator = new MockDockerOrchestrator();
  const probe = new MockTransportProbe();
  const config = getDefaultConfig();
  config.nodes.town = { ...config.nodes.town, enabled: true };
  config.nodes.mill = { ...config.nodes.mill, enabled: false };
  config.nodes.dvm = { ...config.nodes.dvm, enabled: false };

  const deps: ApiDeps = {
    configPath: '/tmp/test-transport-config.yaml',
    config,
    orchestrator: orchestrator as unknown as DockerOrchestrator,
    wallet: {} as unknown as WalletManager,
    connectorAdmin: {} as unknown as ConnectorAdminClient,
    transportProbe: probe as unknown as TransportProbe,
    ...overrides,
  };

  return { app, deps, orchestrator, probe };
}

// Mock saveConfig so we don't hit the filesystem
vi.mock('../../config/loader.js', () => ({
  saveConfig: vi.fn(),
  loadConfig: vi.fn(),
}));

import { saveConfig } from '../../config/loader.js';
const mockSaveConfig = vi.mocked(saveConfig);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/transport', () => {
  afterEach(() => {
    resetConfigMutex();
  });

  it('returns direct mode with reachable=true, no socksProxy', async () => {
    const { app, deps } = buildDeps();
    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/transport' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('direct');
    expect(body.reachable).toBe(true);
    expect(body.socksProxy).toBeUndefined();
    expect(body.latencyProxyMs).toBeNull();
    expect(typeof body.ts).toBe('number');
  });

  it('returns hs mode with reachable=true and latencies when probe is healthy', async () => {
    const { app, deps, probe } = buildDeps();
    deps.config.transport = {
      mode: 'hs',
      socksProxy: 'socks5h://proxy.ator.io:9050',
    };
    probe.setMockStatus({
      reachable: true,
      latencyProxyMs: 120,
      latencyDirectMs: 10,
      lastProbedAt: Date.now(),
    });
    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/transport' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('hs');
    expect(body.reachable).toBe(true);
    expect(body.socksProxy).toBe('socks5h://proxy.ator.io:9050');
    expect(body.latencyProxyMs).toBe(120);
    expect(body.latencyDirectMs).toBe(10);
  });

  it('returns hs mode with reachable=false and probeError when proxy is down', async () => {
    const { app, deps, probe } = buildDeps();
    deps.config.transport = {
      mode: 'hs',
      socksProxy: 'socks5h://proxy.ator.io:9050',
    };
    probe.setMockStatus({
      reachable: false,
      latencyProxyMs: null,
      probeError: 'ECONNREFUSED',
      lastProbedAt: Date.now(),
    });
    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/transport' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('hs');
    expect(body.reachable).toBe(false);
    expect(body.probeError).toBe('ECONNREFUSED');
  });
});

describe('PATCH /api/transport', () => {
  beforeEach(() => {
    resetConfigMutex();
    mockSaveConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetConfigMutex();
    vi.clearAllMocks();
  });

  it('happy-path Direct→ATOR: regenerate called once, probe started', async () => {
    const { app, deps, orchestrator, probe } = buildDeps();
    // The validator (config/validator.ts:216-227) requires either
    // externalUrl or hiddenService when mode='hs', so the operator's
    // YAML must have set one of them up before flipping. We mirror the
    // post-`townhouse-hs-init.sh` operator state: hiddenService present in
    // direct mode and carried forward by the route on flip.
    deps.config.transport = {
      mode: 'direct',
      hiddenService: { dir: '/var/lib/townhouse/hs/connector', port: 3000 },
    };
    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transport',
      payload: { mode: 'hs' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('hs');
    expect(body.restartTriggered).toBe(true);
    expect(body.restartedAt).toBeTypeOf('number');

    // The route must preserve hiddenService across the flip — otherwise the
    // operator's keypair config would be silently stripped.
    expect(deps.config.transport.hiddenService).toEqual({
      dir: '/var/lib/townhouse/hs/connector',
      port: 3000,
    });

    expect(orchestrator.calls).toContain('regenerateConnectorConfig(town)');
    expect(probe.calls).toContain('start');
    expect(probe.calls.some((c) => c.startsWith('setProxyUrl'))).toBe(true);
  });

  it('happy-path ATOR→Direct: probe stopped, regenerate called', async () => {
    const { app, deps, orchestrator, probe } = buildDeps();
    deps.config.transport = {
      mode: 'hs',
      socksProxy: 'socks5h://proxy.ator.io:9050',
    };
    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transport',
      payload: { mode: 'direct' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('direct');
    expect(body.restartTriggered).toBe(true);

    expect(orchestrator.calls).toContain('regenerateConnectorConfig(town)');
    expect(probe.calls).toContain('stop');
  });

  it('no-op same-mode: regenerate NOT called', async () => {
    const { app, deps, orchestrator } = buildDeps();
    deps.config.transport = { mode: 'direct' };
    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transport',
      payload: { mode: 'direct' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().restartTriggered).toBe(false);
    expect(orchestrator.calls).toHaveLength(0);
  });

  it('mutex contention: 409 when another mutation is in flight', async () => {
    const { app, deps } = buildDeps();
    deps.config.transport = { mode: 'direct' };

    // Simulate mutex held by nodes-patch
    const { acquireConfigMutex } = await import('../config-mutex.js');
    acquireConfigMutex(); // grab the mutex

    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transport',
      payload: { mode: 'hs' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('config_mutation_in_flight');
  });

  it('rollback on regenerate failure: config restored, response 500', async () => {
    const { app, deps, orchestrator } = buildDeps();
    deps.config.transport = {
      mode: 'direct',
      hiddenService: { dir: '/var/lib/townhouse/hs/connector', port: 3000 },
    };
    orchestrator.shouldFail = true;
    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transport',
      payload: { mode: 'hs' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('connector_restart_failed');

    // Config should be rolled back to direct, and hiddenService retained.
    expect(deps.config.transport.mode).toBe('direct');
    expect(deps.config.transport.hiddenService).toEqual({
      dir: '/var/lib/townhouse/hs/connector',
      port: 3000,
    });
    // saveConfig called twice: once for the flip, once for the rollback
    expect(mockSaveConfig).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown keys (additionalProperties: false)', async () => {
    // Ajv is configured with removeAdditional: false (build-app.ts), so unknown
    // keys produce a 400 validation error rather than being silently stripped.
    const { app, deps } = buildDeps();
    deps.config.transport = {
      mode: 'hs',
      socksProxy: 'socks5h://proxy.ator.io:9050',
    };
    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transport',
      payload: { mode: 'direct', unknown: 'bad' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects bad socksProxy URL', async () => {
    const { app, deps } = buildDeps();
    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transport',
      payload: { mode: 'hs', socksProxy: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('invalid_socksProxy');
  });

  it('rejects socksProxy with wrong scheme', async () => {
    const { app, deps } = buildDeps();
    registerTransportRoutes(app, deps);
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transport',
      payload: { mode: 'hs', socksProxy: 'http://proxy.example.com:8080' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_socksProxy');
  });
});

describe('Wizard mode: GET /api/transport only', () => {
  it('GET works in wizard mode', async () => {
    const { app, deps } = buildDeps();
    registerTransportRoutes(app, deps, { mode: 'wizard' });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/transport' });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH is not registered in wizard mode (returns 404)', async () => {
    // Per AC-7: "PATCH /api/transport in wizard mode must respond 503
    // { error: 'wizard_in_progress' } or simply not be registered (pick
    // whichever is simpler — 404 is acceptable)." We chose "not registered"
    // because keeping a 503 stub forced a duplicate-route Fastify failure
    // when the wizard transitioned to normal mode and tried to add the real
    // PATCH on top. The wizard-to-normal transition now uses
    // `mode: 'patch-only'` to register PATCH without re-registering GET.
    const { app, deps } = buildDeps();
    registerTransportRoutes(app, deps, { mode: 'wizard' });
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/transport',
      payload: { mode: 'direct' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Backward compatibility: resetConfigMutex re-export from nodes-patch', () => {
  it('legacyResetConfigMutex is callable and resets the shared mutex', async () => {
    const { acquireConfigMutex } = await import('../config-mutex.js');
    acquireConfigMutex(); // grab
    legacyResetConfigMutex(); // should release via re-export
    const acquired = acquireConfigMutex();
    expect(acquired).toBe(true);
    resetConfigMutex(); // cleanup
  });
});
