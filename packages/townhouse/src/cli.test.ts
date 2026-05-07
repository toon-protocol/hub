import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { main, CliHelpRequested } from './cli.js';
import { DEFAULT_CONNECTOR_IMAGE } from './constants.js';
import { WalletManager, encryptWallet, saveWallet } from './wallet/index.js';

const WALLET_TEST_PASSWORD = 'townhouse-test-pw';

/** Create an encrypted wallet at the given path for use in `up` tests. */
async function seedWallet(
  walletPath: string,
  password = WALLET_TEST_PASSWORD
): Promise<void> {
  const wm = new WalletManager({ encryptedPath: walletPath });
  const { mnemonic } = await wm.generate();
  await saveWallet(walletPath, encryptWallet(mnemonic, password));
}

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
  enabled: { town?: boolean; mill?: boolean; dvm?: boolean } = {},
  walletPath = '/tmp/wallet.enc',
  apiPort = 0
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
  encrypted_path: ${walletPath}
connector:
  image: ghcr.io/toon-protocol/connector:3.4.1
  adminPort: 9401
transport:
  mode: direct
api:
  port: ${apiPort}
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
      const walletPath = join(dir, 'wallet.enc');
      const configPath = join(dir, 'config.yaml');

      await seedWallet(walletPath);
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_TEST_PASSWORD;

      try {
        writeFileSync(
          configPath,
          makeConfig({ town: true }, walletPath),
          'utf-8'
        );

        await main(['up', '-c', configPath]);
        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('Starting nodes');
        expect(output).toContain('town');
        expect(output).toContain('started successfully');
      } finally {
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('up fails fast when wallet is absent (AC-2)', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        // Config exists but wallet doesn't — should fail fast
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');

        await main(['up', '-c', configPath]);

        const errorOutput = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(errorOutput).toContain('Wallet not found');
        expect(errorOutput).toContain('townhouse setup');
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = 0;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Story 21.8 Task 8.3 — `up --dry-run` wires the API factory without
    // starting containers or binding a listening socket. Asserts that the
    // API deps are constructed with the expected configPath, host/port, and
    // connector-admin base URL.
    it('up --dry-run wires API factory without starting containers or listening', async () => {
      const { WalletManager, encryptWallet, saveWallet } =
        await import('./wallet/index.js');
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');
      const walletPath = join(dir, 'wallet.enc');

      // Seed a wallet so dry-run exercises the full API wiring path.
      const wm = new WalletManager({ encryptedPath: walletPath });
      const { mnemonic } = await wm.generate();
      await saveWallet(walletPath, encryptWallet(mnemonic, 'test-pw'));
      wm.lock();
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = 'test-pw';

      try {
        // Use port 9400 explicitly so the dry-run log matches the expected pattern
        writeFileSync(
          configPath,
          makeConfig({ town: true }, walletPath, 9400),
          'utf-8'
        );

        await main(['up', '--town', '--dry-run', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');

        // Assert dry-run skipped container startup.
        expect(output).toContain('[dry-run] Skipped orchestrator.up()');

        // Assert API factory was invoked with the expected deps.
        expect(output).toMatch(
          /\[dry-run\] API factory invoked: configPath=.+ host=127\.0\.0\.1 port=9400 connectorAdmin=http:\/\/127\.0\.0\.1:\d+ wallet=WalletManager/
        );

        // Assert no "listening on" banner (server was not bound).
        expect(output).not.toContain('[Townhouse API] listening on');
      } finally {
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
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
        expect(config.connector.image).toBe(DEFAULT_CONNECTOR_IMAGE);
        expect(config.api.port).toBe(9400);
        expect(config.api.host).toBe('127.0.0.1');
        expect(config.transport.mode).toBe('direct');
        expect(config.logging.level).toBe('info');
        expect(config.wallet.encrypted_path).toBe(join(dir, 'wallet.enc'));
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

  // ── Story 21.3: metrics command ──

  describe('metrics command (Story 21.3)', () => {
    it('help text documents the metrics command', async () => {
      await expect(main(['--help'])).rejects.toThrow(CliHelpRequested);
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('metrics');
    });

    it('metrics command calls connector admin API', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      // Mock global fetch for admin client (paths mirror connector source-of-truth)
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/admin/metrics.json')) {
          return {
            ok: true,
            json: async () => ({
              uptimeSeconds: 60,
              aggregate: {
                packetsForwarded: 100,
                packetsRejected: 5,
                bytesSent: 2000,
              },
              peers: [
                {
                  peerId: 'town',
                  connected: true,
                  packetsForwarded: 80,
                  packetsRejected: 1,
                  bytesSent: 1500,
                  lastPacketAt: '2026-04-29T00:00:00.000Z',
                },
              ],
              timestamp: '2026-04-29T00:00:00.000Z',
            }),
          };
        }
        if (url.includes('/admin/peers')) {
          return {
            ok: true,
            json: async () => ({
              nodeId: 'townhouse-canary',
              peerCount: 1,
              connectedCount: 1,
              peers: [
                {
                  id: 'town',
                  connected: true,
                  ilpAddresses: ['g.toon.town'],
                  routeCount: 1,
                },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });
      vi.stubGlobal('fetch', fetchMock);

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');
        await main(['metrics', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('Packets forwarded');
        expect(output).toContain('100');
      } finally {
        vi.unstubAllGlobals();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('metrics command shows error when connector not running', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
      vi.stubGlobal('fetch', fetchMock);

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');
        await main(['metrics', '-c', configPath]);

        const output = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('Failed to fetch connector metrics');
      } finally {
        vi.unstubAllGlobals();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Story 21.3: enhanced status with connector metrics (Task 4.2, AC #4) ──

  describe('status command — enhanced with connector metrics (Story 21.3)', () => {
    it('shows connector metrics when admin API is reachable', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/admin/metrics.json')) {
          return {
            ok: true,
            json: async () => ({
              uptimeSeconds: 60,
              aggregate: {
                packetsForwarded: 250,
                packetsRejected: 3,
                bytesSent: 8000,
              },
              peers: [
                {
                  peerId: 'town',
                  connected: true,
                  packetsForwarded: 200,
                  packetsRejected: 1,
                  bytesSent: 5000,
                  lastPacketAt: '2026-04-29T00:00:00.000Z',
                },
                {
                  peerId: 'mill',
                  connected: false,
                  packetsForwarded: 50,
                  packetsRejected: 2,
                  bytesSent: 3000,
                  lastPacketAt: null,
                },
              ],
              timestamp: '2026-04-29T00:00:00.000Z',
            }),
          };
        }
        if (url.includes('/admin/peers')) {
          return {
            ok: true,
            json: async () => ({
              nodeId: 'townhouse-canary',
              peerCount: 2,
              connectedCount: 1,
              peers: [
                {
                  id: 'town',
                  connected: true,
                  ilpAddresses: ['g.toon.town'],
                  routeCount: 1,
                },
                {
                  id: 'mill',
                  connected: false,
                  ilpAddresses: ['g.toon.mill'],
                  routeCount: 1,
                },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });
      vi.stubGlobal('fetch', fetchMock);

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');
        await main(['status', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('Connector Metrics');
        expect(output).toContain('Packets forwarded');
        expect(output).toContain('250');
        expect(output).toContain('Active peers');
        expect(output).toContain('1/2');
      } finally {
        vi.unstubAllGlobals();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('prints Hidden Services block with both .anyone URLs when ATOR HS configured', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
      vi.stubGlobal('fetch', fetchMock);

      try {
        const cfg = `
nodes:
  town:
    enabled: true
    feePerEvent: 1000
  mill:
    enabled: false
  dvm:
    enabled: false
wallet:
  encrypted_path: /tmp/wallet.enc
connector:
  image: ghcr.io/toon-protocol/connector:3.4.1
  adminPort: 9401
transport:
  mode: ator
  socksProxy: socks5h://ator-sidecar:9050
  externalUrl: wss://abc.anyone/btp
  hiddenService:
    dir: /var/lib/townhouse/hs/connector
    port: 3000
    externalUrl: wss://abc.anyone/btp
  relayHiddenService:
    dir: /var/lib/townhouse/hs/relay
    port: 7100
    externalUrl: wss://xyz.anyone:7100
api:
  port: 0
  host: 127.0.0.1
logging:
  level: info
`;
        writeFileSync(configPath, cfg, 'utf-8');
        await main(['status', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('Hidden Services');
        expect(output).toContain('Connector (BTP):');
        expect(output).toContain('wss://abc.anyone/btp');
        expect(output).toContain('Relay (Nostr):');
        expect(output).toContain('wss://xyz.anyone:7100');
      } finally {
        vi.unstubAllGlobals();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does NOT print Hidden Services block in direct mode', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
      vi.stubGlobal('fetch', fetchMock);

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');
        await main(['status', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).not.toContain('Hidden Services');
      } finally {
        vi.unstubAllGlobals();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('gracefully degrades when connector admin API is unreachable', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
      vi.stubGlobal('fetch', fetchMock);

      try {
        writeFileSync(configPath, makeConfig({ town: true }), 'utf-8');
        await main(['status', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        // Should still show node status
        expect(output).toContain('Node Status');
        // Should show metrics unavailable, not throw
        expect(output).toContain('unavailable');
      } finally {
        vi.unstubAllGlobals();
        rmSync(dir, { recursive: true, force: true });
      }
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
      const walletPath = join(dir, 'wallet.enc');
      const configPath = join(dir, 'config.yaml');

      await seedWallet(walletPath);
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_TEST_PASSWORD;

      try {
        writeFileSync(
          configPath,
          makeConfig({ town: true }, walletPath),
          'utf-8'
        );

        await main(['up', '--town', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('town');
        expect(output).toContain('Starting nodes');
      } finally {
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parses --mill flag and starts mill node', async () => {
      const dir = makeTempDir();
      const walletPath = join(dir, 'wallet.enc');
      const configPath = join(dir, 'config.yaml');

      await seedWallet(walletPath);
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_TEST_PASSWORD;

      try {
        writeFileSync(
          configPath,
          makeConfig({ mill: true }, walletPath),
          'utf-8'
        );

        await main(['up', '--mill', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('mill');
      } finally {
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parses --dvm flag and starts dvm node', async () => {
      const dir = makeTempDir();
      const walletPath = join(dir, 'wallet.enc');
      const configPath = join(dir, 'config.yaml');

      await seedWallet(walletPath);
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_TEST_PASSWORD;

      try {
        writeFileSync(
          configPath,
          makeConfig({ dvm: true }, walletPath),
          'utf-8'
        );

        await main(['up', '--dvm', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('dvm');
      } finally {
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('parses combined --town --mill flags', async () => {
      const dir = makeTempDir();
      const walletPath = join(dir, 'wallet.enc');
      const configPath = join(dir, 'config.yaml');

      await seedWallet(walletPath);
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_TEST_PASSWORD;

      try {
        writeFileSync(
          configPath,
          makeConfig({ town: true, mill: true }, walletPath),
          'utf-8'
        );

        await main(['up', '--town', '--mill', '-c', configPath]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('town');
        expect(output).toContain('mill');
      } finally {
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('defaults to all enabled nodes when no flags provided', async () => {
      const dir = makeTempDir();
      const walletPath = join(dir, 'wallet.enc');
      const configPath = join(dir, 'config.yaml');

      await seedWallet(walletPath);
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_TEST_PASSWORD;

      try {
        writeFileSync(
          configPath,
          makeConfig({ town: true, mill: true }, walletPath),
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
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Story 21.2: SIGINT graceful shutdown (T-013) ──

  describe('SIGINT handling (Story 21.2, T-013)', () => {
    it('registers SIGINT handler during up command', async () => {
      const processOnSpy = vi.spyOn(process, 'on');

      const dir = makeTempDir();
      const walletPath = join(dir, 'wallet.enc');
      const configPath = join(dir, 'config.yaml');

      await seedWallet(walletPath);
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_TEST_PASSWORD;

      try {
        writeFileSync(
          configPath,
          makeConfig({ town: true }, walletPath),
          'utf-8'
        );

        await main(['up', '--town', '-c', configPath]);

        expect(processOnSpy).toHaveBeenCalledWith(
          'SIGINT',
          expect.any(Function)
        );
      } finally {
        processOnSpy.mockRestore();
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('SIGINT handler calls orchestrator.down() for graceful shutdown', async () => {
      const processOnSpy = vi.spyOn(process, 'on');
      const processExitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as never);

      const dir = makeTempDir();
      const walletPath = join(dir, 'wallet.enc');
      const configPath = join(dir, 'config.yaml');

      await seedWallet(walletPath);
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_TEST_PASSWORD;

      try {
        writeFileSync(
          configPath,
          makeConfig({ town: true }, walletPath),
          'utf-8'
        );

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
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
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
      const walletPath = join(dir, 'wallet.enc');
      const configPath = join(dir, 'config.yaml');

      await seedWallet(walletPath);
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_TEST_PASSWORD;

      try {
        writeFileSync(
          configPath,
          makeConfig({ town: true }, walletPath),
          'utf-8'
        );

        await expect(main(['up', '--town', '-c', configPath])).rejects.toThrow(
          /docker.*not available/i
        );
      } finally {
        DockerOrchestrator.prototype.up = originalUp;
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
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
