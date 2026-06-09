/**
 * Tests for `townhouse setup` CLI command (AC-1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { main, CliHelpRequested } from './cli.js';
import { NoopBrowserOpener } from './cli/browser-opener.js';

// Mock dockerode
vi.mock('dockerode', () => ({
  default: class MockDocker {
    createContainer() {
      return Promise.resolve({
        start: vi.fn(),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      });
    }
    getContainer() {
      return {
        start: vi.fn(),
        stop: vi.fn(),
        remove: vi.fn(),
        inspect: vi.fn().mockResolvedValue({
          State: { Health: { Status: 'healthy' }, Running: true },
        }),
      };
    }
    listContainers() {
      return Promise.resolve([]);
    }
    createNetwork() {
      return Promise.resolve({ remove: vi.fn() });
    }
    listNetworks() {
      return Promise.resolve([]);
    }
    getNetwork() {
      return { remove: vi.fn() };
    }
    pull() {
      return Promise.resolve({ pipe: vi.fn() });
    }
    listImages() {
      return Promise.resolve([]);
    }
    modem = {
      followProgress: vi.fn().mockImplementation((_s, onFinished) => {
        onFinished(null);
      }),
    };
  },
}));

// Mock createWizardApiServer to avoid real Fastify bind
vi.mock('./api/wizard-server.js', () => ({
  createWizardApiServer: vi.fn().mockResolvedValue({
    app: {
      listen: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `townhouse-setup-test-${randomBytes(8).toString('hex')}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('CLI setup command (AC-1)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('short-circuits when both config.yaml and wallet.enc already exist', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    const walletPath = join(dir, 'wallet.enc');

    try {
      writeFileSync(configPath, 'test: true');
      writeFileSync(walletPath, 'encrypted-wallet-bytes');

      await main(['setup', '--no-browser', '--config-dir', dir]);

      const output = consoleLogSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(output).toContain('Already initialized');
      expect(output).toContain('townhouse up');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run when config exists but wallet does not (avoids setup/up dead-end)', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');

    try {
      writeFileSync(configPath, 'test: true');
      // No wallet.enc — operator deleted it or restored config without wallet

      await main(['setup', '--no-browser', '--config-dir', dir]);

      const errorOutput = consoleSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(errorOutput).toContain('no wallet');
      expect(errorOutput).toContain('Delete the orphan config');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setup --help documents the setup command', async () => {
    await expect(main(['--help'])).rejects.toThrow(CliHelpRequested);
    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('setup');
    expect(output).toContain('--no-browser');
    expect(output).toContain('--port');
  });

  it('--port override is parsed and used', async () => {
    const { createWizardApiServer } = await import('./api/wizard-server.js');
    const mockCreate = vi.mocked(createWizardApiServer);
    mockCreate.mockClear();

    const dir = makeTempDir();
    try {
      await main([
        'setup',
        '--no-browser',
        '--port',
        '9999',
        '--config-dir',
        dir,
      ]);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ port: 9999 })
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--no-browser flag suppresses browser open (verified by injected opener)', async () => {
    const noop = new NoopBrowserOpener();
    const dir = makeTempDir();
    try {
      // Plumb the opener through main()'s test seam — without this the assertion
      // is meaningless because the production opener is constructed inside
      // handleSetup and the noop instance is never consulted.
      await main(
        ['setup', '--no-browser', '--config-dir', dir],
        undefined,
        noop
      );
      expect(noop.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens the browser by default and records the wizard URL via the injected opener', async () => {
    const noop = new NoopBrowserOpener();
    const dir = makeTempDir();
    try {
      await main(
        ['setup', '--port', '9410', '--config-dir', dir],
        undefined,
        noop
      );
      expect(noop.calls).toEqual(['http://127.0.0.1:9410/wizard']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects --port with trailing junk like "9400foo"', async () => {
    const dir = makeTempDir();
    try {
      await main([
        'setup',
        '--no-browser',
        '--port',
        '9400foo',
        '--config-dir',
        dir,
      ]);
      const errorOutput = consoleSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(errorOutput).toContain('--port must be an integer');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid port', async () => {
    const dir = makeTempDir();
    try {
      await main([
        'setup',
        '--no-browser',
        '--port',
        '999999',
        '--config-dir',
        dir,
      ]);
      const errorOutput = consoleSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(errorOutput).toContain('port');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI up command fail-fast (AC-2)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('up fails fast with clear message when wallet is absent', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');

    try {
      writeFileSync(
        configPath,
        `
nodes:
  town: { enabled: true }
  mill: { enabled: false }
  dvm: { enabled: false }
wallet:
  encrypted_path: ${join(dir, 'wallet.enc')}
connector:
  image: ghcr.io/toon-protocol/connector:3.4.1
  adminPort: 9401
transport:
  mode: direct
api:
  port: 0
  host: 127.0.0.1
logging:
  level: info
`
      );

      // Phase 3: plain `up` is the direct-BTP apex path, which fails fast with
      // a "Run `townhouse init` first" message when the wallet is absent.
      await main(['up', '-c', configPath]);

      const errorOutput = consoleErrorSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(errorOutput).toContain('Wallet not found');
      expect(errorOutput).toContain('townhouse init');
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
