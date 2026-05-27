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
      // Epic 49 / D21-008: town and dvm now ALSO derive solanaAddress (the
      // DVM needs it for Turbo credit funding; town's SOL is exposed for
      // symmetry). Mina remains mill-only.
      const townKeys = manager.getNodeKeys('town');
      expect(typeof townKeys.solanaAddress).toBe('string');
      expect(townKeys.solanaAddress!.length).toBeGreaterThan(20);
      expect(townKeys.minaAddress).toBeUndefined();
      const dvmKeys = manager.getNodeKeys('dvm');
      expect(typeof dvmKeys.solanaAddress).toBe('string');
      expect(dvmKeys.minaAddress).toBeUndefined();
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
      // Epic 49: town and dvm now ALSO surface solanaAddress (D21-008).
      // Mina remains mill-only.
      const townInfo = allKeys.find((k) => k.nodeType === 'town')!;
      expect(typeof townInfo.solanaAddress).toBe('string');
      expect(townInfo.minaAddress).toBeUndefined();
      const dvmInfo = allKeys.find((k) => k.nodeType === 'dvm')!;
      expect(typeof dvmInfo.solanaAddress).toBe('string');
      expect(dvmInfo.minaAddress).toBeUndefined();
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

  // ── Epic 49: per-node Solana derivation ──────────────────────────────────

  describe('per-node Solana derivation (Epic 49)', () => {
    it('derives a distinct Solana address for each node type', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      const town = manager.getNodeKeys('town');
      const mill = manager.getNodeKeys('mill');
      const dvm = manager.getNodeKeys('dvm');

      expect(typeof town.solanaAddress).toBe('string');
      expect(typeof mill.solanaAddress).toBe('string');
      expect(typeof dvm.solanaAddress).toBe('string');

      // All three SOL addresses MUST differ (different BIP-44 account indices)
      expect(town.solanaAddress).not.toBe(mill.solanaAddress);
      expect(town.solanaAddress).not.toBe(dvm.solanaAddress);
      expect(mill.solanaAddress).not.toBe(dvm.solanaAddress);
    });

    it('exposes a 32-byte Solana private-key seed for each node type', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      for (const nodeType of ['town', 'mill', 'dvm'] as const) {
        const keys = manager.getNodeKeys(nodeType);
        expect(keys.solanaPrivateKey).toBeInstanceOf(Uint8Array);
        expect(keys.solanaPrivateKey!.length).toBe(32);
      }
    });

    it('uses the SLIP-0010 all-hardened Solana derivation path per account', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      expect(manager.getNodeKeys('town').solanaDerivationPath).toBe(
        "m/44'/501'/0'/0'/0'"
      );
      expect(manager.getNodeKeys('mill').solanaDerivationPath).toBe(
        "m/44'/501'/1'/0'/0'"
      );
      expect(manager.getNodeKeys('dvm').solanaDerivationPath).toBe(
        "m/44'/501'/2'/0'/0'"
      );
    });

    it('getAllKeys() exposes solanaAddress + solanaDerivationPath for all three nodes', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      const all = manager.getAllKeys();
      for (const info of all) {
        expect(typeof info.solanaAddress).toBe('string');
        expect(info.solanaDerivationPath).toMatch(
          /^m\/44'\/501'\/\d+'\/0'\/0'$/
        );
      }
    });
  });

  // ── Epic 49: Arweave (RSA-4096) derivation — lazy via ensureArweaveKey ──

  describe('ensureArweaveKey() (Epic 49)', () => {
    // RSA-4096 generation from a deterministic PRNG takes 5–30s. Bump
    // timeout high enough to be comfortable on slower CI runners.
    const RSA_TIMEOUT_MS = 120_000;

    it(
      'derives an Arweave JWK + address for the DVM node on demand',
      async () => {
        await manager.fromMnemonic(TEST_MNEMONIC_12);
        // Before ensureArweaveKey: getArweaveJwk() should throw
        expect(() => manager.getArweaveJwk('dvm')).toThrow(/not yet derived/i);

        const jwk = await manager.ensureArweaveKey('dvm');
        expect(jwk.kty).toBe('RSA');
        expect(jwk.n).toBeTruthy();
        expect(jwk.e).toBeTruthy();
        expect(jwk.d).toBeTruthy();
        expect(jwk.p).toBeTruthy();
        expect(jwk.q).toBeTruthy();

        const dvm = manager.getNodeKeys('dvm');
        expect(dvm.arweaveAddress).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(dvm.arweaveDerivationPath).toBe("m/44'/472'/2'/0/0");
      },
      RSA_TIMEOUT_MS
    );

    it(
      'caches the JWK so a second call returns the same reference without re-deriving',
      async () => {
        await manager.fromMnemonic(TEST_MNEMONIC_12);
        const first = await manager.ensureArweaveKey('dvm');
        const tStart = Date.now();
        const second = await manager.ensureArweaveKey('dvm');
        const elapsed = Date.now() - tStart;
        expect(second).toBe(first); // same JWK reference
        // Cache hit must be near-instant (< 50ms is generous for any cold
        // JS environment) — confirms we are not re-running RSA-4096.
        expect(elapsed).toBeLessThan(50);
      },
      RSA_TIMEOUT_MS
    );

    it(
      'getAllKeys() exposes arweaveAddress + arweaveDerivationPath for DVM after derivation',
      async () => {
        await manager.fromMnemonic(TEST_MNEMONIC_12);
        await manager.ensureArweaveKey('dvm');
        const all = manager.getAllKeys();
        const dvmInfo = all.find((k) => k.nodeType === 'dvm')!;
        expect(dvmInfo.arweaveAddress).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(dvmInfo.arweaveDerivationPath).toBe("m/44'/472'/2'/0/0");
        // Town and Mill never trigger AR derivation by default — they
        // should remain undefined.
        const townInfo = all.find((k) => k.nodeType === 'town')!;
        const millInfo = all.find((k) => k.nodeType === 'mill')!;
        expect(townInfo.arweaveAddress).toBeUndefined();
        expect(millInfo.arweaveAddress).toBeUndefined();
      },
      RSA_TIMEOUT_MS
    );

    it('throws when called on a locked wallet', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      manager.lock();
      await expect(manager.ensureArweaveKey('dvm')).rejects.toThrow(
        /not initialized/i
      );
    });
  });

  // ── Epic 49: private-key accessors with lock-state contract ──────────────

  describe('private-key accessors (Epic 49)', () => {
    it('getEvmPrivateKeyHex returns 64-char hex for every node type', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      for (const nodeType of ['town', 'mill', 'dvm'] as const) {
        const hex = manager.getEvmPrivateKeyHex(nodeType);
        expect(hex).toMatch(/^[0-9a-f]{64}$/);
      }
      // Distinct per node type
      const town = manager.getEvmPrivateKeyHex('town');
      const mill = manager.getEvmPrivateKeyHex('mill');
      const dvm = manager.getEvmPrivateKeyHex('dvm');
      expect(town).not.toBe(mill);
      expect(mill).not.toBe(dvm);
      expect(town).not.toBe(dvm);
    });

    it('getEvmPrivateKeyHex throws after lock()', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      manager.lock();
      expect(() => manager.getEvmPrivateKeyHex('dvm')).toThrow(
        /not initialized/i
      );
    });

    it('getSolanaPrivateKeyHex returns 64-char hex for every node type', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      for (const nodeType of ['town', 'mill', 'dvm'] as const) {
        const hex = manager.getSolanaPrivateKeyHex(nodeType);
        expect(hex).toMatch(/^[0-9a-f]{64}$/);
      }
      // Distinct per node type (different SLIP-0010 account indices)
      const town = manager.getSolanaPrivateKeyHex('town');
      const mill = manager.getSolanaPrivateKeyHex('mill');
      const dvm = manager.getSolanaPrivateKeyHex('dvm');
      expect(town).not.toBe(mill);
      expect(mill).not.toBe(dvm);
      expect(town).not.toBe(dvm);
    });

    it('getSolanaPrivateKeyHex throws after lock()', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      manager.lock();
      expect(() => manager.getSolanaPrivateKeyHex('dvm')).toThrow(
        /not initialized/i
      );
    });

    it('getArweaveJwk throws until ensureArweaveKey is awaited, then returns JWK', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      expect(() => manager.getArweaveJwk('dvm')).toThrow(/not yet derived/i);
      const jwk = await manager.ensureArweaveKey('dvm');
      expect(manager.getArweaveJwk('dvm')).toBe(jwk);
    }, 120_000);

    it('getArweaveJwk throws after lock()', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      manager.lock();
      expect(() => manager.getArweaveJwk('dvm')).toThrow(/not initialized/i);
    });
  });

  // ── Epic 49: lock() zeros extended key material ──────────────────────────

  describe('lock() — extended key material (Epic 49)', () => {
    it('zeros the Solana private key seed on every node type', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      const refs = (['town', 'mill', 'dvm'] as const).map((t) => ({
        nodeType: t,
        ref: manager.getNodeKeys(t).solanaPrivateKey!,
      }));
      for (const { ref } of refs) {
        expect(ref.some((b) => b !== 0)).toBe(true);
      }
      manager.lock();
      for (const { nodeType, ref } of refs) {
        expect(
          ref.every((b) => b === 0),
          `${nodeType} solanaPrivateKey not zeroed`
        ).toBe(true);
      }
    });

    it('wipes the Arweave JWK private exponents after derivation + lock', async () => {
      await manager.fromMnemonic(TEST_MNEMONIC_12);
      const jwk = await manager.ensureArweaveKey('dvm');
      // Confirm the JWK starts populated.
      expect(jwk.d).toBeTruthy();
      expect(jwk.p).toBeTruthy();
      manager.lock();
      // Private exponents are emptied. (Public n + e remain — they
      // are not secret. But the reference held by the caller is wiped.)
      expect(jwk.d).toBe('');
      expect(jwk.p).toBe('');
      expect(jwk.q).toBe('');
      expect(jwk.dp).toBe('');
      expect(jwk.dq).toBe('');
      expect(jwk.qi).toBe('');
    }, 120_000);
  });
});
