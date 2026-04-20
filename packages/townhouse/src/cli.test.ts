import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { main, CliHelpRequested } from './cli.js';

/**
 * Mock dockerode for status tests.
 * The mock returns an empty container list (no containers running).
 */
vi.mock('dockerode', () => {
  return {
    default: class MockDocker {
      listContainers() {
        return Promise.resolve([]);
      }
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
      await main(['status']);

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('connector');
      expect(output).toContain('town');
      expect(output).toContain('mill');
      expect(output).toContain('dvm');
      expect(output).toContain('stopped');
    });
  });

  describe('up command', () => {
    it('up with no nodes enabled shows informative message', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        await main(['init', '--force', '--config-dir', dir]);
        consoleSpy.mockClear();

        await main(['up', '-c', configPath]);
        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('No nodes enabled');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('up with enabled nodes shows starting message', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        const enabledConfig = `
nodes:
  town:
    enabled: true
  mill:
    enabled: false
  dvm:
    enabled: false
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
        writeFileSync(configPath, enabledConfig, 'utf-8');

        await main(['up', '-c', configPath]);
        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('Starting nodes');
        expect(output).toContain('town');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('down command', () => {
    it('down shows stopping message', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        await main(['init', '--force', '--config-dir', dir]);
        consoleSpy.mockClear();

        await main(['down', '-c', configPath]);
        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('Stopping nodes');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('status (T-002) — per-node-type verification', () => {
    it('shows state for every node type individually', async () => {
      await main(['status']);

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // Each of the 4 node types must appear on its own line with a state
      for (const nodeType of ['connector', 'town', 'mill', 'dvm']) {
        expect(output).toMatch(new RegExp(`${nodeType}\\s+stopped`));
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
});
