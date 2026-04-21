/**
 * Golden Test Vectors: HD Key Derivation (Story 21.4)
 *
 * Test IDs map to test-design-epic-21.md scenarios T-024, T-025, T-029.
 *
 * These tests verify:
 * - AC #3: Per-node HD derivation following BIP-44 paths (distinct account indices per node type)
 * - AC #4: Nostr keypair (secp256k1) + EVM address derived per node
 * - AC #7: Golden test vectors for cross-version key consistency
 *
 * CRITICAL: These golden vectors ensure derivation path consistency across versions.
 * If any of these fail after implementation, it means a breaking change to key derivation
 * that would lock operators out of their derived keys.
 *
 * Path Collision Analysis (documented as required by story):
 * - SDK KeyDerivation.deriveFullIdentity() uses m/44'/1237'/0'/0/0 for Nostr — same as
 *   Townhouse Town. This is acceptable because Townhouse operates server-side with a
 *   different mnemonic than the client-side user. The mnemonic itself provides isolation.
 * - Mill deriveMillKeys() uses configurable account index (default 2) for swap operational
 *   keys. Townhouse Mill identity uses account index 1 — no collision.
 */

import { describe, it, expect } from 'vitest';

import { WalletManager } from './manager.js';

/**
 * Well-known test mnemonic (BIP-39 test vector #0).
 * DO NOT use this in production — it is publicly known.
 */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * Account Index Convention (Townhouse-specific):
 * | Node Type | Account Index | Nostr Path           | EVM Path            |
 * |-----------|--------------|----------------------|---------------------|
 * | Town      | 0            | m/44'/1237'/0'/0/0   | m/44'/60'/0'/0/0    |
 * | Mill      | 1            | m/44'/1237'/1'/0/0   | m/44'/60'/1'/0/0    |
 * | DVM       | 2            | m/44'/1237'/2'/0/0   | m/44'/60'/2'/0/0    |
 */

