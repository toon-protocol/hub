/**
 * Unit Tests: WalletManager (Story 21.4)
 *
 * Test IDs map to test-design-epic-21.md scenarios T-023, T-024, T-029, T-030, T-031, T-034, T-035.
 *
 * These tests verify:
 * - AC #1: WalletManager implementing HD key derivation
 * - AC #3: Per-node HD derivation following BIP-44 paths
 * - AC #4: Nostr keypair + EVM address derived per node
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { WalletManager } from './manager.js';

const TEST_MNEMONIC_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const INVALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';

describe('WalletManager', () => {
  let manager: WalletManager;

  beforeEach(() => {
    manager = new WalletManager({ encryptedPath: '/tmp/test-wallet.enc' });
  });

  // ── T-023: BIP-39 mnemonic generation ──

  describe('generate()', () => {
    it('produces a valid 12-word BIP-39 mnemonic', () => {
      const result = manager.generate();

      expect(result.mnemonic).toBeDefined();
      const words = result.mnemonic.split(' ');
      expect(words).toHaveLength(12);
    });

    it('produces a WalletState with keys for all node types', () => {
      const result = manager.generate();

      expect(result.state).toBeDefined();
      expect(result.state.keys.town).toBeDefined();
      expect(result.state.keys.mill).toBeDefined();
      expect(result.state.keys.dvm).toBeDefined();
    });

    it('produces different keys per node type', () => {
      const { state } = manager.generate();
      expect(state.keys.town.nostrPubkey).not.toBe(state.keys.mill.nostrPubkey);
      expect(state.keys.mill.nostrPubkey).not.toBe(state.keys.dvm.nostrPubkey);
      expect(state.keys.town.evmAddress).not.toBe(state.keys.mill.evmAddress);
    });
  });

  // ── T-035: Import existing mnemonic (12 or 24 words) ──

  describe('fromMnemonic()', () => {
    it('accepts a valid 12-word mnemonic', () => {
      const state = manager.fromMnemonic(TEST_MNEMONIC_12);
      expect(state).toBeDefined();
      expect(state.keys.town.nostrPubkey).toBeDefined();
      expect(state.keys.town.nostrPubkey.length).toBe(64);
    });

    it('accepts a valid 24-word mnemonic', () => {
      const state = manager.fromMnemonic(TEST_MNEMONIC_24);
      expect(state).toBeDefined();
      expect(state.keys.town.nostrPubkey).toBeDefined();
      expect(state.keys.town.nostrPubkey.length).toBe(64);
    });

    // ── T-034: Invalid mnemonic rejected ──

    it('rejects an invalid mnemonic (wrong checksum)', () => {
      expect(() => manager.fromMnemonic(INVALID_MNEMONIC)).toThrow(
        /invalid.*mnemonic/i
      );
    });

    it('rejects a mnemonic with non-BIP39 words', () => {
      expect(() =>
        manager.fromMnemonic(
          'xyzzy plugh xyzzy plugh xyzzy plugh xyzzy plugh xyzzy plugh xyzzy plugh'
        )
      ).toThrow(/invalid.*mnemonic/i);
    });
  });

  // ── T-024: Per-node HD derivation produces distinct keys ──

  describe('getNodeKeys()', () => {
    it('produces distinct Nostr pubkeys for each node type', () => {
      manager.fromMnemonic(TEST_MNEMONIC_12);

      const townKeys = manager.getNodeKeys('town');
      const millKeys = manager.getNodeKeys('mill');
      const dvmKeys = manager.getNodeKeys('dvm');

      expect(townKeys.nostrPubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(millKeys.nostrPubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(dvmKeys.nostrPubkey).toMatch(/^[0-9a-f]{64}$/);

      // All three must be different (different account indices)
      expect(townKeys.nostrPubkey).not.toBe(millKeys.nostrPubkey);
      expect(townKeys.nostrPubkey).not.toBe(dvmKeys.nostrPubkey);
      expect(millKeys.nostrPubkey).not.toBe(dvmKeys.nostrPubkey);
    });

    it('produces distinct EVM addresses for each node type', () => {
      manager.fromMnemonic(TEST_MNEMONIC_12);

      const townKeys = manager.getNodeKeys('town');
      const millKeys = manager.getNodeKeys('mill');
      const dvmKeys = manager.getNodeKeys('dvm');

      expect(townKeys.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(millKeys.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(dvmKeys.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

      expect(townKeys.evmAddress).not.toBe(millKeys.evmAddress);
      expect(townKeys.evmAddress).not.toBe(dvmKeys.evmAddress);
      expect(millKeys.evmAddress).not.toBe(dvmKeys.evmAddress);
    });

    it('includes derivation paths in returned key info', () => {
      manager.fromMnemonic(TEST_MNEMONIC_12);

      const townKeys = manager.getNodeKeys('town');
      expect(townKeys.nostrDerivationPath).toBe("m/44'/1237'/0'/0/0");
      expect(townKeys.evmDerivationPath).toBe("m/44'/60'/0'/0/0");
    });

    it('returns correct key material types', () => {
      manager.fromMnemonic(TEST_MNEMONIC_12);

      const keys = manager.getNodeKeys('town');
      expect(keys.nostrSecretKey).toBeInstanceOf(Uint8Array);
      expect(keys.nostrSecretKey.length).toBe(32);
      expect(keys.evmPrivateKey).toBeInstanceOf(Uint8Array);
      expect(keys.evmPrivateKey.length).toBe(32);
    });

    it('throws if wallet not initialized', () => {
      expect(() => manager.getNodeKeys('town')).toThrow(/not initialized/i);
    });
  });

  // ── T-029: Deterministic derivation ──

  describe('deterministic derivation', () => {
    it('same mnemonic produces same keys on repeated calls', () => {
      const manager1 = new WalletManager({ encryptedPath: '/tmp/test1.enc' });
      manager1.fromMnemonic(TEST_MNEMONIC_12);
      const keys1 = manager1.getNodeKeys('town');

      const manager2 = new WalletManager({ encryptedPath: '/tmp/test2.enc' });
      manager2.fromMnemonic(TEST_MNEMONIC_12);
      const keys2 = manager2.getNodeKeys('town');

      expect(keys1.nostrPubkey).toBe(keys2.nostrPubkey);
      expect(keys1.evmAddress).toBe(keys2.evmAddress);
    });
  });

  // ── T-030: lock() zeros key material ──

  describe('lock()', () => {
    it('zeros all in-memory key material', () => {
      manager.fromMnemonic(TEST_MNEMONIC_12);

      const townKeys = manager.getNodeKeys('town');
      const secretRef = townKeys.nostrSecretKey;
      const evmRef = townKeys.evmPrivateKey;

      // Keys should be non-zero before lock
      expect(secretRef.some((b) => b !== 0)).toBe(true);
      expect(evmRef.some((b) => b !== 0)).toBe(true);

      manager.lock();

      // After lock, the Uint8Arrays should be all zeros
      expect(secretRef.every((b) => b === 0)).toBe(true);
      expect(evmRef.every((b) => b === 0)).toBe(true);
    });

    it('makes getNodeKeys() throw after lock', () => {
      manager.fromMnemonic(TEST_MNEMONIC_12);
      manager.lock();
      expect(() => manager.getNodeKeys('town')).toThrow(/not initialized/i);
    });

    it('is safe to call multiple times', () => {
      manager.fromMnemonic(TEST_MNEMONIC_12);
      manager.lock();
      manager.lock(); // Should not throw
    });
  });

  // ── getAllKeys() ──

  describe('getAllKeys()', () => {
    it('returns key info for all three node types', () => {
      manager.fromMnemonic(TEST_MNEMONIC_12);

      const allKeys = manager.getAllKeys();

      expect(allKeys).toHaveLength(3);
      const nodeTypes = allKeys.map((k) => k.nodeType);
      expect(nodeTypes).toContain('town');
      expect(nodeTypes).toContain('mill');
      expect(nodeTypes).toContain('dvm');
    });

    it('each key info contains nostrPubkey and evmAddress but not secrets', () => {
      manager.fromMnemonic(TEST_MNEMONIC_12);

      const allKeys = manager.getAllKeys();

      for (const keyInfo of allKeys) {
        expect(keyInfo.nostrPubkey).toBeDefined();
        expect(keyInfo.evmAddress).toBeDefined();
        expect(keyInfo.nostrDerivationPath).toBeDefined();
        expect(keyInfo.evmDerivationPath).toBeDefined();
        // NodeKeyInfo should NOT expose secret keys
        expect(
          (keyInfo as Record<string, unknown>)['nostrSecretKey']
        ).toBeUndefined();
        expect(
          (keyInfo as Record<string, unknown>)['evmPrivateKey']
        ).toBeUndefined();
      }
    });

    it('throws if wallet not initialized', () => {
      expect(() => manager.getAllKeys()).toThrow(/not initialized/i);
    });
  });

  // ── Derivation paths ──

  describe('derivation paths', () => {
    it('uses correct BIP-44 paths per node type', () => {
      manager.fromMnemonic(TEST_MNEMONIC_12);

      const town = manager.getNodeKeys('town');
      expect(town.nostrDerivationPath).toBe("m/44'/1237'/0'/0/0");
      expect(town.evmDerivationPath).toBe("m/44'/60'/0'/0/0");

      const mill = manager.getNodeKeys('mill');
      expect(mill.nostrDerivationPath).toBe("m/44'/1237'/1'/0/0");
      expect(mill.evmDerivationPath).toBe("m/44'/60'/1'/0/0");

      const dvm = manager.getNodeKeys('dvm');
      expect(dvm.nostrDerivationPath).toBe("m/44'/1237'/2'/0/0");
      expect(dvm.evmDerivationPath).toBe("m/44'/60'/2'/0/0");
    });
  });
});
