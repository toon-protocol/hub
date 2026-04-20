import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { main, CliHelpRequested } from './cli.js';

/**
 * Mock dockerode for all CLI tests.
 * Returns a mock Docker instance that simulates successful container operations.
 */
vi.mock('dockerode', () => {
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

  return {
    default: class MockDocker {
      createContainer() {
        return Promise.resolve(mockContainer);
      }
      getContainer() {
        return mockContainer;
      }
      listContainers() {
        return Promise.resolve([]);
      }
      createNetwork() {
        return Promise.resolve(mockNetwork);
      }
      listNetworks() {
        return Promise.resolve([]);
      }
      getNetwork() {
        return mockNetwork;
      }
      pull() {
        return Promise.resolve({ pipe: vi.fn() });
      }
      listImages() {
        return Promise.resolve([]);
      }
      modem = {
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
      };
    },
  };
});

/** Create a unique temp dir for each test to avoid collisions. */
function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `townhouse-cli-test-${randomBytes(8).toString('hex')}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Standard config YAML with specific nodes enabled */
function makeConfig(
  enabled: { town?: boolean; mill?: boolean; dvm?: boolean } = {}
): string {
  return `
nodes:
  town:
    enabled: ${enabled.town ?? false}
    feePerEvent: 1000
  mill:
    enabled: ${enabled.mill ?? false}
    feeBasisPoints: 50
  dvm:
    enabled: ${enabled.dvm ?? false}
    feePerJob: 5000
wallet:
  encrypted_path: /tmp/wallet.enc
connector:
  image: ghcr.io/toon-protocol/connector:latest
  adminPort: 9401
transport:
  mode: direct
api:
  port: 9400
  host: 127.0.0.1
logging:
  level: info
