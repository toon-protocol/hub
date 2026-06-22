/**
 * CLI tests for `hub wallet show` (Phase 3 cards layout + flags) and
 * `hub wallet seed` (epic-49, Phase 3).
 *
 * Mocks `human-crypto-keys` so AR key derivation is fast — Phase 3 calls
 * `ensureArweaveKey('dvm')` from `wallet show`, and the underlying real
 * RSA-4096 keygen is 5–30s per run. The mock returns a deterministic-looking
 * PKCS#1 PEM so `ensureArweaveKey` resolves and the DVM card actually
 * surfaces an Arweave address (otherwise it degrades to `—`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as NodeReadline from 'node:readline';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, generateKeyPairSync } from 'node:crypto';

// ── Mock rsa-from-seed with a real (but unrelated to the seed) RSA-4096
//    key so wallet show's ensureArweaveKey('dvm') resolves quickly. Tests do
//    NOT depend on the AR address being deterministic w.r.t. the mnemonic —
//    they only assert it *appears* in the right places. ────────────────────

const cachedPem = (() => {
  // Generated once per worker, not per test (keygen is ~1s for RSA-4096).
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });
  return privateKey.export({ format: 'pem', type: 'pkcs1' }).toString();
})();

vi.mock('./wallet/rsa-from-seed.js', () => ({
  rsaPrivateKeyPemFromSeed: vi.fn(async () => cachedPem),
}));

// Mock dockerode the same way other CLI tests do.
vi.mock('dockerode', () => ({
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
}));

// Mock readline (matches the cli.credits.test.ts pattern) — Phase 3 doesn't
// use prompts but mocking keeps test runs deterministic across files.
vi.mock('node:readline', async () => {
  const actual = await vi.importActual<NodeReadline>('node:readline');
  return {
    ...actual,
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => cb('y'),
      close: () => {},
      once: () => {},
    }),
  };
});

import { main } from './cli.js';

const WALLET_PASSWORD = 'phase3-wallet-test-pw';

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `hub-cli-phase3-${randomBytes(8).toString('hex')}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function configYamlFor(walletPath: string): string {
  return `
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

async function initWallet(
  dir: string
): Promise<{ configPath: string; walletPath: string }> {
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

describe('wallet show (Phase 3 cards + flags)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('default cards layout shows npub for all three nodes, no hex', async () => {
    const dir = makeTempDir();
    try {
      const { configPath } = await initWallet(dir);
      consoleLogSpy.mockClear();

      await main([
        'wallet',
        'show',
        '-c',
        configPath,
        '--password',
        WALLET_PASSWORD,
      ]);

      const output = consoleLogSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');

      // Cards layout: one card per node, each headed by its uppercased name.
      expect(output).toMatch(/TOWN —/);
      expect(output).toMatch(/MILL —/);
      expect(output).toMatch(/DVM —/);

      // NIP-19 npub appears at least three times (one per node).
      const npubMatches = output.match(/npub1[a-z0-9]+/g) ?? [];
      expect(npubMatches.length).toBeGreaterThanOrEqual(3);

      // Hex Nostr pubkeys must NOT be present in default rendering. Note:
      // the Mill card legitimately shows a Mina hex address (also 64 chars),
      // so we cannot just regex any 64-hex run. Instead, the "hex: " label
      // (added under each npub when --hex is passed) must be absent.
      expect(output).not.toMatch(/hex:/);

      // Trailing tips block must be present and reference Phase 2's credits CLI.
      expect(output).toContain('hub wallet show --json');
      expect(output).toContain('hub wallet show --hex');
      expect(output).toContain('hub wallet show --paths');
      expect(output).toContain('hub credits buy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--hex adds raw hex lines under each Nostr npub without removing npub', async () => {
    const dir = makeTempDir();
    try {
      const { configPath } = await initWallet(dir);
      consoleLogSpy.mockClear();

      await main([
        'wallet',
        'show',
        '--hex',
        '-c',
        configPath,
        '--password',
        WALLET_PASSWORD,
      ]);

      const output = consoleLogSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');

      // Still rendering the cards.
      expect(output).toMatch(/npub1[a-z0-9]+/);
      // Hex pubkey lines should now appear (the "hex: " label).
      expect(output).toMatch(/hex: [0-9a-f]{64}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--paths adds derivation-path lines under each address', async () => {
    const dir = makeTempDir();
    try {
      const { configPath } = await initWallet(dir);
      consoleLogSpy.mockClear();

      await main([
        'wallet',
        'show',
        '--paths',
        '-c',
        configPath,
        '--password',
        WALLET_PASSWORD,
      ]);

      const output = consoleLogSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');

      // NIP-06 Nostr paths.
      expect(output).toMatch(/path: m\/44'\/1237'\/0'\/0\/0/);
      expect(output).toMatch(/path: m\/44'\/1237'\/1'\/0\/0/);
      expect(output).toMatch(/path: m\/44'\/1237'\/2'\/0\/0/);
      // BIP-44 EVM paths.
      expect(output).toMatch(/path: m\/44'\/60'\/0'\/0\/0/);
      expect(output).toMatch(/path: m\/44'\/60'\/2'\/0\/0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json emits parseable structured output with npub for every node', async () => {
    const dir = makeTempDir();
    try {
      const { configPath } = await initWallet(dir);
      consoleLogSpy.mockClear();

      await main([
        'wallet',
        'show',
        '--json',
        '-c',
        configPath,
        '--password',
        WALLET_PASSWORD,
      ]);

      // The JSON output is logged via a single console.log call.
      const jsonStr = consoleLogSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.trim().startsWith('{'))
        .join('');
      const parsed = JSON.parse(jsonStr) as Record<
        string,
        Record<string, unknown>
      >;

      // Top-level keys
      expect(parsed['town']).toBeDefined();
      expect(parsed['mill']).toBeDefined();
      expect(parsed['dvm']).toBeDefined();

      // Spot-check: town.nostr.npub starts with "npub1"
      const townNostr = parsed['town']?.['nostr'] as {
        npub: string;
        hex: string;
      };
      expect(townNostr.npub.startsWith('npub1')).toBe(true);
      // Hex is also exposed in --json (unconditional schema field).
      expect(townNostr.hex).toMatch(/^[0-9a-f]{64}$/);

      // EVM addresses present everywhere.
      expect((parsed['town']?.['evm'] as { address: string }).address).toMatch(
        /^0x[0-9a-fA-F]{40}$/
      );

      // SOL is present for all three nodes after Phase 1.
      expect(parsed['town']?.['sol']).toBeDefined();
      expect(parsed['mill']?.['sol']).toBeDefined();
      expect(parsed['dvm']?.['sol']).toBeDefined();

      // Mill has a mina entry; town/dvm do not.
      expect(parsed['mill']?.['mina']).toBeDefined();
      expect(parsed['town']?.['mina']).toBeUndefined();
      expect(parsed['dvm']?.['mina']).toBeUndefined();

      // DVM card surfaces the Arweave address after ensureArweaveKey resolves.
      const dvmAr = parsed['dvm']?.['arweave'] as
        | { address: string }
        | undefined;
      expect(dvmAr).toBeDefined();
      expect(dvmAr!.address).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DVM card shows an Arweave address after ensureArweaveKey resolves', async () => {
    const dir = makeTempDir();
    try {
      const { configPath } = await initWallet(dir);
      consoleLogSpy.mockClear();

      await main([
        'wallet',
        'show',
        '-c',
        configPath,
        '--password',
        WALLET_PASSWORD,
      ]);

      const output = consoleLogSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');

      // The DVM card includes an AR row label and an address that is not "—".
      expect(output).toMatch(/DVM —/);
      // Locate the DVM card by splitting on the box-drawing top border.
      const dvmCard = output.split(/(?=DVM —)/)[1] ?? '';
      expect(dvmCard).toMatch(/AR\s+[A-Za-z0-9_-]{43}/);
      // The "spends Arweave credits" purpose line lives under the SOL row.
      expect(dvmCard).toContain('spends Arweave credits');
      expect(dvmCard).toContain('signs Arweave uploads');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows SOL address for every node that has one (none should be —)', async () => {
    const dir = makeTempDir();
    try {
      const { configPath } = await initWallet(dir);
      consoleLogSpy.mockClear();

      await main([
        'wallet',
        'show',
        '--json',
        '-c',
        configPath,
        '--password',
        WALLET_PASSWORD,
      ]);

      const jsonStr = consoleLogSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.trim().startsWith('{'))
        .join('');
      const parsed = JSON.parse(jsonStr) as Record<
        string,
        Record<string, unknown>
      >;

      const townSol = parsed['town']?.['sol'] as { address: string };
      const millSol = parsed['mill']?.['sol'] as { address: string };
      const dvmSol = parsed['dvm']?.['sol'] as { address: string };
      // After Phase 1, all three nodes derive SOL — addresses must be present.
      expect(townSol.address).not.toBe('—');
      expect(millSol.address).not.toBe('—');
      expect(dvmSol.address).not.toBe('—');
      // Base58 addresses are at least 32 chars and have no `0` `O` `I` `l`.
      expect(townSol.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('wallet seed (Phase 3)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('without --confirm: refuses and exits 1 with the prompt-to-confirm message', async () => {
    const dir = makeTempDir();
    try {
      const { configPath } = await initWallet(dir);
      consoleLogSpy.mockClear();
      consoleErrorSpy.mockClear();

      await main([
        'wallet',
        'seed',
        '-c',
        configPath,
        '--password',
        WALLET_PASSWORD,
      ]);

      const err = consoleErrorSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(err).toMatch(/Re-run with --confirm/i);
      expect(process.exitCode).toBe(1);

      // No mnemonic words may be printed on the abort path.
      const out = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).not.toMatch(/\b([a-z]+ ){11}[a-z]+\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with --confirm + valid password: prints warning banner + mnemonic', async () => {
    const dir = makeTempDir();
    try {
      const { configPath } = await initWallet(dir);

      // Extract the mnemonic generated by `init` so we can verify the seed
      // command prints the same words.
      const initOutput = consoleLogSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      const mnemonicMatch = initOutput.match(/\s{2}([a-z]+ ){11}[a-z]+/);
      expect(mnemonicMatch).not.toBeNull();
      const expectedMnemonic = mnemonicMatch![0].trim();

      consoleLogSpy.mockClear();
      consoleErrorSpy.mockClear();

      await main([
        'wallet',
        'seed',
        '--confirm',
        '-c',
        configPath,
        '--password',
        WALLET_PASSWORD,
      ]);

      const out = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');

      // Warning banner is present (ASCII per CLAUDE.md emoji policy).
      expect(out).toMatch(/=+/);
      expect(out).toMatch(/Anyone who sees this seed/);
      expect(out).toMatch(/Anyone who records this terminal/);

      // The original mnemonic must appear verbatim.
      expect(out).toContain(expectedMnemonic);

      // Closing line references the init banner provenance.
      expect(out).toMatch(/hub init/);

      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with wrong password: exits 1 and does not leak mnemonic', async () => {
    const dir = makeTempDir();
    try {
      const { configPath } = await initWallet(dir);

      const initOutput = consoleLogSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      const mnemonicMatch = initOutput.match(/\s{2}([a-z]+ ){11}[a-z]+/);
      expect(mnemonicMatch).not.toBeNull();
      const realMnemonic = mnemonicMatch![0].trim();

      consoleLogSpy.mockClear();
      consoleErrorSpy.mockClear();

      await main([
        'wallet',
        'seed',
        '--confirm',
        '-c',
        configPath,
        '--password',
        'WRONG-PASSWORD-NOPE',
      ]);

      const out = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
      const err = consoleErrorSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');

      expect(err).toMatch(/Failed to decrypt wallet/);
      expect(process.exitCode).toBe(1);
      expect(out).not.toContain(realMnemonic);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
