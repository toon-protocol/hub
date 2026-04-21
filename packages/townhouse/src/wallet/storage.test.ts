/**
 * Unit Tests: Wallet Storage (Story 21.4)
 *
 * These tests verify:
 * - AC #5: Wallet state persisted in encrypted_path with correct permissions
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { saveWallet, loadWallet } from './storage.js';
import type { EncryptedWallet } from './types.js';

/** Create a unique temp dir for each test */
function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `townhouse-wallet-test-${randomBytes(8).toString('hex')}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Factory: create a mock encrypted wallet object */
function createMockEncryptedWallet(): EncryptedWallet {
  return {
    salt: Buffer.from(randomBytes(32)).toString('base64'),
    iv: Buffer.from(randomBytes(12)).toString('base64'),
    ciphertext: Buffer.from(randomBytes(64)).toString('base64'),
    tag: Buffer.from(randomBytes(16)).toString('base64'),
  };
}

describe('Wallet Storage', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  // ── Save/Load roundtrip ──

  describe('saveWallet() + loadWallet() roundtrip', () => {
    it('saves and loads encrypted wallet data correctly', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const walletPath = join(dir, 'wallet.enc');
      const wallet = createMockEncryptedWallet();

      await saveWallet(walletPath, wallet);
      const result = await loadWallet(walletPath);

      expect(result).not.toBeNull();
      expect(result!.wallet.salt).toBe(wallet.salt);
      expect(result!.wallet.iv).toBe(wallet.iv);
      expect(result!.wallet.ciphertext).toBe(wallet.ciphertext);
      expect(result!.wallet.tag).toBe(wallet.tag);
    });
  });

  // ── File permissions (T-028 equivalent) ──

  describe('file permissions', () => {
    it('wallet file is created with 0o600 permissions (owner-only)', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const walletPath = join(dir, 'wallet.enc');
      const wallet = createMockEncryptedWallet();

      await saveWallet(walletPath, wallet);

      const stats = statSync(walletPath);
      const permissions = stats.mode & 0o777;
      expect(permissions).toBe(0o600);
    });
  });

  // ── Missing file returns null ──

  describe('loadWallet() with missing file', () => {
    it('returns null when wallet file does not exist', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const walletPath = join(dir, 'nonexistent-wallet.enc');

      const result = await loadWallet(walletPath);

      expect(result).toBeNull();
    });
  });

  // ── Parent directory creation ──

  describe('saveWallet() creates parent directory', () => {
    it('creates parent directories if they do not exist', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const nestedPath = join(dir, 'nested', 'deep', 'wallet.enc');
      const wallet = createMockEncryptedWallet();

      await saveWallet(nestedPath, wallet);

      expect(existsSync(nestedPath)).toBe(true);
    });
  });

  // ── Permissions warning ──

  describe('permissions warning', () => {
    it('no warning when permissions are 0o600', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const walletPath = join(dir, 'wallet.enc');
      const wallet = createMockEncryptedWallet();

      await saveWallet(walletPath, wallet);
      const result = await loadWallet(walletPath);

      expect(result).not.toBeNull();
      expect(result!.permissionsWarning).toBeUndefined();
    });

    it('returns warning when file permissions are too open (world-readable)', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const walletPath = join(dir, 'wallet.enc');
      const wallet = createMockEncryptedWallet();

      await saveWallet(walletPath, wallet);

      // Manually loosen permissions to simulate insecure state
      const { chmodSync } = await import('node:fs');
      chmodSync(walletPath, 0o644);

      const result = await loadWallet(walletPath);

      expect(result).not.toBeNull();
      expect(result!.permissionsWarning).toBeDefined();
      expect(result!.permissionsWarning).toMatch(/permissions.*644.*should be 600/);
    });
  });
});