describe('Golden Derivation Vectors (T-024, T-025, T-029)', () => {
  describe('Town node (account index 0)', () => {
    it('derives deterministic Nostr pubkey for Town', () => {
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const townKeys = manager.getNodeKeys('town');

      // Nostr pubkey should be a 64-char hex string (32 bytes x-only pubkey)
      expect(townKeys.nostrPubkey).toMatch(/^[0-9a-f]{64}$/);

      // Golden vector: NIP-06 derivation of "abandon...about" at m/44'/1237'/0'/0/0
      expect(townKeys.nostrPubkey).toBe(
        'e8bcf3823669444d0b49ad45d65088635d9fd8500a75b5f20b59abefa56a144f'
      );
    });

    it('derives deterministic EVM address for Town', () => {
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const townKeys = manager.getNodeKeys('town');

      // EVM address should be a 0x-prefixed 40-char hex string
      expect(townKeys.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

      // Golden vector: the well-known EVM address for m/44'/60'/0'/0/0
      // from the "abandon" mnemonic is 0x9858EfFD232B4033E47d90003D41EC34EcaEda94
      expect(townKeys.evmAddress.toLowerCase()).toBe(
        '0x9858effd232b4033e47d90003d41ec34ecaeda94'
      );
    });

    it("Town Nostr derivation path is m/44'/1237'/0'/0/0", () => {
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const townKeys = manager.getNodeKeys('town');
      expect(townKeys.nostrDerivationPath).toBe("m/44'/1237'/0'/0/0");
    });
  });

  describe('Mill node (account index 1)', () => {
    it('derives a different Nostr pubkey than Town', () => {
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const townKeys = manager.getNodeKeys('town');
      const millKeys = manager.getNodeKeys('mill');

      expect(millKeys.nostrPubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(millKeys.nostrPubkey).not.toBe(townKeys.nostrPubkey);
    });

    it('derives a different EVM address than Town', () => {
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const townKeys = manager.getNodeKeys('town');
      const millKeys = manager.getNodeKeys('mill');

      expect(millKeys.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(millKeys.evmAddress.toLowerCase()).not.toBe(
        townKeys.evmAddress.toLowerCase()
      );
    });

    it("Mill Nostr derivation path is m/44'/1237'/1'/0/0", () => {
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const millKeys = manager.getNodeKeys('mill');
      expect(millKeys.nostrDerivationPath).toBe("m/44'/1237'/1'/0/0");
    });
  });

  describe('DVM node (account index 2)', () => {
    it('derives a different Nostr pubkey than Town and Mill', () => {
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const townKeys = manager.getNodeKeys('town');
      const millKeys = manager.getNodeKeys('mill');
      const dvmKeys = manager.getNodeKeys('dvm');

      expect(dvmKeys.nostrPubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(dvmKeys.nostrPubkey).not.toBe(townKeys.nostrPubkey);
      expect(dvmKeys.nostrPubkey).not.toBe(millKeys.nostrPubkey);
    });

    it('derives a different EVM address than Town and Mill', () => {
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const townKeys = manager.getNodeKeys('town');
      const millKeys = manager.getNodeKeys('mill');
      const dvmKeys = manager.getNodeKeys('dvm');

      expect(dvmKeys.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(dvmKeys.evmAddress.toLowerCase()).not.toBe(
        townKeys.evmAddress.toLowerCase()
      );
      expect(dvmKeys.evmAddress.toLowerCase()).not.toBe(
        millKeys.evmAddress.toLowerCase()
      );
    });

    it("DVM Nostr derivation path is m/44'/1237'/2'/0/0", () => {
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const dvmKeys = manager.getNodeKeys('dvm');
      expect(dvmKeys.nostrDerivationPath).toBe("m/44'/1237'/2'/0/0");
    });
  });

  // ── Cross-version consistency: exact golden values ──

  describe('exact golden values (cross-version consistency)', () => {
    it('all derivations are reproducible from the test mnemonic', () => {
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const town = manager.getNodeKeys('town');
      const mill = manager.getNodeKeys('mill');
      const dvm = manager.getNodeKeys('dvm');

      // GOLDEN VALUES — computed once. If these change, key derivation is broken.
      // Nostr pubkeys (NIP-06 paths)
      expect(town.nostrPubkey).toBe(
        'e8bcf3823669444d0b49ad45d65088635d9fd8500a75b5f20b59abefa56a144f'
      );
      expect(mill.nostrPubkey).toBe(
        '7e956dc460e4f63fc6c5bcb5ab4a541691ff192a398cdcca0fe7ae8da4629dd6'
      );
      expect(dvm.nostrPubkey).toBe(
        '8b73806670885d689179ba8846fa5390ce8b438650b595b2fc9c8e1e9d59b115'
      );

      // EVM addresses (golden vectors — all pinned for cross-version consistency)
      expect(town.evmAddress.toLowerCase()).toBe(
        '0x9858effd232b4033e47d90003d41ec34ecaeda94'
      );
      expect(mill.evmAddress.toLowerCase()).toBe(
        '0x78839f6054d7ed13918bae0473ba31b1ca9d7265'
      );
      expect(dvm.evmAddress.toLowerCase()).toBe(
        '0x07b5fdfeb4e11826d233403fe8db0611ccf4c231'
      );

      // All three must be different
      expect(mill.evmAddress).not.toBe(town.evmAddress);
      expect(dvm.evmAddress).not.toBe(town.evmAddress);
      expect(dvm.evmAddress).not.toBe(mill.evmAddress);
    });
  });

  // ── T-025: No collision with existing SDK/Mill paths ──

  describe('Path collision analysis (T-025)', () => {
    it('Townhouse Town (account 0) path matches SDK KeyDerivation path — this is intentional', () => {
      /**
       * DOCUMENTED INTENTIONAL PATH SHARING:
       * SDK KeyDerivation.deriveFullIdentity() uses m/44'/1237'/0'/0/0 for Nostr.
       * Townhouse Town also uses m/44'/1237'/0'/0/0.
       *
       * This is acceptable because:
       * 1. Townhouse operates server-side with a DIFFERENT mnemonic than client-side
       * 2. The mnemonic itself provides isolation, not the derivation path
       * 3. A Townhouse operator's seed is never the same as a client user's seed
       */
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const townKeys = manager.getNodeKeys('town');
      expect(townKeys.nostrDerivationPath).toBe("m/44'/1237'/0'/0/0");
    });

    it('Townhouse Mill (account 1) does NOT collide with Mill deriveMillKeys (account 2)', () => {
      /**
       * Mill's deriveMillKeys() uses account index 2 (configurable) for SWAP operational keys.
       * Townhouse Mill identity uses account index 1 for NODE IDENTITY keys.
       * These are different account indices — no collision.
       */
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const millKeys = manager.getNodeKeys('mill');
      // Townhouse Mill is at account index 1
      expect(millKeys.nostrDerivationPath).toBe("m/44'/1237'/1'/0/0");
      // NOT at account index 2 (which is Mill's operational swap keys)
      expect(millKeys.nostrDerivationPath).not.toContain("/2'/");
    });

    it('Townhouse DVM (account 2) path is for node identity, not Mill swap operations', () => {
      /**
       * Even though Townhouse DVM uses account index 2 (same as Mill swap keys),
       * this is different because:
       * 1. The Townhouse mnemonic is different from the Mill's own mnemonic
       * 2. These are node IDENTITY keys (signing, peering), not swap operational keys
       */
      const manager = new WalletManager({ encryptedPath: '/tmp/test.enc' });
      manager.fromMnemonic(TEST_MNEMONIC);

      const dvmKeys = manager.getNodeKeys('dvm');
      expect(dvmKeys.nostrDerivationPath).toBe("m/44'/1237'/2'/0/0");
    });
  });
});
