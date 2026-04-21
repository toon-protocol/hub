/**
 * Unit Tests: Wallet Encryption/Decryption (Story 21.4)
 *
 * Test IDs map to test-design-epic-21.md scenario T-026.
 *
 * These tests verify:
 * - AC #5: Wallet state persisted encrypted at rest
 */

import { describe, it, expect } from 'vitest';

import { encryptWallet, decryptWallet } from './crypto.js';

describe('Wallet Crypto', () => {
  const testMnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const testPassword = 'test-password-strong-123!';

  // ── T-026: Encrypt/decrypt roundtrip ──

  describe('encryptWallet() + decryptWallet() roundtrip', () => {
    it('encrypts and decrypts back to original mnemonic', () => {
      const encrypted = encryptWallet(testMnemonic, testPassword);
      const decrypted = decryptWallet(encrypted, testPassword);

      expect(decrypted).toBe(testMnemonic);
    });

    it('encrypted output contains expected fields (salt, iv, ciphertext, tag)', () => {
      const encrypted = encryptWallet(testMnemonic, testPassword);

      expect(encrypted.salt).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.tag).toBeDefined();

      // All fields should be base64-encoded strings
      expect(typeof encrypted.salt).toBe('string');
      expect(typeof encrypted.iv).toBe('string');
      expect(typeof encrypted.ciphertext).toBe('string');
      expect(typeof encrypted.tag).toBe('string');
    });

    it('ciphertext is not the same as the original mnemonic', () => {
      const encrypted = encryptWallet(testMnemonic, testPassword);

      // Base64 decode the ciphertext and verify it does not contain the mnemonic
      const ciphertextBuf = Buffer.from(encrypted.ciphertext, 'base64');
      expect(ciphertextBuf.toString('utf8')).not.toContain(testMnemonic);
    });
  });

  describe('decryptWallet() with wrong password', () => {
    it('throws an error when wrong password is used', () => {
      const encrypted = encryptWallet(testMnemonic, testPassword);

      expect(() => decryptWallet(encrypted, 'wrong-password-456!')).toThrow(
        /decryption failed|wrong password/i
      );
    });
  });

  describe('different salts produce different ciphertexts', () => {
    it('encrypting the same mnemonic twice produces different ciphertexts', () => {
      const encrypted1 = encryptWallet(testMnemonic, testPassword);
      const encrypted2 = encryptWallet(testMnemonic, testPassword);

      // Salts should differ (random)
      expect(encrypted1.salt).not.toBe(encrypted2.salt);
      // Ciphertexts should differ due to different salts and IVs
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    });
  });

  describe('output format validation', () => {
    it('all fields are valid base64 strings', () => {
      const encrypted = encryptWallet(testMnemonic, testPassword);

      const base64Regex = /^[A-Za-z0-9+/]+=*$/;
      expect(encrypted.salt).toMatch(base64Regex);
      expect(encrypted.iv).toMatch(base64Regex);
      expect(encrypted.ciphertext).toMatch(base64Regex);
      expect(encrypted.tag).toMatch(base64Regex);
    });

    it('salt is 32 bytes (base64 encoded)', () => {
      const encrypted = encryptWallet(testMnemonic, testPassword);
      const saltBuf = Buffer.from(encrypted.salt, 'base64');
      expect(saltBuf.length).toBe(32);
    });

    it('iv is 12 bytes (base64 encoded) for AES-256-GCM', () => {
      const encrypted = encryptWallet(testMnemonic, testPassword);
      const ivBuf = Buffer.from(encrypted.iv, 'base64');
      expect(ivBuf.length).toBe(12);
    });

    it('tag is 16 bytes (base64 encoded) for GCM auth tag', () => {
      const encrypted = encryptWallet(testMnemonic, testPassword);
      const tagBuf = Buffer.from(encrypted.tag, 'base64');
      expect(tagBuf.length).toBe(16);
    });
  });
});