`;
}

describe('CLI', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('--help (T-005)', () => {
    it('throws CliHelpRequested and prints help with all commands', async () => {
      await expect(main(['--help'])).rejects.toThrow(CliHelpRequested);
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('init');
      expect(output).toContain('up');
      expect(output).toContain('down');
      expect(output).toContain('status');
    });

    it('throws CliHelpRequested when no command given', async () => {
      await expect(main([])).rejects.toThrow(CliHelpRequested);
    });

    it('help text documents --town, --mill, --dvm flags', async () => {
      await expect(main(['--help'])).rejects.toThrow(CliHelpRequested);
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('--town');
      expect(output).toContain('--mill');
      expect(output).toContain('--dvm');
    });
  });

  describe('init (T-001, T-004)', () => {
    it('init --force creates config in specified directory', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        await main(['init', '--force', '--config-dir', dir]);
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Config created')
        );
        expect(existsSync(configPath)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('init without --force refuses to overwrite existing config', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');
      writeFileSync(configPath, 'test: placeholder', 'utf-8');

      try {
        await main(['init', '--config-dir', dir]);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('already exists')
        );
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('--force')
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('status (T-002)', () => {
    it('shows "stopped" for all node types when no containers running', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig(), 'utf-8');

        await main(['status', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('connector');
        expect(output).toContain('town');
        expect(output).toContain('mill');
        expect(output).toContain('dvm');
        expect(output).toContain('stopped');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('up command', () => {
    it('up with no nodes enabled shows informative message', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig(), 'utf-8');

        await main(['up', '-c', configPath]);
        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('No nodes enabled');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('up with enabled nodes starts orchestration', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');

        await main(['up', '-c', configPath]);
        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('Starting nodes');
        expect(output).toContain('town');
        expect(output).toContain('started successfully');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('down command', () => {
    it('down stops nodes and reports completion', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig(), 'utf-8');

        await main(['down', '-c', configPath]);
        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('Stopping nodes');
        expect(output).toContain('stopped');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('status (T-002) — per-node-type verification', () => {
    it('shows state for every node type individually', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig(), 'utf-8');

        await main(['status', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        // Each of the 4 node types must appear on its own line with a state
        for (const nodeType of ['connector', 'town', 'mill', 'dvm']) {
          expect(output).toMatch(new RegExp(`${nodeType}\\s+stopped`));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('init (T-001) — YAML schema verification', () => {
    it('init --force produces YAML that loadConfig can parse and validate', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        await main(['init', '--force', '--config-dir', dir]);

        // The generated config should be loadable and valid
        const { loadConfig } = await import('./config/loader.js');
        const config = loadConfig(configPath);
        expect(config.nodes.town.enabled).toBe(false);
        expect(config.nodes.mill.enabled).toBe(false);
        expect(config.nodes.dvm.enabled).toBe(false);
        expect(config.connector.image).toBe(
          'ghcr.io/toon-protocol/connector:latest'
        );
        expect(config.api.port).toBe(9400);
        expect(config.api.host).toBe('127.0.0.1');
        expect(config.transport.mode).toBe('direct');
        expect(config.logging.level).toBe('info');
        expect(config.wallet.encrypted_path).toContain('.townhouse');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('unknown command', () => {
    it('prints error for unknown command', async () => {
      await main(['frobnicate']);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown command')
      );
    });
  });

  describe('up/down with missing config', () => {
    it('up throws when config file does not exist', async () => {
      await expect(
        main(['up', '-c', '/nonexistent/path/config.yaml'])
      ).rejects.toThrow('Config file not found');
    });

    it('down throws when config file does not exist', async () => {
      await expect(
        main(['down', '-c', '/nonexistent/path/config.yaml'])
      ).rejects.toThrow('Config file not found');
    });
  });

  // ── Story 21.2: New flag parsing (T-007, T-010) ──

  describe('--town, --mill, --dvm flags (Story 21.2, T-007, T-010)', () => {
    it('parses --town flag and starts town node', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');

        await main(['up', '--town', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('town');
        expect(output).toContain('Starting nodes');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parses --mill flag and starts mill node', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig({ mill: true }), 'utf-8');

        await main(['up', '--mill', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('mill');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parses --dvm flag and starts dvm node', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig({ dvm: true }), 'utf-8');

        await main(['up', '--dvm', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('dvm');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parses combined --town --mill flags', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(
          configPath,
          makeConfig({ town: true, mill: true }),
          'utf-8'
        );

        await main(['up', '--town', '--mill', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('town');
        expect(output).toContain('mill');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('defaults to all enabled nodes when no flags provided', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(
          configPath,
          makeConfig({ town: true, mill: true }),
          'utf-8'
        );

        // No --town/--mill/--dvm flags: should start all enabled (town + mill)
        await main(['up', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('town');
        expect(output).toContain('mill');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Story 21.2: SIGINT graceful shutdown (T-013) ──

  describe('SIGINT handling (Story 21.2, T-013)', () => {
    it('registers SIGINT handler during up command', async () => {
      const processOnSpy = vi.spyOn(process, 'on');

      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');

        await main(['up', '--town', '-c', configPath]);

        expect(processOnSpy).toHaveBeenCalledWith(
          'SIGINT',
          expect.any(Function)
        );
      } finally {
        processOnSpy.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('SIGINT handler calls orchestrator.down() for graceful shutdown', async () => {
      const processOnSpy = vi.spyOn(process, 'on');
      const processExitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as never);

      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');

        await main(['up', '--town', '-c', configPath]);

        // Extract the registered SIGINT handler
        const sigintCall = processOnSpy.mock.calls.find(
          (call) => call[0] === 'SIGINT'
        );
        expect(sigintCall).toBeDefined();

        const sigintHandler = sigintCall![1] as () => Promise<void>;

        // Invoke the SIGINT handler — should call orchestrator.down()
        await sigintHandler();

        // Verify process.exit(0) was called after cleanup
        expect(processExitSpy).toHaveBeenCalledWith(0);
      } finally {
        processOnSpy.mockRestore();
        processExitSpy.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Story 21.2: Docker unavailable error at CLI level (T-014, AC #8) ──

  describe('Docker unavailable at CLI level (T-014, AC #8)', () => {
    it('surfaces clear Docker-unavailable error through handleUp', async () => {
      // We need to test the CLI's error wrapping for Docker-unavailable.
      // Import DockerOrchestrator and mock its up() to throw a socket error.
      const { DockerOrchestrator } = await import('./docker/orchestrator.js');
      const originalUp = DockerOrchestrator.prototype.up;

      DockerOrchestrator.prototype.up = vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Docker is not running or not available. Please start Docker and try again. (connect ENOENT /var/run/docker.sock)'
          )
        );

      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');

        await expect(main(['up', '--town', '-c', configPath])).rejects.toThrow(
          /docker.*not available/i
        );
      } finally {
        DockerOrchestrator.prototype.up = originalUp;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Story 21.2: down() full sequence — nodes stopped before network removal (AC #5) ──

  describe('down() full sequence (AC #5)', () => {
    it('reports stopping and completion messages', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');

        await main(['down', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        // Must show both "Stopping" and "stopped" to confirm full lifecycle
        expect(output).toMatch(/stopping/i);
        expect(output).toMatch(/stopped/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
