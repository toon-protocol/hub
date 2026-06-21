/**
 * CLI tests for `hub credits buy` / `hub credits balance`
 * (epic-49, Phase 2).
 *
 * Mocks @ardrive/turbo-sdk/node so we never hit the network. Verifies:
 *   - argv parsing + token validation
 *   - --quote-only short-circuits topUpWithTokens
 *   - --yes skips the confirmation prompt
 *   - prompt-then-no aborts with exit 1
 *   - missing password exits 1
 *   - happy-path balance reports winc + capacity hint
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import type * as NodeReadline from 'node:readline';
import { main } from './cli.js';
import { WalletManager } from './wallet/manager.js';

// Phase 2 follow-up: `handleCreditsBuy` now calls `wallet.ensureArweaveKey('dvm')`
// to auto-route credits to the DVM's Arweave address. The real call does RSA-4096
// derivation (5–30s) which would blow these unit-test budgets. Stub the AR side
// of WalletManager and supplement getNodeKeys with a stub arweaveAddress.
const STUB_AR_JWK = {
  kty: 'RSA',
  n: 'stub-n',
  e: 'AQAB',
  d: 'stub-d',
  p: 'stub-p',
  q: 'stub-q',
  dp: 'stub-dp',
  dq: 'stub-dq',
  qi: 'stub-qi',
};
const STUB_AR_ADDRESS = 'stub-arweave-address-base64url';
vi.spyOn(WalletManager.prototype, 'ensureArweaveKey').mockResolvedValue(
  STUB_AR_JWK as never
);
vi.spyOn(WalletManager.prototype, 'getArweaveJwk').mockReturnValue(
  STUB_AR_JWK as never
);
const originalGetNodeKeys = WalletManager.prototype.getNodeKeys;
vi.spyOn(WalletManager.prototype, 'getNodeKeys').mockImplementation(function (
  this: WalletManager,
  nodeType
) {
  const keys = originalGetNodeKeys.call(this, nodeType);
  return { ...keys, arweaveAddress: STUB_AR_ADDRESS };
});

// ── Mock node:readline so we can drive the y/N prompt deterministically ──

// Channel to override the next answer per test. Default to "y" so the prompt
// proceeds when a test doesn't care. Tests that exercise the abort path
// set this to "n" before invoking `main`.
let nextPromptAnswer = 'y';

vi.mock('node:readline', async () => {
  const actual = await vi.importActual<NodeReadline>('node:readline');
  return {
    ...actual,
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => cb(nextPromptAnswer),
      close: () => {},
      once: () => {},
    }),
  };
});

// ── Mock dockerode (same pattern as cli.test.ts) ───────────────────────────

vi.mock('dockerode', () => {
  return {
    default: class MockDocker {
      createContainer() {
        return Promise.resolve({});
      }
      getContainer() {
        return {};
      }
      listContainers() {
        return Promise.resolve([]);
      }
      createNetwork() {
        return Promise.resolve({});
      }
      listNetworks() {
        return Promise.resolve([]);
      }
      getNetwork() {
        return {};
      }
      pull() {
        return Promise.resolve({ pipe: vi.fn() });
      }
      listImages() {
        return Promise.resolve([]);
      }
      modem = {
        followProgress: vi.fn(),
      };
    },
  };
});

// ── Mock @ardrive/turbo-sdk/node ───────────────────────────────────────────

const mockGetWincForToken = vi.fn();
const mockTopUpWithTokens = vi.fn();
const mockGetBalance = vi.fn();
const mockAuthenticated = vi.fn();

vi.mock('@ardrive/turbo-sdk/node', () => {
  class ArweaveSigner {
    constructor(public jwk: unknown) {}
  }
  class EthereumSigner {
    constructor(public hex: string) {}
  }
  class HexSolanaSigner {
    constructor(public hex: string) {}
  }
  return {
    ArweaveSigner,
    EthereumSigner,
    HexSolanaSigner,
    TurboFactory: {
      authenticated: (...args: unknown[]) => mockAuthenticated(...args),
    },
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `hub-credits-cli-test-${randomBytes(8).toString('hex')}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const WALLET_PASSWORD = 'credits-test-pw';

function configYamlFor(walletPath: string): string {
  return `
nodes:
  town:
    enabled: false
    feePerEvent: 1000
  mill:
    enabled: false
    feeBasisPoints: 50
  dvm:
    enabled: true
    feePerJob: 5000
wallet:
  encrypted_path: ${walletPath}
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
`;
}

async function initWallet(dir: string): Promise<{
  configPath: string;
  walletPath: string;
}> {
  await main([
    'init',
    '--force',
    '--config-dir',
    dir,
    '--password',
    WALLET_PASSWORD,
  ]);
  const walletPath = join(dir, 'wallet.enc');
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, configYamlFor(walletPath), 'utf-8');
  return { configPath, walletPath };
}

// ── Test setup ─────────────────────────────────────────────────────────────

describe('credits CLI commands', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetWincForToken.mockReset();
    mockTopUpWithTokens.mockReset();
    mockGetBalance.mockReset();
    mockAuthenticated.mockReset();
    mockAuthenticated.mockImplementation(() => ({
      getWincForToken: mockGetWincForToken,
      topUpWithTokens: mockTopUpWithTokens,
      getBalance: mockGetBalance,
    }));
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  // ── argv validation ────────────────────────────────────────────────────

  describe('credits buy — argv validation', () => {
    it('requires --token + --amount', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        await main([
          'credits',
          'buy',
          '-c',
          configPath,
          '--password',
          WALLET_PASSWORD,
        ]);
        const err = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(err).toMatch(/Usage: hub credits buy/);
        expect(process.exitCode).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects unknown --token', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        await main([
          'credits',
          'buy',
          '--token',
          'btc',
          '--amount',
          '1',
          '-c',
          configPath,
          '--password',
          WALLET_PASSWORD,
        ]);
        const err = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(err).toMatch(/Unknown token 'btc'/);
        expect(process.exitCode).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects invalid --fee-multiplier', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        await main([
          'credits',
          'buy',
          '--token',
          'sol',
          '--amount',
          '0.001',
          '--fee-multiplier',
          'NaN',
          '-c',
          configPath,
          '--password',
          WALLET_PASSWORD,
        ]);
        const err = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(err).toMatch(/--fee-multiplier must be a positive number/);
        expect(process.exitCode).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── password sourcing ──────────────────────────────────────────────────

  describe('credits buy — password sourcing', () => {
    it('exits 1 when no password source is available (non-TTY)', async () => {
      const dir = makeTempDir();
      const origEnv = process.env['TOWNHOUSE_WALLET_PASSWORD'];
      delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
      // Force isTTY=false to avoid the interactive prompt path.
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });
      try {
        const { configPath } = await initWallet(dir);
        await main([
          'credits',
          'buy',
          '--token',
          'sol',
          '--amount',
          '0.001',
          '--quote-only',
          '-c',
          configPath,
        ]);
        const err = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(err).toMatch(/Wallet password required/);
        expect(process.exitCode).toBe(1);
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', {
          value: origIsTTY,
          configurable: true,
        });
        if (origEnv !== undefined) {
          process.env['TOWNHOUSE_WALLET_PASSWORD'] = origEnv;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('accepts password via TOWNHOUSE_WALLET_PASSWORD env var', async () => {
      const dir = makeTempDir();
      const origEnv = process.env['TOWNHOUSE_WALLET_PASSWORD'];
      try {
        const { configPath } = await initWallet(dir);
        process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_PASSWORD;
        mockGetWincForToken.mockResolvedValue({
          winc: '1000000',
          actualTokenAmount: '1000000',
          equivalentWincTokenAmount: '1000000',
        });

        await main([
          'credits',
          'buy',
          '--token',
          'sol',
          '--amount',
          '0.001',
          '--quote-only',
          '-c',
          configPath,
        ]);

        expect(mockGetWincForToken).toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
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

  // ── --quote-only path ──────────────────────────────────────────────────

  describe('credits buy — --quote-only', () => {
    it('prints quote, does not submit, exit 0', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        mockGetWincForToken.mockResolvedValue({
          winc: '6100000000000', // ~10 MB capacity
          actualTokenAmount: '1000000',
          equivalentWincTokenAmount: '6100000000000',
        });

        await main([
          'credits',
          'buy',
          '--token',
          'sol',
          '--amount',
          '0.001',
          '--quote-only',
          '-c',
          configPath,
          '--password',
          WALLET_PASSWORD,
        ]);

        const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(out).toContain('Quote:');
        expect(out).toContain('winc');
        expect(out).toMatch(/~\d+\s*[KMG]?B/); // capacity hint
        expect(out).toContain('Quote-only');
        expect(mockTopUpWithTokens).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('--json emits one quote object and no human stdout (P2b)', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        mockGetWincForToken.mockResolvedValue({
          winc: '6100000000000',
          actualTokenAmount: '1000000',
          equivalentWincTokenAmount: '6100000000000',
        });

        await main([
          'credits',
          'buy',
          '--token',
          'sol',
          '--amount',
          '0.001',
          '--quote-only',
          '-c',
          configPath,
          '--password',
          WALLET_PASSWORD,
          '--json',
        ]);

        // Only the JSON object (filter out init's human banner from initWallet).
        const logged = consoleLogSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.trim().startsWith('{'));
        expect(logged).toHaveLength(1);
        const obj = JSON.parse(logged[0]!) as { kind: string; winc: string };
        expect(obj.kind).toBe('quote');
        expect(obj.winc).toBe('6100000000000');
        // Human progress writes are suppressed in --json mode.
        const human = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(human).not.toContain('Quote:');
        expect(mockTopUpWithTokens).not.toHaveBeenCalled();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── --yes skips confirmation ───────────────────────────────────────────

  describe('credits buy — --yes', () => {
    it('skips the prompt and submits', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        mockGetWincForToken.mockResolvedValue({
          winc: '1000000000',
          actualTokenAmount: '1000000',
          equivalentWincTokenAmount: '1000000000',
        });
        mockTopUpWithTokens.mockResolvedValue({
          winc: '1000000000',
          id: 'sol-tx-abc',
          status: 'pending',
          token: 'solana',
          quantity: '1000000',
          owner: 'owner',
          target: 'target',
        });

        await main([
          'credits',
          'buy',
          '--token',
          'sol',
          '--amount',
          '0.001',
          '--yes',
          '-c',
          configPath,
          '--password',
          WALLET_PASSWORD,
        ]);

        expect(mockTopUpWithTokens).toHaveBeenCalledOnce();
        const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(out).toContain('sol-tx-abc');
        expect(out).toContain('Done.');
        expect(process.exitCode).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── prompt-then-no aborts ──────────────────────────────────────────────

  describe('credits buy — prompt abort', () => {
    it('exits 1 without submitting when user answers no', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        mockGetWincForToken.mockResolvedValue({
          winc: '1000000000',
          actualTokenAmount: '1000000',
          equivalentWincTokenAmount: '1000000000',
        });

        nextPromptAnswer = 'n';
        try {
          await main([
            'credits',
            'buy',
            '--token',
            'sol',
            '--amount',
            '0.001',
            '-c',
            configPath,
            '--password',
            WALLET_PASSWORD,
          ]);

          expect(mockTopUpWithTokens).not.toHaveBeenCalled();
          const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
          expect(out).toContain('Aborted');
          expect(process.exitCode).toBe(1);
        } finally {
          nextPromptAnswer = 'y';
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── credits balance ────────────────────────────────────────────────────

  describe('credits balance', () => {
    it('requires --token', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        await main([
          'credits',
          'balance',
          '-c',
          configPath,
          '--password',
          WALLET_PASSWORD,
        ]);
        const err = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(err).toMatch(/Usage: hub credits balance/);
        expect(process.exitCode).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('prints winc + capacity hint on happy path', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        mockGetBalance.mockResolvedValue({
          winc: '610000000000', // ~1 MB
          controlledWinc: '610000000000',
          effectiveBalance: '610000000000',
          receivedApprovals: [],
          givenApprovals: [],
        });

        await main([
          'credits',
          'balance',
          '--token',
          'sol',
          '-c',
          configPath,
          '--password',
          WALLET_PASSWORD,
        ]);

        const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(out).toMatch(/Balance: 610000000000 winc/);
        expect(out).toMatch(/~1\s?MB/);
        expect(process.exitCode).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('--json emits one balance object (P2b)', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        mockGetBalance.mockResolvedValue({
          winc: '610000000000',
          controlledWinc: '610000000000',
          effectiveBalance: '610000000000',
          receivedApprovals: [],
          givenApprovals: [],
        });

        await main([
          'credits',
          'balance',
          '--token',
          'sol',
          '-c',
          configPath,
          '--password',
          WALLET_PASSWORD,
          '--json',
        ]);

        const logged = consoleLogSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.trim().startsWith('{'));
        expect(logged).toHaveLength(1);
        const obj = JSON.parse(logged[0]!) as { token: string; winc: string };
        expect(obj.token).toBe('sol');
        expect(obj.winc).toBe('610000000000');
        expect(process.exitCode).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('surfaces Turbo network errors with non-zero exit', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        mockGetBalance.mockRejectedValue(new Error('ECONNREFUSED'));

        await main([
          'credits',
          'balance',
          '--token',
          'sol',
          '-c',
          configPath,
          '--password',
          WALLET_PASSWORD,
        ]);

        const err = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(err).toMatch(/credits balance failed/);
        expect(process.exitCode).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── unknown subcommand ─────────────────────────────────────────────────

  describe('credits — unknown subcommand', () => {
    it('prints usage and exits 1', async () => {
      const dir = makeTempDir();
      try {
        const { configPath } = await initWallet(dir);
        await main(['credits', 'bogus', '-c', configPath]);
        const err = consoleErrorSpy.mock.calls
          .map((c) => String(c[0]))
          .join('\n');
        expect(err).toMatch(/hub credits buy/);
        expect(err).toMatch(/hub credits balance/);
        expect(process.exitCode).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
