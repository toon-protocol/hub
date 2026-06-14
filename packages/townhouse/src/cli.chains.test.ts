/**
 * `townhouse chains <list|add|remove>` — multi-chain settlement config CLI.
 * No Docker involved: these edit config.chainProviders on disk via saveConfig
 * (which validates), so the tests run main() against a temp config dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { main } from './cli.js';
import { loadConfig } from './config/loader.js';

function makeTmp(): string {
  const d = join(
    tmpdir(),
    `townhouse-chains-${randomBytes(6).toString('hex')}`
  );
  mkdirSync(d, { recursive: true });
  return d;
}

describe('townhouse chains', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
  });

  async function initConfig(dir: string): Promise<string> {
    await main(['init', '--force', '--config-dir', dir, '--password', 'pw']);
    return join(dir, 'config.yaml');
  }

  it('adds an EVM settlement chain and persists it', async () => {
    const dir = makeTmp();
    try {
      const cfg = await initConfig(dir);
      await main([
        'chains',
        'add',
        '--chain-type',
        'evm',
        '--chain-id',
        'evm:base:8453',
        '--rpc-url',
        'https://mainnet.base.org',
        '--registry',
        '0xabc',
        '--token-address',
        '0xdef',
        '--key-id',
        '0x123',
        '-c',
        cfg,
      ]);
      const config = loadConfig(cfg);
      expect(config.chainProviders).toHaveLength(1);
      const e = config.chainProviders?.[0];
      expect(e?.chainType).toBe('evm');
      if (e?.chainType === 'evm') {
        expect(e.registryAddress).toBe('0xabc');
        expect(e.rpcUrl).toBe('https://mainnet.base.org');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds Solana and Mina settlement chains', async () => {
    const dir = makeTmp();
    try {
      const cfg = await initConfig(dir);
      await main([
        'chains',
        'add',
        '--chain-type',
        'solana',
        '--chain-id',
        'solana:devnet',
        '--rpc-url',
        'https://api.devnet.solana.com',
        '--program-id',
        'Prog1',
        '--key-id',
        'k',
        '-c',
        cfg,
      ]);
      await main([
        'chains',
        'add',
        '--chain-type',
        'mina',
        '--chain-id',
        'mina:devnet',
        '--graphql-url',
        'https://m/graphql',
        '--zkapp',
        'B62qZ',
        '-c',
        cfg,
      ]);
      const config = loadConfig(cfg);
      expect(config.chainProviders).toHaveLength(2);
      const types = config.chainProviders?.map((p) => p.chainType);
      expect(types).toContain('solana');
      expect(types).toContain('mina');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upserts by chainId (no duplicate entries)', async () => {
    const dir = makeTmp();
    try {
      const cfg = await initConfig(dir);
      const add = (rpc: string) =>
        main([
          'chains',
          'add',
          '--chain-type',
          'evm',
          '--chain-id',
          'evm:base:8453',
          '--rpc-url',
          rpc,
          '--registry',
          '0xa',
          '--token-address',
          '0xb',
          '--key-id',
          '0xc',
          '-c',
          cfg,
        ]);
      await add('https://one');
      await add('https://two');
      const config = loadConfig(cfg);
      expect(config.chainProviders).toHaveLength(1);
      const e = config.chainProviders?.[0];
      if (e?.chainType === 'evm') expect(e.rpcUrl).toBe('https://two');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors (exit 1) when a required field is missing', async () => {
    const dir = makeTmp();
    try {
      const cfg = await initConfig(dir);
      await main([
        'chains',
        'add',
        '--chain-type',
        'evm',
        '--chain-id',
        'evm:base:8453',
        '--rpc-url',
        'https://x',
        '-c',
        cfg,
      ]);
      expect(process.exitCode).toBe(1);
      const out = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('--registry is required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chains add --json emits a parseable JSON object (not human text)', async () => {
    const dir = makeTmp();
    try {
      const cfg = await initConfig(dir);
      await main([
        'chains',
        'add',
        '--chain-type',
        'evm',
        '--chain-id',
        'evm:base:84532',
        '--rpc-url',
        'https://sepolia.base.org',
        '--registry',
        '0xabc',
        '--token-address',
        '0xdef',
        '--json',
        '-c',
        cfg,
      ]);
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      // No human "Added ..." / "Apply with:" lines under --json.
      expect(lines.some((l) => l.startsWith('Added '))).toBe(false);
      expect(lines.some((l) => l.startsWith('Apply with:'))).toBe(false);
      // Exactly one machine-readable JSON object on stdout.
      const jsonLine = lines.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine as string);
      expect(parsed).toMatchObject({
        added: true,
        chainType: 'evm',
        chainId: 'evm:base:84532',
      });
      // Side effect still happened.
      const config = loadConfig(cfg);
      expect(config.chainProviders).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chains add without --json still prints the human line', async () => {
    const dir = makeTmp();
    try {
      const cfg = await initConfig(dir);
      await main([
        'chains',
        'add',
        '--chain-type',
        'evm',
        '--chain-id',
        'evm:base:8453',
        '--rpc-url',
        'https://mainnet.base.org',
        '--registry',
        '0xabc',
        '--token-address',
        '0xdef',
        '-c',
        cfg,
      ]);
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.startsWith('Added evm'))).toBe(true);
      // And no stray JSON object on stdout in human mode.
      expect(lines.some((l) => l.trim().startsWith('{'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chains remove --json emits a parseable JSON object', async () => {
    const dir = makeTmp();
    try {
      const cfg = await initConfig(dir);
      await main([
        'chains',
        'add',
        '--chain-type',
        'solana',
        '--chain-id',
        'solana:devnet',
        '--rpc-url',
        'https://s',
        '--program-id',
        'P',
        '--key-id',
        'k',
        '-c',
        cfg,
      ]);
      logSpy.mockClear();
      await main(['chains', 'remove', 'solana:devnet', '--json', '-c', cfg]);
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.startsWith('Removed '))).toBe(false);
      const jsonLine = lines.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      expect(JSON.parse(jsonLine as string)).toMatchObject({
        removed: true,
        chainId: 'solana:devnet',
      });
      const config = loadConfig(cfg);
      expect(config.chainProviders ?? []).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes a chain by chainId', async () => {
    const dir = makeTmp();
    try {
      const cfg = await initConfig(dir);
      await main([
        'chains',
        'add',
        '--chain-type',
        'solana',
        '--chain-id',
        'solana:devnet',
        '--rpc-url',
        'https://s',
        '--program-id',
        'P',
        '--key-id',
        'k',
        '-c',
        cfg,
      ]);
      await main(['chains', 'remove', 'solana:devnet', '-c', cfg]);
      const config = loadConfig(cfg);
      expect(config.chainProviders ?? []).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
