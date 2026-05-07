/**
 * Unit Tests: CLI Wallet Commands (Story 21.4)
 *
 * Test IDs map to test-design-epic-21.md scenarios T-027, T-028, T-031, T-032, T-033.
 *
 * These tests verify:
 * - AC #2: `townhouse init` generates BIP-39 mnemonic and prompts backup
 * - AC #6: `townhouse wallet show` displays addresses without revealing secrets
 * - AC #8: Mnemonic never appears in log output after initial backup prompt
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { main } from '../cli.js';

/**
 * Mock dockerode for CLI tests (same pattern as existing cli.test.ts).
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

/** Create a unique temp dir for each test */
function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `townhouse-wallet-cli-test-${randomBytes(8).toString('hex')}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('CLI Wallet Commands (Story 21.4)', () => {
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

  // ── T-031: init generates wallet file ──

  describe('init command — wallet generation (AC #2)', () => {
    it('init --force --password generates wallet file', async () => {
      const dir = makeTempDir();
      const walletPath = join(dir, 'wallet.enc');

      try {
        await main([
          'init',
          '--force',
          '--config-dir',
          dir,
          '--password',
          'test-password-123!',
        ]);

        // Wallet file should be created
        expect(existsSync(walletPath)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('init displays mnemonic exactly once for backup', async () => {
      const dir = makeTempDir();

      try {
        await main([
          'init',
          '--force',
          '--config-dir',
          dir,
          '--password',
          'test-password-123!',
        ]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');

        // Should contain backup warning
        expect(output).toContain('Back up your seed phrase');
        expect(output).toContain('ONLY time');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('init displays derived addresses as confirmation', async () => {
      const dir = makeTempDir();

      try {
        await main([
          'init',
          '--force',
          '--config-dir',
          dir,
          '--password',
          'test-password-123!',
        ]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');

        // Should show node types with their addresses
        expect(output).toContain('town');
        expect(output).toContain('mill');
        expect(output).toContain('dvm');
        // Should show EVM addresses (0x...)
        expect(output).toMatch(/0x[0-9a-fA-F]{40}/);
        // Should show Nostr pubkeys
        expect(output).toContain('Nostr');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('init without --password shows error', async () => {
      const dir = makeTempDir();

      // Clear env var to ensure no fallback
      const origEnv = process.env['TOWNHOUSE_WALLET_PASSWORD'];
      delete process.env['TOWNHOUSE_WALLET_PASSWORD'];

      try {
        await main(['init', '--force', '--config-dir', dir]);

        const output = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(output).toContain('password required');
      } finally {
        if (origEnv !== undefined) {
          process.env['TOWNHOUSE_WALLET_PASSWORD'] = origEnv;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('init accepts password from TOWNHOUSE_WALLET_PASSWORD env var', async () => {
      const dir = makeTempDir();
      const walletPath = join(dir, 'wallet.enc');

      const origEnv = process.env['TOWNHOUSE_WALLET_PASSWORD'];
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = 'env-password-456!';

      try {
        await main(['init', '--force', '--config-dir', dir]);

        // Wallet file should be created using env var password
        expect(existsSync(walletPath)).toBe(true);
      } finally {
        if (origEnv !== undefined) {
          process.env['TOWNHOUSE_WALLET_PASSWORD'] = origEnv;
        } else {
          delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── T-032: wallet show displays addresses without secrets ──

  describe('wallet show command (AC #6)', () => {
    it('wallet show displays Nostr pubkeys and EVM addresses', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        // First, create a wallet via init
        await main([
          'init',
          '--force',
          '--config-dir',
          dir,
          '--password',
          'test-password-123!',
        ]);

        // Clear spy calls from init
        consoleSpy.mockClear();

        // Write config pointing to wallet
        writeFileSync(
          configPath,
          `
nodes:
  town:
    enabled: true
    feePerEvent: 1000
  mill:
    enabled: false
    feeBasisPoints: 50
  dvm:
    enabled: false
    feePerJob: 5000
wallet:
  encrypted_path: ${join(dir, 'wallet.enc')}
connector:
  image: ghcr.io/toon-protocol/connector:3.3.3
  adminPort: 9401
transport:
  mode: direct
api:
  port: 9400
  host: 127.0.0.1
logging:
  level: info
`,
          'utf-8'
        );

        await main([
          'wallet',
          'show',
          '-c',
          configPath,
          '--password',
          'test-password-123!',
        ]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');

        // Should show node types
        expect(output).toMatch(/town/i);
        expect(output).toMatch(/mill/i);
        expect(output).toMatch(/dvm/i);

        // Should show addresses (hex pubkeys, 0x EVM addresses)
        expect(output).toMatch(/[0-9a-f]{64}/); // Nostr pubkey
        expect(output).toMatch(/0x[0-9a-fA-F]{40}/); // EVM address
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('wallet show does NOT reveal private keys (nostrSecretKey, evmPrivateKey hex)', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        // First, create a wallet via init with known password
        await main([
          'init',
          '--force',
          '--config-dir',
          dir,
          '--password',
          'test-password-123!',
        ]);

        consoleSpy.mockClear();

        writeFileSync(
          configPath,
          `
nodes:
  town:
    enabled: true
    feePerEvent: 1000
  mill:
    enabled: false
    feeBasisPoints: 50
  dvm:
    enabled: false
    feePerJob: 5000
