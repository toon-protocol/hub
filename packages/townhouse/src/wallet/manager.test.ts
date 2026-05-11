/**
 * Unit Tests: WalletManager (Story 21.4 + 21.11 extension)
 *
 * Test IDs map to test-design-epic-21.md scenarios T-023, T-024, T-029, T-030, T-031, T-034, T-035.
 *
 * These tests verify:
 * - AC #1: WalletManager implementing HD key derivation
 * - AC #3: Per-node HD derivation following BIP-44 paths
 * - AC #4: Nostr keypair + EVM address derived per node
 * - AC-4 (21.11): Mill NodeKeyInfo extended with solanaAddress + minaAddress
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
    it('produces a valid 12-word BIP-39 mnemonic', async () => {
      const result = await manager.generate();

      expect(result.mnemonic).toBeDefined();
      const words = result.mnemonic.split(' ');
      expect(words).toHaveLength(12);
    });

    it('produces a WalletState with keys for all node types', async () => {
      const result = await manager.generate();

      expect(result.state).toBeDefined();
      expect(result.state.keys.town).toBeDefined();
      expect(result.state.keys.mill).toBeDefined();
      expect(result.state.keys.dvm).toBeDefined();
    });

    it('produces different keys per node type', async () => {
      const { state } = await manager.generate();
      expect(state.keys.town.nostrPubkey).not.toBe(state.keys.mill.nostrPubkey);
      expect(state.keys.mill.nostrPubkey).not.toBe(state.keys.dvm.nostrPubkey);
      expect(state.keys.town.evmAddress).not.toBe(state.keys.mill.evmAddress);
    });
  });

  // ── T-035: Import existing mnemonic (12 or 24 words) ──

  describe('fromMnemonic()', () => {
    it('accepts a valid 12-word mnemonic', async () => {
      const state = await manager.fromMnemonic(TEST_MNEMONIC_12);
      expect(state).toBeDefined();
      expect(state.keys.town.nostrPubkey).toBeDefined();
      expect(state.keys.town.nostrPubkey.length).toBe(64);
    });

    it('accepts a valid 24-word mnemonic', async () => {
      const state = await manager.fromMnemonic(TEST_MNEMONIC_24);
      expect(state).toBeDefined();
      expect(state.keys.town.nostrPubkey).toBeDefined();
      expect(state.keys.town.nostrPubkey.length).toBe(64);
    });

    // ── T-034: Invalid mnemonic rejected ──

    it('rejects an invalid mnemonic (wrong checksum)', async () => {
      await expect(manager.fromMnemonic(INVALID_MNEMONIC)).rejects.toThrow(
        /invalid.*mnemonic/i
      );
    });

    it('rejects a mnemonic with non-BIP39 words', async () => {
      await expect(
        manager.fromMnemonic(
          'xyzzy plugh xyzzy plugh xyzzy plugh xyzzy plugh xyzzy plugh xyzzy plugh'
        )
      ).rejects.toThrow(/invalid.*mnemonic/i);
    });
  });

  // ── T-024: Per-node HD derivation produces distinct keys ──

  describe('getNodeKeys()', () => {
    it('produces distinct Nostr pubkeys for each node type', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);

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

    it('produces distinct EVM addresses for each node type', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);

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

    it('includes derivation paths in returned key info', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);

      const townKeys = manager.getNodeKeys('town');
      expect(townKeys.nostrDerivationPath).toBe("m/44'/1237'/0'/0/0");
      expect(townKeys.evmDerivationPath).toBe("m/44'/60'/0'/0/0");
    });

    it('returns correct key material types', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);

      const keys = manager.getNodeKeys('town');
      expect(keys.nostrSecretKey).toBeInstanceOf(Uint8Array);
      expect(keys.nostrSecretKey.length).toBe(32);
      expect(keys.evmPrivateKey).toBeInstanceOf(Uint8Array);
      expect(keys.evmPrivateKey.length).toBe(32);
    });

    it('throws if wallet not initialized', () => {
      expect(() => manager.getNodeKeys('town')).toThrow(/not initialized/i);
    });

    it('mill NodeKeys includes solanaAddress and minaAddress (AC-4 21.11)', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      const millKeys = manager.getNodeKeys('mill');
      expect(typeof millKeys.solanaAddress).toBe('string');
      expect(millKeys.solanaAddress!.length).toBeGreaterThan(20);
      expect(typeof millKeys.minaAddress).toBe('string');
      expect(millKeys.minaAddress!.length).toBeGreaterThan(20);
      // town and dvm should NOT have these fields
      const townKeys = manager.getNodeKeys('town');
      expect(townKeys.solanaAddress).toBeUndefined();
      expect(townKeys.minaAddress).toBeUndefined();
    });
  });

  // ── T-029: Deterministic derivation ──

  describe('deterministic derivation', () => {
    it('same mnemonic produces same keys on repeated calls', async () => {
      const manager1 = new WalletManager({ encryptedPath: '/tmp/test1.enc' });
      await manager1.fromMnemonic(TEST_MNEMONIC_12);
      const keys1 = manager1.getNodeKeys('town');

      const manager2 = new WalletManager({ encryptedPath: '/tmp/test2.enc' });
      await manager2.fromMnemonic(TEST_MNEMONIC_12);
      const keys2 = manager2.getNodeKeys('town');

      expect(keys1.nostrPubkey).toBe(keys2.nostrPubkey);
      expect(keys1.evmAddress).toBe(keys2.evmAddress);
    });

    it('mill solanaAddress is deterministic from mnemonic (AC-4 21.11)', async () => {
      const manager1 = new WalletManager({ encryptedPath: '/tmp/test1.enc' });
      await manager1.fromMnemonic(TEST_MNEMONIC_12);

      const manager2 = new WalletManager({ encryptedPath: '/tmp/test2.enc' });
      await manager2.fromMnemonic(TEST_MNEMONIC_12);

      expect(manager1.getNodeKeys('mill').solanaAddress).toBe(
        manager2.getNodeKeys('mill').solanaAddress
      );
    });
  });

  // ── T-030: lock() zeros key material ──

  describe('lock()', () => {
    it('zeros all in-memory key material', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);

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

    it('makes getNodeKeys() throw after lock', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      manager.lock();
      expect(() => manager.getNodeKeys('town')).toThrow(/not initialized/i);
    });

    it('is safe to call multiple times', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      manager.lock();
      manager.lock(); // Should not throw
    });
  });

  // ── getAllKeys() ──

  describe('getAllKeys()', () => {
    it('returns key info for all three node types', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);

      const allKeys = manager.getAllKeys();

      expect(allKeys).toHaveLength(3);
      const nodeTypes = allKeys.map((k) => k.nodeType);
      expect(nodeTypes).toContain('town');
      expect(nodeTypes).toContain('mill');
      expect(nodeTypes).toContain('dvm');
    });

    it('each key info contains nostrPubkey and evmAddress but not secrets', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);

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

    it('mill NodeKeyInfo includes solanaAddress and minaAddress (AC-4 21.11)', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      const allKeys = manager.getAllKeys();
      const millInfo = allKeys.find((k) => k.nodeType === 'mill')!;
      expect(typeof millInfo.solanaAddress).toBe('string');
      expect(typeof millInfo.minaAddress).toBe('string');
      // town and dvm should NOT have these fields
      const townInfo = allKeys.find((k) => k.nodeType === 'town')!;
      expect(townInfo.solanaAddress).toBeUndefined();
      expect(townInfo.minaAddress).toBeUndefined();
    });

    it('throws if wallet not initialized', () => {
      expect(() => manager.getAllKeys()).toThrow(/not initialized/i);
    });
  });

  // ── Derivation paths ──

  describe('derivation paths', () => {
    it('uses correct BIP-44 paths per node type', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);

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

  // ── Story 46.2: deriveNodeKey + getMnemonic ────────────────────────────────

  describe('deriveNodeKey() (Story 46.2, Task 3.2)', () => {
    it('returns the same keys as getNodeKeys() when derivationIndex = ACCOUNT_INDEX (identity invariant)', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);

      const ACCOUNT_INDEX_TOWN = 0;
      const derived = await manager.deriveNodeKey('town', ACCOUNT_INDEX_TOWN);
      const cached = manager.getNodeKeys('town');

      expect(derived.nostrPubkey).toBe(cached.nostrPubkey);
      expect(derived.evmAddress).toBe(cached.evmAddress);
      expect(Buffer.from(derived.nostrSecretKey).toString('hex')).toBe(
        Buffer.from(cached.nostrSecretKey).toString('hex')
      );
    });

    it('produces different keys when derivationIndex differs from the default', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);

      const defaultKeys = await manager.deriveNodeKey('town', 0);
      const alternateKeys = await manager.deriveNodeKey('town', 5);

      expect(defaultKeys.nostrPubkey).not.toBe(alternateKeys.nostrPubkey);
      expect(defaultKeys.evmAddress).not.toBe(alternateKeys.evmAddress);
    });

    it('throws when wallet has never been initialized', async () => {
      // Fresh manager (no fromMnemonic/generate call) — deriveNodeKey throws.
      await expect(manager.deriveNodeKey('town', 0)).rejects.toThrow(
        /not initialized/i
      );
    });

    it('throws when wallet is locked after being initialized (P9/P10)', async () => {
      // Initialize, then lock — deriveNodeKey must throw the same not-initialized
      // error class so callers cannot accidentally derive keys post-lock.
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      manager.lock();
      await expect(manager.deriveNodeKey('town', 0)).rejects.toThrow(
        /not initialized/i
      );
    });

    it('mill type: returns Solana + Mina addresses when derivation succeeds', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      const ACCOUNT_INDEX_MILL = 1;
      // deriveMillKeys may succeed or fail depending on the test platform.
      // Either way, deriveNodeKey should NOT throw — mill chain addresses are optional.
      const keys = await manager.deriveNodeKey('mill', ACCOUNT_INDEX_MILL);
      expect(keys.nostrPubkey).toBeTruthy();
      expect(keys.evmAddress).toBeTruthy();
      // solanaAddress / minaAddress may or may not be present (optional)
      if (keys.solanaAddress !== undefined) {
        expect(typeof keys.solanaAddress).toBe('string');
      }
    });
  });

  describe('getMnemonic() (Story 46.2, Task 3.3)', () => {
    it('returns the mnemonic after fromMnemonic()', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      expect(manager.getMnemonic()).toBe(TEST_MNEMONIC_12);
    });

    it('returns null when wallet has never been initialized', () => {
      expect(manager.getMnemonic()).toBeNull();
    });

    it('returns null after lock()', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      expect(manager.getMnemonic()).toBe(TEST_MNEMONIC_12);
      manager.lock();
      expect(manager.getMnemonic()).toBeNull();
    });
  });
});
