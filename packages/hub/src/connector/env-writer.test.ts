/**
 * Tests for writeHsNodeEnvFile — the compose/.env writer that feeds the node
 * containers their network-mode chain env.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHsNodeEnvFile } from './env-writer.js';
import { getDefaultConfig } from '../config/defaults.js';
import type { HubConfig } from '../config/schema.js';

describe('writeHsNodeEnvFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'th-envwriter-'));
    // materializeComposeTemplate normally creates compose/ — emulate it.
    mkdirSync(join(dir, 'compose'), { recursive: true, mode: 0o700 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function cfg(over: Partial<HubConfig> = {}): HubConfig {
    return { ...getDefaultConfig(), ...over };
  }

  it('writes compose/.env with the default (testnet) Base Sepolia + Solana endpoints', () => {
    // Default (no network) resolves to the settlement-complete testnet tier so
    // an operator who omits --network gets a settlement-ready node, not a
    // relay-only/dev fallback (base-mainnet has no deployed TOON contracts).
    const { envPath, keys } = writeHsNodeEnvFile(dir, cfg());
    expect(envPath).toBe(join(dir, 'compose', '.env'));
    const body = readFileSync(envPath, 'utf-8');
    expect(body).toContain('EVM_CHAIN=base-sepolia');
    expect(body).toContain('EVM_CHAIN_ID=84532');
    expect(body).toContain('SOLANA_RPC_URL=https://api.devnet.solana.com');
    expect(keys).toContain('EVM_CHAIN');
    // Never a localhost RPC (the cause of the disconnected boot-loop).
    expect(body).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it('honors explicit network=mainnet (relay-only Base mainnet endpoints)', () => {
    const { envPath } = writeHsNodeEnvFile(dir, cfg({ network: 'mainnet' }));
    const body = readFileSync(envPath, 'utf-8');
    expect(body).toContain('EVM_CHAIN=base-mainnet');
    expect(body).toContain('EVM_RPC_URL=https://mainnet.base.org');
    expect(body).toContain('EVM_CHAIN_ID=8453');
  });

  it('honors the configured network mode (testnet → Base Sepolia)', () => {
    const { envPath } = writeHsNodeEnvFile(dir, cfg({ network: 'testnet' }));
    const body = readFileSync(envPath, 'utf-8');
    expect(body).toContain('EVM_CHAIN=base-sepolia');
    expect(body).toContain('EVM_CHAIN_ID=84532');
  });

  it('writes the file 0o600 (chain config may carry sensitive endpoints)', () => {
    const { envPath } = writeHsNodeEnvFile(dir, cfg());
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('omits empty values (no blank KEY= lines)', () => {
    const body = readFileSync(
      writeHsNodeEnvFile(dir, cfg({ network: 'testnet' })).envPath,
      'utf-8'
    );
    // testnet Solana has no canonical USDC mint → key absent entirely.
    expect(body).not.toMatch(/^SOLANA_USDC_MINT=\s*$/m);
  });
});
