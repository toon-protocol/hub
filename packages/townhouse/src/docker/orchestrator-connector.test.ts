/**
 * Unit Tests: DockerOrchestrator connector integration methods (Story 21.3)
 *
 * Test IDs map to test-design-epic-21.md scenario T-018.
 * Tests moved from TDD Red Phase to Green Phase — all tests now active.
 *
 * These tests verify:
 * - AC #2: Connector started first, health-checked before nodes (config generation)
 * - AC #3: When nodes start/stop, connector config regenerated and connector restarted
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DockerOrchestrator } from './orchestrator.js';
import type { TownhouseConfig } from '../config/schema.js';
import { getDefaultConfig } from '../config/defaults.js';

/**
 * Build a TownhouseConfig with selected nodes enabled.
 */
function configWithNodes(
  enabled: ('town' | 'mill' | 'dvm')[]
): TownhouseConfig {
  const config = getDefaultConfig();
  for (const node of enabled) {
    config.nodes[node].enabled = true;
  }
  return config;
}

/**
 * Factory: creates a mock dockerode instance with all methods needed.
 */
function createMockDocker() {
  const mockContainer = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      State: { Health: { Status: 'healthy' }, Running: true },
    }),
  };

  const mockNetwork = {
    remove: vi.fn().mockResolvedValue(undefined),
  };

  const docker = {
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    listContainers: vi.fn().mockResolvedValue([]),
    createNetwork: vi.fn().mockResolvedValue(mockNetwork),
    listNetworks: vi.fn().mockResolvedValue([]),
    getNetwork: vi.fn().mockReturnValue(mockNetwork),
    pull: vi.fn().mockImplementation(() => {
      return Promise.resolve({ pipe: vi.fn() });
    }),
    listImages: vi.fn().mockResolvedValue([]),
    modem: {
      followProgress: vi
        .fn()
        .mockImplementation(
          (
            _stream: unknown,
            onFinished: (err: Error | null) => void,
            _onProgress: (event: Record<string, unknown>) => void
          ) => {
            onFinished(null);
          }
        ),
    },
  };

  return { docker, mockContainer, mockNetwork };
}

