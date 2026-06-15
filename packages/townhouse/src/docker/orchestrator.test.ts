/**
 * Unit tests for Story 21.2: Docker Orchestration Engine
 *
 * Test IDs map to test-design-epic-21.md scenarios T-007 through T-015.
 * All tests use mocked dockerode — no real Docker containers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DockerOrchestrator } from './orchestrator.js';
import type { TownhouseConfig } from '../config/schema.js';
import { getDefaultConfig } from '../config/defaults.js';
import { DEFAULT_CONNECTOR_IMAGE } from '../constants.js';

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
 * Factory: creates a mock dockerode instance with all methods needed
 * by the DockerOrchestrator. Each method is a vi.fn() stub.
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
    // Container operations
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    listContainers: vi.fn().mockResolvedValue([]),

    // Network operations
    createNetwork: vi.fn().mockResolvedValue(mockNetwork),
    listNetworks: vi.fn().mockResolvedValue([]),
    getNetwork: vi.fn().mockReturnValue(mockNetwork),

    // Image operations
    pull: vi.fn().mockImplementation((_image: string) => {
      // Return a mock stream
      return Promise.resolve({ pipe: vi.fn() });
    }),
    listImages: vi.fn().mockResolvedValue([]),

    // Modem for followProgress
    modem: {
      followProgress: vi
        .fn()
        .mockImplementation(
          (
            _stream: unknown,
            onFinished: (err: Error | null) => void,
            _onProgress: (event: Record<string, unknown>) => void
          ) => {
            // Simulate immediate completion
            onFinished(null);
          }
        ),
    },
  };

  return { docker, mockContainer, mockNetwork };
}

describe('DockerOrchestrator', () => {
  let mockDocker: ReturnType<typeof createMockDocker>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDocker = createMockDocker();
  });

  // ── T-007: townhouse up --town --mill starts connector + Town + Mill ──

  describe('up() — profile-based startup (T-007)', () => {
    it('starts connector + Town + Mill when profiles are [town, mill]', async () => {
      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town', 'mill']);

      // Connector container must be created
      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-connector',
        })
      );

      // Town container must be created
      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-town',
        })
      );

      // Mill container must be created
      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-mill',
        })
      );

      // DVM must NOT be created
      expect(mockDocker.docker.createContainer).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-dvm',
        })
      );
    });

    it('creates 3 containers total (connector + 2 nodes) for town+mill', async () => {
      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town', 'mill']);

      // Expect exactly 3 createContainer calls: connector, town, mill
      expect(mockDocker.docker.createContainer).toHaveBeenCalledTimes(3);
    });
  });

  // ── T-008: Connector health check before node start ──

  describe('up() — connector health gating (T-008)', () => {
    it('waits for connector health before starting node containers', async () => {
      const startOrder: string[] = [];

      mockDocker.docker.createContainer.mockImplementation(
        async (opts: { name: string }) => {
          const container = {
            start: vi.fn().mockImplementation(async () => {
              startOrder.push(opts.name);
            }),
            stop: vi.fn().mockResolvedValue(undefined),
            remove: vi.fn().mockResolvedValue(undefined),
            inspect: vi.fn().mockResolvedValue({
              State: { Health: { Status: 'healthy' }, Running: true },
            }),
          };
          return container;
        }
      );

      // Mock getContainer to return a container with healthy inspect
      mockDocker.docker.getContainer.mockReturnValue({
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
      await orchestrator.up(['town']);

      // Connector must start before town
      expect(startOrder.indexOf('townhouse-connector')).toBeLessThan(
        startOrder.indexOf('townhouse-town')
      );
    });

    it('polls container health via inspect() with retry', async () => {
      // Simulate unhealthy -> unhealthy -> healthy
      let inspectCallCount = 0;
      const container = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockImplementation(async () => {
          inspectCallCount++;
          if (inspectCallCount < 3) {
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
      // Use short interval to speed up test
      await orchestrator.up(['town']);

      // inspect() should be called multiple times (polling)
      expect(container.inspect.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── T-009: down() stops containers in reverse order ──

  describe('down() — graceful shutdown (T-009)', () => {
    it('stops node containers before connector', async () => {
      const stopOrder: string[] = [];

      const makeContainer = (name: string) => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockImplementation(async () => {
          stopOrder.push(name);
        }),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      });

      // Simulate running containers
      mockDocker.docker.listContainers.mockResolvedValue([
        { Names: ['/townhouse-connector'], State: 'running' },
        { Names: ['/townhouse-town'], State: 'running' },
        { Names: ['/townhouse-mill'], State: 'running' },
      ]);

      mockDocker.docker.getContainer.mockImplementation((name: string) => {
        return makeContainer(name);
      });

      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.down();

      // Nodes stop before connector
      const connectorIdx = stopOrder.indexOf('townhouse-connector');
      const townIdx = stopOrder.indexOf('townhouse-town');
      const millIdx = stopOrder.indexOf('townhouse-mill');

      expect(townIdx).toBeLessThan(connectorIdx);
      expect(millIdx).toBeLessThan(connectorIdx);
    });

    it('calls container.stop() with 10s graceful timeout', async () => {
      const mockContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      };

      mockDocker.docker.listContainers.mockResolvedValue([
        { Names: ['/townhouse-connector'], State: 'running' },
      ]);
      mockDocker.docker.getContainer.mockReturnValue(mockContainer);

      const config = configWithNodes([]);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.down();

      expect(mockContainer.stop).toHaveBeenCalledWith({ t: 10 });
    });

    it('removes containers after stopping them', async () => {
      const callOrder: string[] = [];
      const mockContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockImplementation(async () => {
          callOrder.push('stop');
        }),
        remove: vi.fn().mockImplementation(async () => {
          callOrder.push('remove');
        }),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      };

      mockDocker.docker.listContainers.mockResolvedValue([
        { Names: ['/townhouse-connector'], State: 'running' },
      ]);
      mockDocker.docker.getContainer.mockReturnValue(mockContainer);

      const config = configWithNodes([]);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.down();

      expect(callOrder).toEqual(['stop', 'remove']);
    });

    it('removes townhouse-net network after stopping all containers', async () => {
      mockDocker.docker.listContainers.mockResolvedValue([]);
      mockDocker.docker.listNetworks.mockResolvedValue([
        { Name: 'townhouse-net', Id: 'net-123' },
      ]);

      const config = configWithNodes([]);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.down();

      expect(mockDocker.mockNetwork.remove).toHaveBeenCalled();
    });
  });

  // ── down() edge cases ──

  describe('down() — edge cases', () => {
    it('handles already-stopped containers gracefully (no throw)', async () => {
      mockDocker.docker.listContainers.mockResolvedValue([
        { Names: ['/townhouse-connector'], State: 'exited' },
      ]);

      // Simulate container.stop() throwing because container already stopped
      mockDocker.docker.getContainer.mockReturnValue({
        stop: vi.fn().mockRejectedValue(new Error('container already stopped')),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'unhealthy' }, Running: false },
        }),
      });

      const config = configWithNodes([]);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      // Should not throw — stopAndRemove catches errors
      await expect(orchestrator.down()).resolves.toBeUndefined();
    });

    it('handles missing network during down() gracefully', async () => {
      mockDocker.docker.listContainers.mockResolvedValue([]);
      // No networks exist
      mockDocker.docker.listNetworks.mockResolvedValue([]);

      const config = configWithNodes([]);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      // Should not throw
      await expect(orchestrator.down()).resolves.toBeUndefined();
      expect(mockDocker.mockNetwork.remove).not.toHaveBeenCalled();
    });
  });

  // ── up() with empty profiles ──

  describe('up() — empty profiles', () => {
    it('starts only the connector when profiles array is empty', async () => {
      const config = configWithNodes([]);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up([]);

      // Only connector container created (no node containers)
      expect(mockDocker.docker.createContainer).toHaveBeenCalledTimes(1);
      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-connector',
        })
      );
    });
  });

  // ── T-010: All profile combinations always include connector ──

  describe('up() — profile combinations always include connector (T-010)', () => {
    const profileCombinations: ('town' | 'mill' | 'dvm')[][] = [
      ['town'],
      ['mill'],
      ['dvm'],
      ['town', 'mill'],
      ['town', 'dvm'],
      ['mill', 'dvm'],
      ['town', 'mill', 'dvm'],
    ];

    for (const profiles of profileCombinations) {
      it(`profiles [${profiles.join(', ')}] always starts connector`, async () => {
        const config = configWithNodes(profiles);
        const orchestrator = new DockerOrchestrator(
          mockDocker.docker as any,
          config
        );
        await orchestrator.up(profiles);

        expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'townhouse-connector',
          })
        );
      });
    }
  });

  // ── T-011: Image pull progress reporting ──

  describe('pullImages() — progress reporting (T-011)', () => {
    it('pulls required images before starting containers', async () => {
      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.pullImages(['town']);

      // Should pull normalized connector image + town image
      // normalizeImageTag ensures explicit :latest tag when already present
      expect(mockDocker.docker.pull).toHaveBeenCalledWith(
        DEFAULT_CONNECTOR_IMAGE
      );
      expect(mockDocker.docker.pull).toHaveBeenCalledWith('toon:town');
      expect(mockDocker.docker.pull).toHaveBeenCalledTimes(2);
    });

    it('emits progress events during image pull', async () => {
      const progressEvents: Record<string, unknown>[] = [];

      mockDocker.docker.modem.followProgress.mockImplementation(
        (
          _stream: unknown,
          onFinished: (err: Error | null) => void,
          onProgress: (event: Record<string, unknown>) => void
        ) => {
          // Simulate progress events
          onProgress({ status: 'Downloading', id: 'layer1', progress: '50%' });
          onProgress({ status: 'Extracting', id: 'layer1', progress: '100%' });
          onProgress({ status: 'Pull complete', id: 'layer1' });
          onFinished(null);
        }
      );

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      orchestrator.on('pullProgress', (event: Record<string, unknown>) =>
        progressEvents.push(event)
      );
      await orchestrator.pullImages(['town']);

      expect(progressEvents.length).toBeGreaterThanOrEqual(3);
      // Verify event structure includes required fields
      expect(progressEvents[0]).toEqual(
        expect.objectContaining({
          image: expect.any(String),
          status: 'Downloading',
        })
      );
      expect(progressEvents[2]).toEqual(
        expect.objectContaining({
          status: 'Pull complete',
        })
      );
    });

    it('skips pull if image already exists locally', async () => {
      mockDocker.docker.listImages.mockResolvedValue([
        { RepoTags: [DEFAULT_CONNECTOR_IMAGE] },
        { RepoTags: ['toon:town'] },
      ]);

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.pullImages(['town']);

      // Should NOT pull any images since they all exist
      expect(mockDocker.docker.pull).not.toHaveBeenCalled();
    });
  });

  // ── T-012: Container restart limit ──

  describe('up() — container restart limit (T-012)', () => {
    it('stops retrying after N failed start attempts', async () => {
      let startCallCount = 0;
      const failingContainer = {
        start: vi.fn().mockImplementation(async () => {
          startCallCount++;
          throw new Error('container exited');
        }),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'unhealthy' }, Running: false },
        }),
      };

      // First call creates connector (succeeds), subsequent calls create
      // failing node containers
      mockDocker.docker.createContainer.mockImplementation(
        async (opts: { name: string }) => {
          if (opts.name === 'townhouse-connector') {
            return {
              start: vi.fn().mockResolvedValue(undefined),
              stop: vi.fn().mockResolvedValue(undefined),
              remove: vi.fn().mockResolvedValue(undefined),
              inspect: vi.fn().mockResolvedValue({
                State: { Health: { Status: 'healthy' }, Running: true },
              }),
            };
          }
          return failingContainer;
        }
      );

      // getContainer for health check and cleanup
      mockDocker.docker.getContainer.mockReturnValue({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockImplementation(async () => {}),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      });

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      // Should throw after max retries
      await expect(orchestrator.up(['town'])).rejects.toThrow(/restart/i);

      // Should not retry indefinitely (max 3 retries)
      expect(startCallCount).toBeLessThanOrEqual(3);
    });
  });

  // ── T-013: SIGINT graceful shutdown ──
  // Note: SIGINT handler is tested in cli.test.ts (Task 5.7)

  // ── T-014: Docker daemon unavailable ──

  describe('up() — Docker daemon unavailable (T-014)', () => {
    it('throws clear error when Docker daemon is not running', async () => {
      mockDocker.docker.listNetworks.mockRejectedValue(
        new Error('connect ENOENT /var/run/docker.sock')
      );

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await expect(orchestrator.up(['town'])).rejects.toThrow(
        /docker.*(not running|unavailable|not available)/i
      );
    });
  });

  // ── T-015: Health check configurable polling ──

  describe('healthCheck() — configurable polling (T-015)', () => {
    it('respects custom polling interval', async () => {
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

      mockDocker.docker.getContainer.mockReturnValue(container);

      const config = configWithNodes([]);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      // Health check with short interval and generous timeout
      const result = await orchestrator.healthCheck('townhouse-connector', {
        interval: 10,
        timeout: 10000,
      });

      expect(result).toBe('healthy');
      expect(container.inspect).toHaveBeenCalled();
      expect(inspectCount).toBeGreaterThanOrEqual(3);
    });

    it('times out when container never becomes healthy', async () => {
      const container = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'starting' }, Running: true },
        }),
      };

      mockDocker.docker.getContainer.mockReturnValue(container);

      const config = configWithNodes([]);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      // Should throw timeout error with very short timeout
      await expect(
        orchestrator.healthCheck('townhouse-connector', {
          interval: 10,
          timeout: 50,
        })
      ).rejects.toThrow(/timeout/i);
    });
  });

  // ── Network management ──

  describe('ensureNetwork() — Docker network (AC #1)', () => {
    it('creates townhouse-net bridge network if it does not exist', async () => {
      mockDocker.docker.listNetworks.mockResolvedValue([]);

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      expect(mockDocker.docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Name: 'townhouse-net',
          Driver: 'bridge',
        })
      );
    });

    it('skips network creation if townhouse-net already exists', async () => {
      mockDocker.docker.listNetworks.mockResolvedValue([
        { Name: 'townhouse-net', Id: 'existing-net' },
      ]);

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      expect(mockDocker.docker.createNetwork).not.toHaveBeenCalled();
    });
  });

  // ── Container environment variables ──

  describe('container environment variables (AC #1)', () => {
    it('passes connector env vars from config', async () => {
      const config = configWithNodes(['town']);
      config.connector.adminPort = 9401;
      config.transport.mode = 'direct';

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-connector',
          Env: expect.arrayContaining([
            'CONNECTOR_ADMIN_PORT=9401',
            'TRANSPORT_MODE=direct',
          ]),
        })
      );
    });

    it('passes town-specific env vars from config', async () => {
      const config = configWithNodes(['town']);
      config.nodes.town.feePerEvent = 1000;

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-town',
          Env: expect.arrayContaining([
            'FEE_PER_EVENT=1000',
            'CONNECTOR_URL=ws://townhouse-connector:3000',
          ]),
        })
      );
    });

    it('passes mill-specific env vars from config', async () => {
      const config = configWithNodes(['mill']);
      config.nodes.mill.feeBasisPoints = 50;

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['mill']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-mill',
          Env: expect.arrayContaining([
            'FEE_BASIS_POINTS=50',
            'CONNECTOR_URL=ws://townhouse-connector:3000',
          ]),
        })
      );
    });

    it('passes dvm-specific env vars from config', async () => {
      const config = configWithNodes(['dvm']);
      config.nodes.dvm.feePerJob = 5000;

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['dvm']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-dvm',
          Env: expect.arrayContaining([
            'FEE_PER_JOB=5000',
            'CONNECTOR_URL=ws://townhouse-connector:3000',
          ]),
        })
      );
    });

    it('emits KIND_PRICING_<kind> env vars when kindPricing is set', async () => {
      const config = configWithNodes(['dvm']);
      config.nodes.dvm.kindPricing = { '5094': 5, '5250': 10000 };

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['dvm']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-dvm',
          Env: expect.arrayContaining([
            'KIND_PRICING_5094=5',
            'KIND_PRICING_5250=10000',
            'CONNECTOR_URL=ws://townhouse-connector:3000',
          ]),
        })
      );
    });

    it('emits both FEE_PER_JOB and KIND_PRICING_<kind> when both are set', async () => {
      const config = configWithNodes(['dvm']);
      config.nodes.dvm.feePerJob = 1000;
      config.nodes.dvm.kindPricing = { '5094': 5 };

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['dvm']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-dvm',
          Env: expect.arrayContaining([
            'FEE_PER_JOB=1000',
            'KIND_PRICING_5094=5',
          ]),
        })
      );
    });

    it('passes TURBO_TOKEN from host env to dvm container', async () => {
      const original = process.env['TURBO_TOKEN'];
      process.env['TURBO_TOKEN'] = 'test-jwk-json';
      try {
        const config = configWithNodes(['dvm']);
        const orchestrator = new DockerOrchestrator(
          mockDocker.docker as any,
          config
        );
        await orchestrator.up(['dvm']);

        expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'townhouse-dvm',
            Env: expect.arrayContaining(['TURBO_TOKEN=test-jwk-json']),
          })
        );
      } finally {
        if (original === undefined) {
          delete process.env['TURBO_TOKEN'];
        } else {
          process.env['TURBO_TOKEN'] = original;
        }
      }
    });

    it('omits TURBO_TOKEN env when host env is unset', async () => {
      const original = process.env['TURBO_TOKEN'];
      delete process.env['TURBO_TOKEN'];
      try {
        const config = configWithNodes(['dvm']);
        const orchestrator = new DockerOrchestrator(
          mockDocker.docker as any,
          config
        );
        await orchestrator.up(['dvm']);

        const dvmCall = mockDocker.docker.createContainer.mock.calls.find(
          (c: any[]) => c[0]?.name === 'townhouse-dvm'
        );
        expect(dvmCall).toBeDefined();
        const env: string[] = dvmCall?.[0]?.Env ?? [];
        expect(env.some((e) => e.startsWith('TURBO_TOKEN='))).toBe(false);
      } finally {
        if (original !== undefined) {
          process.env['TURBO_TOKEN'] = original;
        }
      }
    });

    it('does NOT create relay ator sidecar when relayHiddenService is unset', async () => {
      const config = configWithNodes(['town']);
      // transport.relayHiddenService intentionally undefined

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      expect(mockDocker.docker.createContainer).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-ator-sidecar-relay',
        })
      );
    });

    it('does NOT include TOON_EXTERNAL_RELAY_URL env on town when relayHiddenService is unset', async () => {
      const config = configWithNodes(['town']);

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      const townCall = mockDocker.docker.createContainer.mock.calls.find(
        (c: any[]) => c[0]?.name === 'townhouse-town'
      );
      expect(townCall).toBeDefined();
      const townEnv: string[] = townCall?.[0]?.Env ?? [];
      expect(
        townEnv.some((e) => e.startsWith('TOON_EXTERNAL_RELAY_URL='))
      ).toBe(false);
    });

    it('ensureRelaySidecar() creates the relay sidecar with HS-correct env/network/volume', async () => {
      const config = configWithNodes(['town']);
      // No existing sidecar — idempotency check must miss so it creates one.
      mockDocker.docker.getContainer.mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error('No such container')),
        remove: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
      });

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config,
        undefined,
        { profile: 'hs', composePath: '/tmp/fake-hs.yml' }
      );
      await orchestrator.ensureRelaySidecar();

      // Uses the HS compose's REAL network + town container name (the legacy
      // path used townhouse-net / townhouse-town and never resolved), and a
      // named keypair volume for a stable .anyone address.
      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-hs-ator-sidecar-relay',
          Image: 'toon:townhouse-ator-sidecar',
          Env: expect.arrayContaining([
            'HS_TARGET_HOST=townhouse-hs-town',
            'HS_TARGET_PORT=7100',
            'HS_PORT=7100',
            'SOCKS_PORT=9051',
          ]),
          HostConfig: expect.objectContaining({
            NetworkMode: 'townhouse-hs-net',
            Binds: expect.arrayContaining([
              'townhouse-hs-relay-anon:/var/lib/anon/hs:rw',
            ]),
          }),
        })
      );
    });

    it('ensureRelaySidecar() is idempotent — skips creation when already running', async () => {
      const config = configWithNodes(['town']);
      // Default getContainer returns a Running container → should skip create.
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config,
        undefined,
        { profile: 'hs', composePath: '/tmp/fake-hs.yml' }
      );
      await orchestrator.ensureRelaySidecar();
      expect(mockDocker.docker.createContainer).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'townhouse-hs-ator-sidecar-relay' })
      );
    });

    it('passes TOON_EXTERNAL_RELAY_URL to town when relayHiddenService.externalUrl is set', async () => {
      const config = configWithNodes(['town']);
      config.transport.relayHiddenService = {
        dir: '/var/lib/townhouse/hs/relay',
        port: 7100,
        externalUrl: 'wss://abc123.anyone',
      };

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-town',
          Env: expect.arrayContaining([
            'TOON_EXTERNAL_RELAY_URL=wss://abc123.anyone',
          ]),
        })
      );
    });

    it('does NOT create relay sidecar when town profile is absent (mill-only)', async () => {
      const config = configWithNodes(['mill']);
      config.transport.relayHiddenService = {
        dir: '/var/lib/townhouse/hs/relay',
        port: 7100,
        externalUrl: 'wss://abc123.anyone',
      };

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['mill']);

      expect(mockDocker.docker.createContainer).not.toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-ator-sidecar-relay',
        })
      );
    });

    it('down() stops the relay ator sidecar alongside other townhouse containers', async () => {
      const stopped: string[] = [];

      mockDocker.docker.listContainers.mockResolvedValue([
        { Names: ['/townhouse-connector'], State: 'running' },
        { Names: ['/townhouse-town'], State: 'running' },
        { Names: ['/townhouse-ator-sidecar-relay'], State: 'running' },
      ]);
      mockDocker.docker.getContainer.mockImplementation((name: string) => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockImplementation(async () => {
          stopped.push(name);
        }),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      }));

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.down();

      expect(stopped).toContain('townhouse-ator-sidecar-relay');
      // sidecar is stopped before the connector (parallel "node" group)
      expect(stopped.indexOf('townhouse-ator-sidecar-relay')).toBeLessThan(
        stopped.indexOf('townhouse-connector')
      );
    });

    it('includes SOCKS_PROXY env when transport mode is hs', async () => {
      const config = configWithNodes(['town']);
      config.transport.mode = 'hs';
      config.transport.socksProxy = 'socks5h://proxy.ator.io:9050';

      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-connector',
          Env: expect.arrayContaining([
            'SOCKS_PROXY=socks5h://proxy.ator.io:9050',
          ]),
        })
      );
    });
  });

  // ── status() ──

  describe('status() (AC #6)', () => {
    it('returns health state for each running container', async () => {
      mockDocker.docker.listContainers.mockResolvedValue([
        { Names: ['/townhouse-connector'], State: 'running' },
        { Names: ['/townhouse-town'], State: 'running' },
      ]);

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      const statuses = await orchestrator.status();

      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'connector',
            state: 'running',
            health: 'healthy',
          }),
          expect.objectContaining({
            name: 'town',
            state: 'running',
            health: 'healthy',
          }),
        ])
      );
    });

    it('returns stopped for containers not running', async () => {
      mockDocker.docker.listContainers.mockResolvedValue([]);

      const config = configWithNodes([]);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      const statuses = await orchestrator.status();

      for (const s of statuses) {
        expect(s.state).toBe('stopped');
      }
    });
  });

  // ── Story 21.3: regenerateConnectorConfig, addNode, removeNode ──

  describe('regenerateConnectorConfig() (T-018)', () => {
    it('stops, removes, and restarts connector with updated env vars', async () => {
      const callOrder: string[] = [];

      const connectorContainer = {
        start: vi.fn().mockImplementation(async () => {
          callOrder.push('start');
        }),
        stop: vi.fn().mockImplementation(async () => {
          callOrder.push('stop');
        }),
        remove: vi.fn().mockImplementation(async () => {
          callOrder.push('remove');
        }),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      };

      mockDocker.docker.getContainer.mockReturnValue(connectorContainer);
      mockDocker.docker.createContainer.mockResolvedValue(connectorContainer);

      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await orchestrator.regenerateConnectorConfig(['town', 'mill']);

      expect(callOrder).toEqual(['stop', 'remove', 'start']);
    });

    it('emits connectorRestarting and connectorRestarted events', async () => {
      const events: string[] = [];

      mockDocker.docker.createContainer.mockResolvedValue(
        mockDocker.mockContainer
      );

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      orchestrator.on('connectorRestarting', () => events.push('restarting'));
      orchestrator.on('connectorRestarted', () => events.push('restarted'));

      await orchestrator.regenerateConnectorConfig(['town']);

      expect(events).toEqual(['restarting', 'restarted']);
    });

    it('includes CONNECTOR_PEERS in env vars after regeneration', async () => {
      mockDocker.docker.createContainer.mockResolvedValue(
        mockDocker.mockContainer
      );

      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );

      await orchestrator.regenerateConnectorConfig(['town', 'mill']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-connector',
          Env: expect.arrayContaining([
            expect.stringMatching(/^CONNECTOR_PEERS=.*town.*mill/),
          ]),
        })
      );
    });
  });

  describe('addNode() (T-018)', () => {
    it('starts new node and regenerates connector config', async () => {
      const callOrder: string[] = [];

      mockDocker.docker.createContainer.mockImplementation(
        async (opts: { name: string }) => {
          callOrder.push(`create:${opts.name}`);
          return {
            start: vi.fn().mockImplementation(async () => {
              callOrder.push(`start:${opts.name}`);
            }),
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

      // Should create mill container and then restart connector
      expect(callOrder).toContain('create:townhouse-mill');
      expect(callOrder).toContain('create:townhouse-connector');
    });
  });

  describe('removeNode() (T-018)', () => {
    it('stops node and regenerates connector config without it', async () => {
      const stoppedContainers: string[] = [];

      mockDocker.docker.getContainer.mockImplementation((name: string) => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockImplementation(async () => {
          stoppedContainers.push(name);
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

      // Simulate initial state with both nodes active
      await orchestrator.up(['town', 'mill']);
      vi.clearAllMocks();

      // Reset mocks for removeNode
      mockDocker.docker.getContainer.mockImplementation((name: string) => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockImplementation(async () => {
          stoppedContainers.push(name);
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

      await orchestrator.removeNode('mill');

      // Mill should have been stopped
      expect(stoppedContainers).toContain('townhouse-mill');

      // Connector should be recreated with only town in peers
      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-connector',
          Env: expect.arrayContaining([
            expect.stringMatching(/CONNECTOR_PEERS.*town/),
          ]),
        })
      );

      // Verify mill is NOT in the new peers
      const createCall = mockDocker.docker.createContainer.mock.calls.find(
        (call: any[]) => call[0].name === 'townhouse-connector'
      );
      const envArr = createCall?.[0]?.Env as string[];
      const peersEnv = envArr?.find((e: string) =>
        e.startsWith('CONNECTOR_PEERS=')
      );
      expect(peersEnv).not.toContain('mill');
    });
  });

  // ── T-016: Connector env vars include all active nodes as peers after up() ──

  describe('up() — connector env vars include CONNECTOR_PEERS (T-016)', () => {
    it('passes CONNECTOR_PEERS with all active nodes to connector container', async () => {
      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town', 'mill']);

      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-connector',
          Env: expect.arrayContaining([
            expect.stringMatching(/^CONNECTOR_PEERS=.*town.*mill/),
            expect.stringMatching(/^CONNECTOR_ILP_ADDRESS=g\.townhouse$/),
          ]),
        })
      );
    });
  });

  // ── Full up() sequence ──

  describe('up() — full startup sequence (AC #1, #3, #4, #6, #7)', () => {
    it('executes startup in correct order: network -> pull -> connector -> nodes', async () => {
      const callOrder: string[] = [];

      mockDocker.docker.listNetworks.mockImplementation(async () => {
        callOrder.push('listNetworks');
        return [];
      });
      mockDocker.docker.createNetwork.mockImplementation(async () => {
        callOrder.push('createNetwork');
        return mockDocker.mockNetwork;
      });
      mockDocker.docker.listImages.mockImplementation(async () => {
        callOrder.push('listImages');
        return [];
      });
      mockDocker.docker.pull.mockImplementation(async () => {
        callOrder.push('pull');
        return { pipe: vi.fn() };
      });
      mockDocker.docker.createContainer.mockImplementation(
        async (opts: { name: string }) => {
          callOrder.push(`create:${opts.name}`);
          return {
            start: vi.fn().mockImplementation(async () => {
              callOrder.push(`start:${opts.name}`);
            }),
            stop: vi.fn().mockResolvedValue(undefined),
            remove: vi.fn().mockResolvedValue(undefined),
            inspect: vi.fn().mockResolvedValue({
              State: { Health: { Status: 'healthy' }, Running: true },
            }),
          };
        }
      );

      // getContainer for health check
      mockDocker.docker.getContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      });

      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
      );
      await orchestrator.up(['town', 'mill']);

      // Network created before anything else
      expect(callOrder.indexOf('createNetwork')).toBeLessThan(
        callOrder.indexOf('pull')
      );
      // Pull before container creation
      expect(callOrder.indexOf('pull')).toBeLessThan(
        callOrder.indexOf('create:townhouse-connector')
      );
      // Connector created/started before nodes
      expect(callOrder.indexOf('start:townhouse-connector')).toBeLessThan(
        callOrder.indexOf('start:townhouse-town')
      );
      expect(callOrder.indexOf('start:townhouse-connector')).toBeLessThan(
        callOrder.indexOf('start:townhouse-mill')
      );
    });
  });

  // ── Story 21.4: Wallet key injection into node containers (AC #3, #4, Task 5) ──

  describe('WalletManager integration (Story 21.4, AC #3, #4)', () => {
    it('injects NODE_NOSTR_PUBKEY, NODE_EVM_ADDRESS, NODE_NOSTR_SECRET_KEY when wallet provided', async () => {
      const { WalletManager } = await import('../wallet/manager.js');

      const walletManager = new WalletManager({
        encryptedPath: '/tmp/test.enc',
      });
      await walletManager.fromMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config,
        walletManager
      );
      await orchestrator.up(['town']);

      // Town container should have wallet-derived keys injected
      const townKeys = walletManager.getNodeKeys('town');
      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-town',
          Env: expect.arrayContaining([
            `NODE_NOSTR_PUBKEY=${townKeys.nostrPubkey}`,
            `NODE_EVM_ADDRESS=${townKeys.evmAddress}`,
            expect.stringMatching(/^NODE_NOSTR_SECRET_KEY=[0-9a-f]{64}$/),
          ]),
        })
      );
    });

    it('injects different keys for different node types', async () => {
      const { WalletManager } = await import('../wallet/manager.js');

      const walletManager = new WalletManager({
        encryptedPath: '/tmp/test.enc',
      });
      await walletManager.fromMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );

      const config = configWithNodes(['town', 'mill']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config,
        walletManager
      );
      await orchestrator.up(['town', 'mill']);

      const townKeys = walletManager.getNodeKeys('town');
      const millKeys = walletManager.getNodeKeys('mill');

      // Town container gets town keys
      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-town',
          Env: expect.arrayContaining([
            `NODE_NOSTR_PUBKEY=${townKeys.nostrPubkey}`,
            `NODE_EVM_ADDRESS=${townKeys.evmAddress}`,
          ]),
        })
      );

      // Mill container gets mill keys (different from town)
      expect(mockDocker.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'townhouse-mill',
          Env: expect.arrayContaining([
            `NODE_NOSTR_PUBKEY=${millKeys.nostrPubkey}`,
            `NODE_EVM_ADDRESS=${millKeys.evmAddress}`,
          ]),
        })
      );

      // Verify keys are actually different
      expect(townKeys.nostrPubkey).not.toBe(millKeys.nostrPubkey);
      expect(townKeys.evmAddress).not.toBe(millKeys.evmAddress);
    });

    it('does NOT inject wallet keys when no WalletManager provided (backward compatible)', async () => {
      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
        // No walletManager argument
      );
      await orchestrator.up(['town']);

      // Town container should NOT have wallet env vars
      const createCalls = mockDocker.docker.createContainer.mock.calls;
      const townCall = createCalls.find(
        (call: any[]) => call[0].name === 'townhouse-town'
      );
      expect(townCall).toBeDefined();
      const townEnv = townCall![0].Env as string[];
      expect(
        townEnv.some((e: string) => e.startsWith('NODE_NOSTR_PUBKEY='))
      ).toBe(false);
      expect(
        townEnv.some((e: string) => e.startsWith('NODE_EVM_ADDRESS='))
      ).toBe(false);
      expect(
        townEnv.some((e: string) => e.startsWith('NODE_NOSTR_SECRET_KEY='))
      ).toBe(false);
    });

    it('continues without key injection if wallet is locked (not initialized)', async () => {
      const { WalletManager } = await import('../wallet/manager.js');

      const walletManager = new WalletManager({
        encryptedPath: '/tmp/test.enc',
      });
      // Do NOT call fromMnemonic — wallet is not initialized

      const config = configWithNodes(['town']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config,
        walletManager
      );

      // Should not throw — graceful fallback
      await expect(orchestrator.up(['town'])).resolves.toBeUndefined();

      // Town container should NOT have wallet env vars (getNodeKeys throws, caught silently)
      const createCalls = mockDocker.docker.createContainer.mock.calls;
      const townCall = createCalls.find(
        (call: any[]) => call[0].name === 'townhouse-town'
      );
      expect(townCall).toBeDefined();
      const townEnv = townCall![0].Env as string[];
      expect(
        townEnv.some((e: string) => e.startsWith('NODE_NOSTR_PUBKEY='))
      ).toBe(false);
    });
  });

  // ── Phase 4: DVM_ARWEAVE_JWK_B64 piping ────────────────────────────────────

  describe('DVM Arweave JWK env injection (Phase 4)', () => {
    it('passes DVM_ARWEAVE_JWK_B64 to dvm container as base64(JSON(jwk))', async () => {
      const { WalletManager } = await import('../wallet/manager.js');

      const walletManager = new WalletManager({
        encryptedPath: '/tmp/test-phase4.enc',
      });
      await walletManager.fromMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );

      // Mock ensureArweaveKey to avoid the real 5–30s RSA-4096 derivation.
      const FAKE_JWK = {
        kty: 'RSA',
        n: 'n-value',
        e: 'AQAB',
        d: 'd-value',
        p: 'p-value',
        q: 'q-value',
        dp: 'dp-value',
        dq: 'dq-value',
        qi: 'qi-value',
      };
      const ensureSpy = vi
        .spyOn(walletManager, 'ensureArweaveKey')
        .mockResolvedValue(FAKE_JWK as never);
      const getJwkSpy = vi
        .spyOn(walletManager, 'getArweaveJwk')
        .mockReturnValue(FAKE_JWK as never);

      const config = configWithNodes(['dvm']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config,
        walletManager
      );
      await orchestrator.up(['dvm']);

      expect(ensureSpy).toHaveBeenCalledWith('dvm');
      expect(getJwkSpy).toHaveBeenCalledWith('dvm');

      const dvmCall = mockDocker.docker.createContainer.mock.calls.find(
        (c: any[]) => c[0]?.name === 'townhouse-dvm'
      );
      expect(dvmCall).toBeDefined();
      const env: string[] = dvmCall?.[0]?.Env ?? [];
      const jwkEnv = env.find((e) => e.startsWith('DVM_ARWEAVE_JWK_B64='));
      expect(jwkEnv).toBeDefined();
      // Verify the value is correctly base64-encoded JSON of the JWK.
      const b64 = jwkEnv!.slice('DVM_ARWEAVE_JWK_B64='.length);
      const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
      expect(decoded).toEqual(FAKE_JWK);
    });

    it('omits DVM_ARWEAVE_JWK_B64 when no WalletManager is provided (legacy-only mode)', async () => {
      const config = configWithNodes(['dvm']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config
        // no walletManager
      );
      await orchestrator.up(['dvm']);

      const dvmCall = mockDocker.docker.createContainer.mock.calls.find(
        (c: any[]) => c[0]?.name === 'townhouse-dvm'
      );
      expect(dvmCall).toBeDefined();
      const env: string[] = dvmCall?.[0]?.Env ?? [];
      expect(env.some((e) => e.startsWith('DVM_ARWEAVE_JWK_B64='))).toBe(false);
    });

    it('still passes TURBO_TOKEN through alongside DVM_ARWEAVE_JWK_B64 (entrypoint picks preferred)', async () => {
      const { WalletManager } = await import('../wallet/manager.js');
      const walletManager = new WalletManager({
        encryptedPath: '/tmp/test-phase4-both.enc',
      });
      await walletManager.fromMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );
      vi.spyOn(walletManager, 'ensureArweaveKey').mockResolvedValue({
        kty: 'RSA',
        n: 'n',
        e: 'AQAB',
        d: 'd',
        p: 'p',
        q: 'q',
        dp: 'dp',
        dq: 'dq',
        qi: 'qi',
      } as never);
      vi.spyOn(walletManager, 'getArweaveJwk').mockReturnValue({
        kty: 'RSA',
        n: 'n',
        e: 'AQAB',
        d: 'd',
        p: 'p',
        q: 'q',
        dp: 'dp',
        dq: 'dq',
        qi: 'qi',
      } as never);

      const originalToken = process.env['TURBO_TOKEN'];
      process.env['TURBO_TOKEN'] = 'legacy-jwk-json';
      try {
        const config = configWithNodes(['dvm']);
        const orchestrator = new DockerOrchestrator(
          mockDocker.docker as any,
          config,
          walletManager
        );
        await orchestrator.up(['dvm']);

        const dvmCall = mockDocker.docker.createContainer.mock.calls.find(
          (c: any[]) => c[0]?.name === 'townhouse-dvm'
        );
        const env: string[] = dvmCall?.[0]?.Env ?? [];
        // BOTH env vars must be present — entrypoint picks the preferred one.
        expect(env.some((e) => e.startsWith('DVM_ARWEAVE_JWK_B64='))).toBe(
          true
        );
        expect(env).toContain('TURBO_TOKEN=legacy-jwk-json');
      } finally {
        if (originalToken === undefined) {
          delete process.env['TURBO_TOKEN'];
        } else {
          process.env['TURBO_TOKEN'] = originalToken;
        }
      }
    });

    it('continues without DVM_ARWEAVE_JWK_B64 if ensureArweaveKey throws (graceful fallback)', async () => {
      const { WalletManager } = await import('../wallet/manager.js');
      const walletManager = new WalletManager({
        encryptedPath: '/tmp/test-phase4-fail.enc',
      });
      await walletManager.fromMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );
      vi.spyOn(walletManager, 'ensureArweaveKey').mockRejectedValue(
        new Error('RSA derivation unsupported on this platform')
      );

      const config = configWithNodes(['dvm']);
      const orchestrator = new DockerOrchestrator(
        mockDocker.docker as any,
        config,
        walletManager
      );

      // Should not throw — graceful fallback.
      await expect(orchestrator.up(['dvm'])).resolves.toBeUndefined();

      const dvmCall = mockDocker.docker.createContainer.mock.calls.find(
        (c: any[]) => c[0]?.name === 'townhouse-dvm'
      );
      const env: string[] = dvmCall?.[0]?.Env ?? [];
      expect(env.some((e) => e.startsWith('DVM_ARWEAVE_JWK_B64='))).toBe(false);
    });
  });
});

// ── Story 46.2: pullImage, startNodeViaCompose, stopNodeViaCompose ────────────

import {
  writeFileSync as _wfs46,
  mkdtempSync as _mkd46,
  rmSync as _rms46,
} from 'node:fs';
import { join as _join46 } from 'node:path';
import { tmpdir as _tmpdir46 } from 'node:os';

function makeTempCompose46() {
  const dir = _mkd46(_join46(_tmpdir46(), 'orch-46-'));
  const composePath = _join46(dir, 'compose.yml');
  _wfs46(composePath, 'services: {}\n');
  return {
    composePath,
    cleanup: () => _rms46(dir, { recursive: true, force: true }),
  };
}

type Exec46 = (
  file: string,
  args: readonly string[],
  options?: Record<string, unknown>
) => Promise<{ stdout: string; stderr: string }>;

function makeExec46() {
  const calls: {
    file: string;
    args: string[];
    options?: Record<string, unknown>;
  }[] = [];
  const exec: Exec46 = (file, args, options) => {
    calls.push({ file: String(file), args: Array.from(args), options });
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { exec, calls };
}

describe('DockerOrchestrator (Story 46.2 — pullImage, startNodeViaCompose, stopNodeViaCompose)', () => {
  describe('pullImage()', () => {
    it('skips pull when image already exists in RepoTags', async () => {
      const mockDocker = {
        listImages: vi.fn().mockResolvedValue([
          {
            RepoTags: ['ghcr.io/toon-protocol/town:latest'],
            RepoDigests: [],
          },
        ]),
        pull: vi.fn(),
        modem: { followProgress: vi.fn() },
      } as never;

      const orch = new DockerOrchestrator(mockDocker, getDefaultConfig());
      await orch.pullImage('ghcr.io/toon-protocol/town:latest');
      expect(mockDocker.pull).not.toHaveBeenCalled();
    });

    it('skips pull when image already exists in RepoDigests', async () => {
      const digest = 'sha256:' + 'a'.repeat(64);
      const ref = `ghcr.io/toon-protocol/town@${digest}`;
      const mockDocker = {
        listImages: vi
          .fn()
          .mockResolvedValue([{ RepoTags: [], RepoDigests: [ref] }]),
        pull: vi.fn(),
        modem: { followProgress: vi.fn() },
      } as never;

      const orch = new DockerOrchestrator(mockDocker, getDefaultConfig());
      await orch.pullImage(ref);
      expect(mockDocker.pull).not.toHaveBeenCalled();
    });

    it('calls docker.pull and follows the stream for a new image', async () => {
      const fakeStream = {};
      const mockDocker = {
        listImages: vi.fn().mockResolvedValue([]),
        pull: vi.fn().mockResolvedValue(fakeStream),
        modem: {
          followProgress: vi
            .fn()
            .mockImplementation(
              (_stream: unknown, onFinished: (err: null) => void) =>
                onFinished(null)
            ),
        },
      } as never;

      const orch = new DockerOrchestrator(mockDocker, getDefaultConfig());
      await orch.pullImage('ghcr.io/toon-protocol/town:new');
      expect(mockDocker.pull).toHaveBeenCalledWith(
        'ghcr.io/toon-protocol/town:new'
      );
    });

    it('wraps docker.pull failure in OrchestratorError', async () => {
      const mockDocker = {
        listImages: vi.fn().mockResolvedValue([]),
        pull: vi.fn().mockRejectedValue(new Error('registry error')),
        modem: { followProgress: vi.fn() },
      } as never;

      const orch = new DockerOrchestrator(mockDocker, getDefaultConfig());
      await expect(
        orch.pullImage('ghcr.io/toon-protocol/town:bad')
      ).rejects.toMatchObject({
        name: 'OrchestratorError',
      });
    });
  });

  describe('startNodeViaCompose()', () => {
    it('throws OrchestratorError when profile is dev', async () => {
      // dev profile (default) — no composePath
      const { exec } = makeExec46();
      const orch = new DockerOrchestrator(
        {} as never,
        getDefaultConfig(),
        undefined,
        { execFileAsync: exec as never }
      );
      await expect(
        orch.startNodeViaCompose('town', { TOWN_SECRET_KEY: 'abc' })
      ).rejects.toMatchObject({ name: 'OrchestratorError' });
    });

    it('calls execFileAsync with correct compose args and layered env', async () => {
      const { composePath, cleanup } = makeTempCompose46();
      try {
        const { exec, calls } = makeExec46();
        const orch = new DockerOrchestrator(
          {} as never,
          getDefaultConfig(),
          undefined,
          { profile: 'hs', composePath, execFileAsync: exec as never }
        );
        await orch.startNodeViaCompose('town', {
          TOWN_SECRET_KEY: 'testsecret',
        });

        expect(calls).toHaveLength(1);
        const { file, args, options } = calls[0]!;
        expect(file).toBe('docker');
        expect(args).toEqual([
          'compose',
          '-f',
          composePath,
          '--profile',
          'town',
          'up',
          '-d',
          'town',
        ]);
        // env must be layered (contains both process.env and the secret)
        const env = (options as { env?: Record<string, string> })?.env;
        expect(env).toBeDefined();
        expect(env?.['TOWN_SECRET_KEY']).toBe('testsecret');
        expect(env?.['PATH']).toBeDefined(); // process.env inherited
      } finally {
        cleanup();
      }
    });
  });

  describe('stopNodeViaCompose()', () => {
    it('throws OrchestratorError when profile is dev', async () => {
      const { exec } = makeExec46();
      const orch = new DockerOrchestrator(
        {} as never,
        getDefaultConfig(),
        undefined,
        { execFileAsync: exec as never }
      );
      await expect(orch.stopNodeViaCompose('mill')).rejects.toMatchObject({
        name: 'OrchestratorError',
      });
    });

    it('calls stop then rm with correct args', async () => {
      const { composePath, cleanup } = makeTempCompose46();
      try {
        const { exec, calls } = makeExec46();
        const orch = new DockerOrchestrator(
          {} as never,
          getDefaultConfig(),
          undefined,
          { profile: 'hs', composePath, execFileAsync: exec as never }
        );
        await orch.stopNodeViaCompose('mill');

        expect(calls).toHaveLength(2);
        expect(calls[0]?.args).toContain('stop');
        expect(calls[0]?.args).toContain('mill');
        expect(calls[1]?.args).toContain('rm');
        expect(calls[1]?.args).toContain('mill');
      } finally {
        cleanup();
      }
    });

    it('swallows "no such service" stderr — real-world docker compose rm stderr string', async () => {
      const { composePath, cleanup } = makeTempCompose46();
      try {
        // Real-world docker compose rm stderr when container doesn't exist
        const noSuchContainerStderr =
          'no containers to remove\nservice "mill" is not running container "townhouse-hs-mill"';
        const exec: Exec46 = () => {
          const err = Object.assign(
            new Error('docker subprocess exited with code 1'),
            { stderr: noSuchContainerStderr, code: 1 }
          );
          return Promise.reject(err);
        };
        const orch = new DockerOrchestrator(
          {} as never,
          getDefaultConfig(),
          undefined,
          { profile: 'hs', composePath, execFileAsync: exec as never }
        );
        // Must not throw — no such container is an idempotent no-op
        await expect(orch.stopNodeViaCompose('mill')).resolves.toBeUndefined();
      } finally {
        cleanup();
      }
    });
  });
});