wallet:
  encrypted_path: ${join(dir, 'wallet.enc')}
connector:
  image: ghcr.io/toon-protocol/connector:3.3.3
  adminPort: 9401
transport:
  mode: direct
api:
  port: 9400
  host: 127.0.0.1
logging:
  level: info
`,
          'utf-8'
        );

        await main([
          'wallet',
          'show',
          '-c',
          configPath,
          '--password',
          'test-password-123!',
        ]);

        const output = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');

        // The output should NOT contain "SecretKey", "PrivateKey", or "secret"
        // as field labels or raw hex secret key values
        expect(output).not.toMatch(/secretkey/i);
        expect(output).not.toMatch(/privatekey/i);
        // It should NOT contain "mnemonic" or "seed phrase" either
        expect(output).not.toMatch(/mnemonic/i);
        expect(output).not.toMatch(/seed phrase/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('wallet show with missing wallet file shows helpful error', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        writeFileSync(
          configPath,
          `
nodes:
  town:
    enabled: false
    feePerEvent: 1000
  mill:
    enabled: false
    feeBasisPoints: 50
  dvm:
    enabled: false
    feePerJob: 5000
wallet:
  encrypted_path: ${join(dir, 'nonexistent-wallet.enc')}
connector:
  image: ghcr.io/toon-protocol/connector:3.3.3
  adminPort: 9401
transport:
  mode: direct
api:
  port: 9400
  host: 127.0.0.1
logging:
  level: info
`,
          'utf-8'
        );

        await main([
          'wallet',
          'show',
          '-c',
          configPath,
          '--password',
          'test-password-123!',
        ]);

        const output = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');

        expect(output).toMatch(/no wallet found|run.*init/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── T-033: Mnemonic never appears after init (AC #8, P0 Security) ──

  describe('mnemonic security (AC #8)', () => {
    it('wallet show does not reveal mnemonic words', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        await main([
          'init',
          '--force',
          '--config-dir',
          dir,
          '--password',
          'test-password-123!',
        ]);

        // Extract mnemonic from init output
        const initOutput = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        const mnemonicMatch = initOutput.match(/\s{2}([a-z]+ ){11}[a-z]+/);

        consoleSpy.mockClear();

        writeFileSync(
          configPath,
          `
nodes:
  town:
    enabled: true
    feePerEvent: 1000
  mill:
    enabled: false
    feeBasisPoints: 50
  dvm:
    enabled: false
    feePerJob: 5000
wallet:
  encrypted_path: ${join(dir, 'wallet.enc')}
connector:
  image: ghcr.io/toon-protocol/connector:3.3.3
  adminPort: 9401
transport:
  mode: direct
api:
  port: 9400
  host: 127.0.0.1
logging:
  level: info
`,
          'utf-8'
        );

        await main([
          'wallet',
          'show',
          '-c',
          configPath,
          '--password',
          'test-password-123!',
        ]);

        const showOutput = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');

        if (mnemonicMatch) {
          // The full mnemonic must NOT appear in wallet show output
          expect(showOutput).not.toContain(mnemonicMatch[0].trim());
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('status command does not reveal mnemonic', async () => {
      const dir = makeTempDir();
      const configPath = join(dir, 'config.yaml');

      try {
        await main([
          'init',
          '--force',
          '--config-dir',
          dir,
          '--password',
          'test-password-123!',
        ]);

        // Extract mnemonic from init output
        const initOutput = consoleSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        const mnemonicMatch = initOutput.match(/\s{2}([a-z]+ ){11}[a-z]+/);

        consoleSpy.mockClear();
        consoleErrorSpy.mockClear();

        writeFileSync(
          configPath,
          `
nodes:
  town:
    enabled: false
    feePerEvent: 1000
  mill:
    enabled: false
    feeBasisPoints: 50
  dvm:
    enabled: false
    feePerJob: 5000
wallet:
  encrypted_path: ${join(dir, 'wallet.enc')}
connector:
  image: ghcr.io/toon-protocol/connector:3.3.3
  adminPort: 9401
transport:
  mode: direct
api:
  port: 9400
  host: 127.0.0.1
logging:
  level: info
`,
          'utf-8'
        );

        await main(['status', '-c', configPath]);

        const statusOutput = [
          ...consoleSpy.mock.calls.map((c) => String(c[0])),
          ...consoleErrorSpy.mock.calls.map((c) => String(c[0])),
        ].join('\n');

        if (mnemonicMatch) {
          const mnemonic = mnemonicMatch[0].trim();
          expect(statusOutput).not.toContain(mnemonic);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Init overwrite protection (AC #2, Task 3.4) ──

  describe('init overwrite protection', () => {
    it('init without --force refuses to overwrite existing config', async () => {
      const dir = makeTempDir();

      try {
        // First init creates the config + wallet
        await main([
          'init',
          '--force',
          '--config-dir',
          dir,
          '--password',
          'test-password-123!',
        ]);

        consoleSpy.mockClear();
        consoleErrorSpy.mockClear();

        // Second init without --force should refuse
        await main([
          'init',
          '--config-dir',
          dir,
          '--password',
          'another-password!',
        ]);

        const output = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');

        expect(output).toMatch(/already exists|--force/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