describe('DockerOrchestrator — Connector Integration (Story 21.3)', () => {
  let mockDocker: ReturnType<typeof createMockDocker>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDocker = createMockDocker();
  });

  // ── T-016: Connector env vars include all active nodes as peers after up() ──

  describe('up() — connector env vars include CONNECTOR_PEERS (T-016)', () => {
    it('passes CONNECTOR_PEERS env var with town peer when starting with town', async () => {
      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-connector',
          Env: expect.arrayContaining([
            expect.stringMatching(/^CONNECTOR_PEERS=.*town/),
          ]),
        })
      );
    });

    it('passes CONNECTOR_PEERS with multiple peers when starting town+mill', async () => {
      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town', 'mill']);

      const createCalls = mockDocker.docker.createContainer.mock.calls;
      const connectorCall = createCalls.find(
        (c: any[]) => c[0].name === 'townhouse-connector'
      );
      const envArray: string[] = connectorCall![0].Env;
      const peersEnv = envArray.find((e: string) =>
        e.startsWith('CONNECTOR_PEERS=')
      );
      const peers = JSON.parse(peersEnv!.replace('CONNECTOR_PEERS=', ''));
      expect(peers).toHaveLength(2);
      expect(peers.map((p: any) => p.id)).toEqual(
        expect.arrayContaining(['town', 'mill'])
      );
    });

    it('passes CONNECTOR_ILP_ADDRESS env var to connector', async () => {
      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-connector',
          Env: expect.arrayContaining(['CONNECTOR_ILP_ADDRESS=g.townhouse']),
        })
      );
    });

    it('binds admin port to 127.0.0.1 only (not 0.0.0.0)', async () => {
      const config = configWithNodes(['town']);
      config.connector.adminPort = 9401;
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-connector',
          HostConfig: expect.objectContaining({
            PortBindings: {
              '9401/tcp': [{ HostIp: '127.0.0.1', HostPort: '9401' }],
            },
          }),
        })
      );
    });
  });

  // ── T-018: Node start triggers connector config regeneration and restart ──

  describe('regenerateConnectorConfig() (T-018)', () => {
    it('stops existing connector container', async () => {
      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await orchestrator.regenerateConnectorConfig(['town', 'mill']);

      expect(mockDocker.mockContainer.stop).toHaveBeenCalledWith({ t: 5 });
    });

    it('removes stopped connector container before creating new one', async () => {
      const callOrder: string[] = [];
      const container = {
        start: vi.fn().mockImplementation(async () => callOrder.push('start')),
        stop: vi.fn().mockImplementation(async () => callOrder.push('stop')),
        remove: vi
          .fn()
          .mockImplementation(async () => callOrder.push('remove')),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      };

      mockDocker.docker.createContainer.mockResolvedValue(container);
      mockDocker.docker.getContainer.mockReturnValue(container);

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await orchestrator.regenerateConnectorConfig(['town', 'mill']);

      // Expect stop -> remove -> start sequence
      expect(callOrder).toEqual(['stop', 'remove', 'start']);
    });

    it('creates new connector container with updated env vars', async () => {
      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await orchestrator.regenerateConnectorConfig(['town', 'mill']);

      const createCalls = mockDocker.docker.createContainer.mock.calls;
      const lastConnectorCall = createCalls
        .filter((c: any[]) => c[0].name === 'townhouse-connector')
        .pop();
      const envArray: string[] = lastConnectorCall![0].Env;
      const peersEnv = envArray.find((e: string) =>
        e.startsWith('CONNECTOR_PEERS=')
      );
      const peers = JSON.parse(peersEnv!.replace('CONNECTOR_PEERS=', ''));
      expect(peers).toHaveLength(2);
    });

    it('waits for health check after restarting connector', async () => {
      let inspectCount = 0;
      const container = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockImplementation(async () => {
          inspectCount++;
          if (inspectCount < 3) {
            return { State: { Health: { Status: 'starting' }, Running: true } };
          }
          return { State: { Health: { Status: 'healthy' }, Running: true } };
        }),
      };

      mockDocker.docker.createContainer.mockResolvedValue(container);
      mockDocker.docker.getContainer.mockReturnValue(container);

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await orchestrator.regenerateConnectorConfig(['town']);

      expect(container.inspect.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('addNode() (T-018)', () => {
    it('starts a new node container and regenerates connector config', async () => {
      const createdContainers: string[] = [];
      mockDocker.docker.createContainer.mockImplementation(
        async (opts: { name: string }) => {
          createdContainers.push(opts.name);
          return {
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            remove: vi.fn().mockResolvedValue(undefined),
            inspect: vi.fn().mockResolvedValue({
              State: { Health: { Status: 'healthy' }, Running: true },
            }),
          };
        }
      );

      mockDocker.docker.getContainer.mockReturnValue({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      });

      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await orchestrator.addNode('mill');

      expect(createdContainers).toContain('townhouse-mill');
      expect(createdContainers).toContain('townhouse-connector');
    });

    it('includes the new node in the regenerated connector peer list', async () => {
      mockDocker.docker.createContainer.mockImplementation(
        async (_opts: { name: string }) => ({
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
          inspect: vi.fn().mockResolvedValue({
            State: { Health: { Status: 'healthy' }, Running: true },
          }),
        })
      );

      mockDocker.docker.getContainer.mockReturnValue({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      });

      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await orchestrator.addNode('mill');

      const createCalls = mockDocker.docker.createContainer.mock.calls;
      const lastConnectorCall = createCalls
        .filter((c: any[]) => c[0].name === 'townhouse-connector')
        .pop();
      const envArray: string[] = lastConnectorCall![0].Env;
      const peersEnv = envArray.find((e: string) =>
        e.startsWith('CONNECTOR_PEERS=')
      );
      const peers = JSON.parse(peersEnv!.replace('CONNECTOR_PEERS=', ''));
      expect(peers.map((p: any) => p.id)).toContain('mill');
    });
  });

  describe('removeNode() (T-018)', () => {
    it('stops the specified node container', async () => {
      const stoppedNames: string[] = [];
      mockDocker.docker.getContainer.mockImplementation((name: string) => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockImplementation(async () => {
          stoppedNames.push(name);
        }),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      }));

      mockDocker.docker.createContainer.mockResolvedValue({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      });

      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      // Simulate initial up with both nodes
      await orchestrator.up(['town', 'mill']);
      stoppedNames.length = 0; // Reset after up

      await orchestrator.removeNode('mill');

      expect(stoppedNames).toContain('townhouse-mill');
    });

    it('regenerates connector config without the removed node', async () => {
      mockDocker.docker.getContainer.mockImplementation(() => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      }));

      mockDocker.docker.createContainer.mockImplementation(
        async (_opts: { name: string }) => ({
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
          inspect: vi.fn().mockResolvedValue({
            State: { Health: { Status: 'healthy' }, Running: true },
          }),
        })
      );

      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await orchestrator.up(['town', 'mill']);
      await orchestrator.removeNode('mill');

      const createCalls = mockDocker.docker.createContainer.mock.calls;
      const lastConnectorCall = createCalls
        .filter((c: any[]) => c[0].name === 'townhouse-connector')
        .pop();
      const envArray: string[] = lastConnectorCall![0].Env;
      const peersEnv = envArray.find((e: string) =>
        e.startsWith('CONNECTOR_PEERS=')
      );
      const peers = JSON.parse(peersEnv!.replace('CONNECTOR_PEERS=', ''));
      expect(peers).toHaveLength(1);
      expect(peers[0].id).toBe('town');
    });
  });

  // ── Error handling ──

  describe('regenerateConnectorConfig() — error handling', () => {
    it('proceeds gracefully when connector container does not exist yet', async () => {
      // Simulate getContainer throwing (container not found)
      mockDocker.docker.getContainer.mockReturnValue({
        stop: vi.fn().mockRejectedValue(new Error('No such container')),
        remove: vi.fn().mockRejectedValue(new Error('No such container')),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      });

      mockDocker.docker.createContainer.mockResolvedValue({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      });

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      // Should not throw — proceeds to create new connector
      await expect(
        orchestrator.regenerateConnectorConfig(['town'])
      ).resolves.toBeUndefined();

      // Connector should still be created
      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'townhouse-connector' })
      );
    });

    it('propagates error when connector creation fails', async () => {
      mockDocker.docker.getContainer.mockReturnValue({
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      });

      mockDocker.docker.createContainer.mockRejectedValue(
        new Error('Docker daemon error: insufficient resources')
      );

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await expect(
        orchestrator.regenerateConnectorConfig(['town'])
      ).rejects.toThrow(/insufficient resources/);
    });
  });

  // ── Connector restart events ──

  describe('connector restart events (AC #3)', () => {
    it('emits connectorRestarting event before restart', async () => {
      const events: string[] = [];
      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      orchestrator.on('connectorRestarting', () => events.push('restarting'));
      orchestrator.on('connectorRestarted', () => events.push('restarted'));

      await orchestrator.regenerateConnectorConfig(['town', 'mill']);

      expect(events).toContain('restarting');
    });

    it('emits connectorRestarted event after health check passes', async () => {
      const events: string[] = [];
      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      orchestrator.on('connectorRestarting', () => events.push('restarting'));
      orchestrator.on('connectorRestarted', () => events.push('restarted'));

      await orchestrator.regenerateConnectorConfig(['town']);

      expect(events).toContain('restarted');
      expect(events.indexOf('restarting')).toBeLessThan(
        events.indexOf('restarted')
      );
    });
  });
});
