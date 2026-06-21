/**
 * WalletManager — HD key derivation for Hub (Story 21.4, Task 1).
 *
 * Single BIP-39 mnemonic, deterministic HD derivation per node type.
 * Uses BIP-44 paths with distinct account indices per node type:
 *   - Town: account 0
 *   - Mill: account 1
 *   - DVM:  account 2
 *
 * Nostr keys use NIP-06 coin type 1237: m/44'/1237'/{account}'/0/0
 * EVM keys use standard coin type 60:   m/44'/60'/{account}'/0/0
 * Solana keys (all node types) coin 501: m/44'/501'/{account}'/0'/0'
 *   (SLIP-0010 all-hardened, via @toon-protocol/mill::deriveMillKeys)
 * Arweave keys (DVM only) coin 472:     m/44'/472'/2'/0/0
 *   (32-byte BIP-32 sub-seed feeds a deterministic RSA-4096 PRNG via
 *    rsa-from-seed.ts (HMAC-DRBG + node-forge 1.3.3). Derivation takes 5–30s per DVM unlock; this runs
 *    once at unlock time, not per operation.)
 */

import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeedSync,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { createPrivateKey, createHash } from 'node:crypto';

import type { NodeType } from '../docker/types.js';
import {
  arweaveCachePath,
  deleteArweaveJwkFromCache,
  readArweaveJwkFromCache,
  writeArweaveJwkToCache,
} from './ar-cache.js';
import {
  ACCOUNT_INDEX_TOWN,
  ACCOUNT_INDEX_MILL,
  ACCOUNT_INDEX_DVM,
  ACCOUNT_INDEX_APEX,
} from '../constants.js';
import type {
  WalletManagerConfig,
  WalletState,
  NodeKeys,
  DerivedNodeKeys,
  NodeKeyInfo,
  ArweaveJwk,
} from './types.js';
// Imported from the lean `/wallet` subpath (NOT the `@toon-protocol/mill` root
// barrel) so tsup inlines only the pure key-derivation + its light crypto deps.
// mill is a build-only (dev) dependency — it ships as a Docker image, never an
// npm runtime dep of hub. The `noExternal` rule in tsup.config.ts bundles
// this into dist so the published package has zero @toon-protocol/* runtime deps.
import { deriveMillKeys } from '@toon-protocol/swap/wallet';
import {
  base58Encode as coreBase58Encode,
  hexToMinaBase58PrivateKey,
  deriveMinaPublicKeyBase58,
} from '@toon-protocol/core';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeros++;
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let result = '';
  while (value > 0n) {
    result = BASE58_ALPHABET[Number(value % 58n)] + result;
    value = value / 58n;
  }
  for (let i = 0; i < zeros; i++) result = '1' + result;
  return result || '1';
}

/**
 * Resolve a fundable Mina `B62…` address from a derived Mina key. `deriveMillKeys`
 * emits only a keccak **hex placeholder** as the Mina public key (it leaves
 * Pallas curve math to `mina-signer`), which is unfundable and rejected by Mina
 * GraphQL balance queries — so `/wallet/balances` would otherwise display an
 * unusable hex string for the mill's Mina leg. Resolve the real B62 via
 * `mina-signer` when present; fall back to the hex placeholder when the optional
 * peer dep is absent (so behaviour degrades gracefully rather than throwing).
 */
async function resolveMinaAddress(mina: {
  privateKey: string;
  publicKey: string;
}): Promise<string> {
  try {
    const b62 = await deriveMinaPublicKeyBase58(mina.privateKey);
    return b62 ?? mina.publicKey;
  } catch {
    return mina.publicKey;
  }
}

/** Map node type to account index */
const NODE_ACCOUNT_INDEX: Record<NodeType, number> = {
  town: ACCOUNT_INDEX_TOWN,
  mill: ACCOUNT_INDEX_MILL,
  dvm: ACCOUNT_INDEX_DVM,
};

/**
 * WalletManager handles mnemonic generation, key derivation, and in-memory
 * key lifecycle for Hub node operations.
 */
export class WalletManager {
  private readonly config: WalletManagerConfig;
  private state: WalletState | null = null;

  constructor(config: WalletManagerConfig) {
    this.config = config;
  }

  /** Path to the encrypted wallet file */
  get encryptedPath(): string {
    return this.config.encryptedPath;
  }

  /**
   * Generate a new 12-word BIP-39 mnemonic and derive all node keys.
   * Returns the mnemonic (for one-time display) and the derived state.
   */
  async generate(): Promise<{ mnemonic: string; state: WalletState }> {
    const mnemonic = generateMnemonic(wordlist, 128); // 128 bits = 12 words
    const state = await this.deriveAllKeys(mnemonic);
    this.state = state;
    return { mnemonic, state };
  }

  /**
   * Import an existing mnemonic (12 or 24 words) and derive all node keys.
   * Throws if mnemonic is invalid (wrong checksum, wrong word count, etc).
   */
  async fromMnemonic(mnemonic: string): Promise<WalletState> {
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new Error(
        'Invalid BIP-39 mnemonic: checksum or word list validation failed'
      );
    }
    const state = await this.deriveAllKeys(mnemonic);
    this.state = state;
    return state;
  }

  /**
   * Get derived keys for a specific node type.
   * Throws if wallet has not been initialized (call generate() or fromMnemonic() first).
   */
  getNodeKeys(nodeType: NodeType): NodeKeys {
    if (!this.state) {
      throw new Error(
        'Wallet not initialized. Call generate() or fromMnemonic() first.'
      );
    }
    return this.state.keys[nodeType];
  }

  /**
   * Get display-safe info for all node types (no secrets).
   */
  getAllKeys(): NodeKeyInfo[] {
    if (!this.state) {
      throw new Error(
        'Wallet not initialized. Call generate() or fromMnemonic() first.'
      );
    }

    const state = this.state;
    const types: NodeType[] = ['town', 'mill', 'dvm'];
    return types.map((nodeType) => {
      const keys = state.keys[nodeType];
      const info: NodeKeyInfo = {
        nodeType,
        nostrPubkey: keys.nostrPubkey,
        evmAddress: keys.evmAddress,
        nostrDerivationPath: keys.nostrDerivationPath,
        evmDerivationPath: keys.evmDerivationPath,
      };
      if (keys.solanaAddress) info.solanaAddress = keys.solanaAddress;
      if (keys.solanaDerivationPath)
        info.solanaDerivationPath = keys.solanaDerivationPath;
      if (nodeType === 'mill' && keys.minaAddress) {
        info.minaAddress = keys.minaAddress;
      }
      if (keys.arweaveAddress) info.arweaveAddress = keys.arweaveAddress;
      if (keys.arweaveDerivationPath)
        info.arweaveDerivationPath = keys.arweaveDerivationPath;
      return info;
    });
  }

  /**
   * List keys for all node types (alias for getAllKeys for API compatibility).
   */
  listKeys(): NodeKeyInfo[] {
    return this.getAllKeys();
  }

  /**
   * Zero all in-memory key material. After calling lock(),
   * getNodeKeys() and getAllKeys() will throw.
   */
  lock(): void {
    if (!this.state) return;

    const types: NodeType[] = ['town', 'mill', 'dvm'];
    for (const nodeType of types) {
      const keys = this.state.keys[nodeType];
      keys.nostrSecretKey.fill(0);
      keys.evmPrivateKey.fill(0);
      if (keys.solanaPrivateKey) keys.solanaPrivateKey.fill(0);
      if (keys.arweaveJwk) zeroArweaveJwk(keys.arweaveJwk);
    }
    this.state = null;
  }

  /**
   * Return the BIP-39 mnemonic from in-memory wallet state.
   * Returns null when the wallet is locked or not initialized.
   */
  getMnemonic(): string | null {
    return this.state?.mnemonic ?? null;
  }

  /**
   * Get derived keys for a specific node type at a given derivation index.
   *
   * Pure derivation — does NOT mutate `state`. Re-derives from the stored
   * mnemonic each time it is called. For every node type, also derives the
   * Solana key at the same account index. For 'dvm', also derives Arweave.
   * Throws if the wallet is locked.
   *
   * v1 callers MUST pass `derivationIndex = ACCOUNT_INDEX_{type}` for the
   * first (and only) instance per type. Multi-instance support is out of
   * scope for v1 — the route layer enforces single-instance-per-type.
   */
  async deriveNodeKey(
    type: NodeType,
    derivationIndex: number
  ): Promise<NodeKeys> {
    if (!this.state) {
      throw new Error(
        'Wallet not initialized. Call generate() or fromMnemonic() first.'
      );
    }
    const mnemonic = this.state.mnemonic;
    let seed: Uint8Array | undefined;
    try {
      seed = mnemonicToSeedSync(mnemonic);
      const baseKeys = this.deriveNodeKeys(seed, type, derivationIndex);
      // Derive Solana for ALL node types (P21-008 — DVM needs SOL for
      // Turbo credit funding; town's SOL is exposed for symmetry).
      const chains: ('solana' | 'mina')[] =
        type === 'mill' ? ['solana', 'mina'] : ['solana'];
      let solanaAddress: string | undefined;
      let solanaPrivateKey: Uint8Array | undefined;
      let solanaDerivationPath: string | undefined;
      let minaAddress: string | undefined;
      try {
        const chainKeys = await deriveMillKeys({
          mnemonic,
          chains,
          accountIndex: derivationIndex,
        });
        if (chainKeys.solana) {
          solanaAddress = base58Encode(chainKeys.solana.publicKey);
          solanaPrivateKey = chainKeys.solana.privateKey;
          solanaDerivationPath = chainKeys.solana.path;
        }
        if (chainKeys.mina && type === 'mill') {
          minaAddress = await resolveMinaAddress(chainKeys.mina);
        }
      } catch (err: unknown) {
        // deriveMillKeys failure (e.g. unsupported platform, library load
        // error) — chain addresses are optional at derivation time, but a
        // non-platform failure should be visible (P8). Log via console.warn
        // because WalletManager has no logger injected.
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[WalletManager] deriveMillKeys failed for type=${type} accountIndex=${derivationIndex}: ${errMsg} — Solana/Mina addresses omitted`
        );
      }
      // Note: AR is intentionally NOT derived here either — `deriveNodeKey`
      // is a pure re-derivation helper called by route/admin code paths
      // where blocking 5–30s on RSA-4096 generation would surprise callers.
      // Use `ensureArweaveKey(type)` from the credit-funding code path to
      // obtain the AR JWK on demand.
      return {
        ...baseKeys,
        solanaAddress,
        solanaPrivateKey,
        solanaDerivationPath,
        minaAddress,
      };
    } finally {
      if (seed) seed.fill(0);
    }
  }

  // ── Private-key accessors (epic-49 credit funding) ───────────────────────

  /**
   * Returns the EVM private key for a node as a 64-char lowercase hex string.
   * Throws when the wallet is locked. Callers MUST treat the returned string
   * as sensitive (no logging, no persisting). The underlying Uint8Array is
   * still owned by WalletManager and will be zeroed by `lock()`.
   */
  getEvmPrivateKeyHex(nodeType: NodeType): string {
    const keys = this.getNodeKeys(nodeType);
    return bytesToHex(keys.evmPrivateKey);
  }

  /**
   * Derive the APEX (connector) settlement key from the operator mnemonic at
   * ACCOUNT_INDEX_APEX. The apex signs settlement claims with this key, so the
   * operator never has to supply a raw `keyId` to `hub chains add`.
   *
   * Returns the EVM private key as a `0x`-prefixed 64-char hex string — the
   * form the connector config's `keyId` expects (matches the dev placeholder
   * `0x7c85…`). Also returns Solana + Mina settlement keys (connector 3.9.0)
   * derived at the same `ACCOUNT_INDEX_APEX`, in the RAW base58 form the
   * connector resolves a non-EVM `keyId` as:
   *   - Solana: base58 of the 32-byte Ed25519 seed,
   *   - Mina:   `EK…` base58check (via `hexToMinaBase58PrivateKey`).
   *
   * EVM derivation must always succeed (it throws on failure). Solana/Mina
   * derivation is best-effort: if `deriveMillKeys` throws (unsupported
   * platform, library load error) the corresponding key is OMITTED rather than
   * failing the whole method, so the EVM keyId path is never blocked.
   *
   * Async because `deriveMillKeys` is async. Throws when the wallet is locked.
   */
  async getApexSettlementKeys(): Promise<{
    evmPrivateKeyHex: string;
    solanaPrivateKeyBase58?: string;
    minaPrivateKeyBase58?: string;
  }> {
    if (!this.state) {
      throw new Error(
        'Wallet not initialized. Call generate() or fromMnemonic() first.'
      );
    }
    const mnemonic = this.state.mnemonic;
    let seed: Uint8Array | undefined;
    let evmPrivateKeyHex: string;
    try {
      seed = mnemonicToSeedSync(mnemonic);
      // Same path the per-node EVM derivation uses (m/44'/60'/{idx}'/0/0).
      const path = `m/44'/60'/${ACCOUNT_INDEX_APEX}'/0/0`;
      const hd = HDKey.fromMasterSeed(seed).derive(path);
      if (!hd.privateKey) {
        throw new Error(`Apex EVM private key missing at ${path}`);
      }
      evmPrivateKeyHex = `0x${bytesToHex(new Uint8Array(hd.privateKey))}`;
    } finally {
      if (seed) seed.fill(0);
    }

    // Solana + Mina apex keys (best-effort — omit on failure, never block EVM).
    let solanaPrivateKeyBase58: string | undefined;
    let minaPrivateKeyBase58: string | undefined;
    try {
      const chainKeys = await deriveMillKeys({
        mnemonic,
        chains: ['solana', 'mina'],
        accountIndex: ACCOUNT_INDEX_APEX,
      });
      if (chainKeys.solana) {
        // Connector resolves a Solana keyId as base58 of the 32-byte Ed25519 seed.
        solanaPrivateKeyBase58 = coreBase58Encode(chainKeys.solana.privateKey);
      }
      if (chainKeys.mina) {
        // deriveMillKeys emits a big-endian hex scalar (no mina-signer); convert
        // to the `EK…` base58check form the connector resolves as a Mina keyId.
        minaPrivateKeyBase58 = hexToMinaBase58PrivateKey(
          chainKeys.mina.privateKey
        );
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[WalletManager] deriveMillKeys failed for apex (accountIndex=${ACCOUNT_INDEX_APEX}): ${errMsg} — Solana/Mina apex keys omitted`
      );
    }

    return {
      evmPrivateKeyHex,
      ...(solanaPrivateKeyBase58 ? { solanaPrivateKeyBase58 } : {}),
      ...(minaPrivateKeyBase58 ? { minaPrivateKeyBase58 } : {}),
    };
  }

  /**
   * Returns the Solana Ed25519 private key seed for a node as a 64-char
   * lowercase hex string (32 raw seed bytes). Throws when the wallet is
   * locked or when the Solana key was not derived for this node type.
   */
  getSolanaPrivateKeyHex(nodeType: NodeType): string {
    const keys = this.getNodeKeys(nodeType);
    if (!keys.solanaPrivateKey) {
      throw new Error(
        `Solana private key not available for node '${nodeType}'`
      );
    }
    return bytesToHex(keys.solanaPrivateKey);
  }

  /**
   * Returns the Arweave RSA JWK for a node. Throws when the wallet is locked
   * or when AR derivation has not yet been triggered for this node type.
   *
   * Callers MUST `await ensureArweaveKey(nodeType)` first the first time per
   * unlock — RSA-4096 derivation is 5–30s and is therefore not done eagerly
   * at `fromMnemonic`/`generate` time. After the first `ensureArweaveKey`
   * the JWK is cached on the in-memory state until `lock()`.
   */
  getArweaveJwk(nodeType: NodeType): ArweaveJwk {
    const keys = this.getNodeKeys(nodeType);
    if (!keys.arweaveJwk) {
      throw new Error(
        `Arweave JWK not yet derived for node '${nodeType}'. Call ensureArweaveKey('${nodeType}') first (note: derivation takes 5–30s).`
      );
    }
    return keys.arweaveJwk;
  }

  /**
   * Lazily derive the Arweave RSA-4096 JWK for a node type and cache it on
   * the in-memory wallet state. Subsequent calls (within the same unlocked
   * session) return the cached result without re-deriving.
   *
   * Only meaningful for node types that participate in the Arweave credit
   * flow — `dvm` (account 2) in the current Hub layout. Calling on
   * `town` or `mill` will derive a valid AR key at the corresponding
   * account index but those keys are not used by any current code path.
   *
   * Throws if the wallet is locked or RSA derivation fails (unsupported
   * platform, etc.). On success the result is also reflected in subsequent
   * `getAllKeys()` calls (arweaveAddress + arweaveDerivationPath fields).
   */
  async ensureArweaveKey(
    nodeType: NodeType,
    password?: string
  ): Promise<ArweaveJwk> {
    if (!this.state) {
      throw new Error(
        'Wallet not initialized. Call generate() or fromMnemonic() first.'
      );
    }
    const existing = this.state.keys[nodeType].arweaveJwk;
    if (existing) return existing;

    const accountIndex = NODE_ACCOUNT_INDEX[nodeType];
    const path = `m/44'/472'/${accountIndex}'/0/0`;
    let seed: Uint8Array | undefined;
    let subSeed: Uint8Array | undefined;
    try {
      seed = mnemonicToSeedSync(this.state.mnemonic);

      // Derive the BIP-32 sub-seed (fast) up front so we can compute a public
      // fingerprint of the mnemonic-bound material. The fingerprint lets the
      // on-disk cache detect "wallet restored from a different mnemonic"
      // without paying the 5–30s RSA cost on every load.
      const hdKey = HDKey.fromMasterSeed(seed).derive(path);
      if (!hdKey.privateKey) {
        throw new Error(`Arweave sub-seed missing at ${path}`);
      }
      subSeed = new Uint8Array(hdKey.privateKey);
      const fingerprint = createHash('sha256')
        .update(subSeed)
        .digest('base64url');

      // ── Disk cache check (epic-49 Followup A) ─────────────────────────
      // Only attempted when a password is supplied — the cache file is
      // encrypted under the same operator password as wallet.enc. Callers
      // that don't have the password (e.g. test setups that called
      // fromMnemonic directly) skip the cache; they pay the full RSA cost.
      if (password) {
        const cachePath = arweaveCachePath(this.config.encryptedPath);
        const result = await readArweaveJwkFromCache(
          cachePath,
          nodeType,
          password,
          fingerprint
        );
        if (result.status === 'hit') {
          this.state.keys[nodeType].arweaveJwk = result.jwk;
          this.state.keys[nodeType].arweaveAddress =
            result.entry.arweaveAddress;
          this.state.keys[nodeType].arweaveDerivationPath = path;
          return result.jwk;
        }
        if (result.status === 'stale') {
          console.warn(
            `[WalletManager] Arweave JWK cache for ${nodeType} was written from a different mnemonic (cached address ${result.cachedAddress.slice(0, 12)}…). Discarding and re-deriving.`
          );
          await deleteArweaveJwkFromCache(cachePath, nodeType);
          // fall through to RSA derivation
        }
        // status === 'miss' → fall through to RSA derivation
      }

      // ── RSA-4096 derivation (5–30s) ──────────────────────────────────
      const ar = await deriveArweaveKey(seed, accountIndex);
      // Re-check state under the assumption a concurrent lock() may have
      // wiped it while we were generating RSA (5–30s window).
      if (!this.state) {
        zeroArweaveJwk(ar.jwk);
        throw new Error(
          'Wallet was locked during Arweave key derivation. Discarding derived key.'
        );
      }
      this.state.keys[nodeType].arweaveJwk = ar.jwk;
      this.state.keys[nodeType].arweaveAddress = ar.address;
      this.state.keys[nodeType].arweaveDerivationPath = ar.path;

      // ── Persist to disk cache (best-effort, password-gated) ──────────
      if (password) {
        try {
          const cachePath = arweaveCachePath(this.config.encryptedPath);
          await writeArweaveJwkToCache(
            cachePath,
            nodeType,
            ar.jwk,
            password,
            fingerprint,
            ar.address
          );
        } catch (err: unknown) {
          // Cache write failure is non-fatal — RSA derivation succeeded.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[WalletManager] Failed to write Arweave JWK cache (non-fatal): ${msg}`
          );
        }
      }

      return ar.jwk;
    } finally {
      if (seed) seed.fill(0);
      if (subSeed) subSeed.fill(0);
    }
  }

  /**
   * Derive keys for all node types from a mnemonic.
   */
  private async deriveAllKeys(mnemonic: string): Promise<WalletState> {
    let seed: Uint8Array | undefined;
    try {
      seed = mnemonicToSeedSync(mnemonic);

      // Derive Solana addresses for ALL node types (D21-008 / epic-49).
      // Mill additionally gets a Mina address. Errors here are
      // non-fatal — chain addresses are optional, base BIP-44 keys are
      // still derived per node type below.
      interface ChainExtras {
        solanaAddress?: string;
        solanaPrivateKey?: Uint8Array;
        solanaDerivationPath?: string;
        minaAddress?: string;
      }
      const chainExtras: Record<NodeType, ChainExtras> = {
        town: {},
        mill: {},
        dvm: {},
      };
      const types: NodeType[] = ['town', 'mill', 'dvm'];
      for (const nodeType of types) {
        const accountIndex = NODE_ACCOUNT_INDEX[nodeType];
        const chains: ('solana' | 'mina')[] =
          nodeType === 'mill' ? ['solana', 'mina'] : ['solana'];
        try {
          const chainKeys = await deriveMillKeys({
            mnemonic,
            chains,
            accountIndex,
          });
          if (chainKeys.solana) {
            chainExtras[nodeType].solanaAddress = base58Encode(
              chainKeys.solana.publicKey
            );
            chainExtras[nodeType].solanaPrivateKey =
              chainKeys.solana.privateKey;
            chainExtras[nodeType].solanaDerivationPath = chainKeys.solana.path;
          }
          if (nodeType === 'mill' && chainKeys.mina) {
            chainExtras[nodeType].minaAddress = await resolveMinaAddress(
              chainKeys.mina
            );
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[WalletManager] deriveMillKeys failed for ${nodeType} (accountIndex=${accountIndex}): ${errMsg} — chain addresses omitted`
          );
        }
      }

      // Note: Arweave (RSA-4096) derivation is NOT done eagerly here.
      // RSA-4096 generation from a deterministic PRNG takes 5–30 seconds
      // per call — too slow to block every wallet unlock. Callers that
      // need the AR key (CLI `credits buy`, orchestrator before starting
      // the DVM container, etc.) must call `ensureArweaveKey('dvm')`
      // explicitly. The result is cached on the in-memory state for the
      // rest of the unlocked session.

      const keys: DerivedNodeKeys = {
        town: { ...this.deriveNodeKeys(seed, 'town'), ...chainExtras.town },
        mill: { ...this.deriveNodeKeys(seed, 'mill'), ...chainExtras.mill },
        dvm: { ...this.deriveNodeKeys(seed, 'dvm'), ...chainExtras.dvm },
      };
      return { keys, mnemonic };
    } finally {
      if (seed) seed.fill(0);
    }
  }

  /**
   * Derive Nostr + EVM keys for a specific node type.
   * Accepts an optional `accountIndex` to override the default per-type index.
   * When omitted, uses `NODE_ACCOUNT_INDEX[nodeType]` (existing behavior).
   */
  private deriveNodeKeys(
    seed: Uint8Array,
    nodeType: NodeType,
    accountIndex?: number
  ): NodeKeys {
    const idx = accountIndex ?? NODE_ACCOUNT_INDEX[nodeType];

    // Nostr key: NIP-06 path m/44'/1237'/{account}'/0/0
    const nostrPath = `m/44'/1237'/${idx}'/0/0`;
    const nostrHdKey = HDKey.fromMasterSeed(seed).derive(nostrPath);
    if (!nostrHdKey.privateKey) {
      throw new Error(`Nostr private key missing at ${nostrPath}`);
    }
    const nostrSecretKey = new Uint8Array(nostrHdKey.privateKey);
    const nostrPubkey = getPublicKey(nostrSecretKey);

    // EVM key: standard path m/44'/60'/{account}'/0/0
    const evmPath = `m/44'/60'/${idx}'/0/0`;
    const evmHdKey = HDKey.fromMasterSeed(seed).derive(evmPath);
    if (!evmHdKey.privateKey) {
      throw new Error(`EVM private key missing at ${evmPath}`);
    }
    const evmPrivateKey = new Uint8Array(evmHdKey.privateKey);
    const evmAddress = computeEvmAddress(evmPrivateKey);

    return {
      nostrPubkey,
      nostrSecretKey,
      evmAddress,
      evmPrivateKey,
      nostrDerivationPath: nostrPath,
      evmDerivationPath: evmPath,
    };
  }
}

/**
 * Derive an Arweave RSA-4096 JWK from a BIP-39 seed at a given account index.
 *
 * Algorithm:
 * 1. BIP-32 derive a 32-byte sub-seed at m/44'/472'/{account}'/0/0.
 * 2. Feed that sub-seed into our HMAC-DRBG(SHA-256, seed) PRNG implemented
 *    with @noble/hashes, which drives node-forge 1.3.3 (CVE-free) PRIMEINC
 *    prime search → deterministic RSA keys identical to human-crypto-keys 0.1.4.
 * 3. Parse the PKCS#1 PEM via Node's built-in `crypto.createPrivateKey()`
 *    and export as JWK. Strip non-arweave fields (alg, kid).
 * 4. Compute the Arweave address: base64url(sha256(base64url_decode(n))).
 *
 * Determinism verified empirically: identical seed → identical JWK across runs
 * (Node 20.x, rsa-from-seed.ts, node-forge 1.3.3).
 *
 * Performance: 5–30 seconds per call on a 2024 desktop. This is a one-time
 * cost per wallet unlock — the JWK is then held in memory until `lock()`.
 */
async function deriveArweaveKey(
  seed: Uint8Array,
  accountIndex: number
): Promise<{ jwk: ArweaveJwk; address: string; path: string }> {
  // Coin type 472 = Arweave (https://github.com/satoshilabs/slips/blob/master/slip-0044.md)
  const path = `m/44'/472'/${accountIndex}'/0/0`;
  const hdKey = HDKey.fromMasterSeed(seed).derive(path);
  if (!hdKey.privateKey) {
    throw new Error(`Arweave sub-seed missing at ${path}`);
  }
  const subSeed = new Uint8Array(hdKey.privateKey);

  // rsa-from-seed uses @noble/hashes HMAC-DRBG + node-forge 1.3.3 (CVE-free).
  // Lazy-import keeps startup cheap for Town/Mill callers that never touch Arweave.
  const { rsaPrivateKeyPemFromSeed } = await import('./rsa-from-seed.js');

  let pemPrivateKey: string;
  try {
    pemPrivateKey = await rsaPrivateKeyPemFromSeed(subSeed);
  } finally {
    // Sub-seed leaves the function. Zero it ASAP — the RSA key derived from
    // it is what we keep, not the seed itself.
    subSeed.fill(0);
  }

  // PEM → JWK via Node's built-in crypto (no extra dependency).
  const keyObject = createPrivateKey({
    key: pemPrivateKey,
    format: 'pem',
    type: 'pkcs1',
  });
  const rawJwk = keyObject.export({ format: 'jwk' }) as {
    kty?: string;
    e?: string;
    n?: string;
    d?: string;
    p?: string;
    q?: string;
    dp?: string;
    dq?: string;
    qi?: string;
  };
  if (
    rawJwk.kty !== 'RSA' ||
    !rawJwk.n ||
    !rawJwk.e ||
    !rawJwk.d ||
    !rawJwk.p ||
    !rawJwk.q ||
    !rawJwk.dp ||
    !rawJwk.dq ||
    !rawJwk.qi
  ) {
    throw new Error(
      `Arweave JWK conversion produced unexpected shape (kty=${String(rawJwk.kty)}, has-private=${Boolean(rawJwk.d)})`
    );
  }
  const jwk: ArweaveJwk = {
    kty: 'RSA',
    e: rawJwk.e,
    n: rawJwk.n,
    d: rawJwk.d,
    p: rawJwk.p,
    q: rawJwk.q,
    dp: rawJwk.dp,
    dq: rawJwk.dq,
    qi: rawJwk.qi,
  };

  // Arweave address = base64url(sha256(modulus_bytes)).
  const modulusBytes = Buffer.from(jwk.n, 'base64url');
  const address = createHash('sha256').update(modulusBytes).digest('base64url');

  return { jwk, address, path };
}

/**
 * Zero out every base64url string field of an Arweave JWK in place.
 *
 * RSA private key material lives in `d`, `p`, `q`, `dp`, `dq`, `qi`. String
 * primitives are immutable in JavaScript, so we cannot truly zero them — what
 * we CAN do is overwrite the property with an empty string so a later read of
 * the JWK object after `lock()` cannot recover the key material.
 *
 * This matches the best-effort zeroing approach used elsewhere (Uint8Array
 * `.fill(0)` is similarly best-effort against off-heap copies).
 */
function zeroArweaveJwk(jwk: ArweaveJwk): void {
  // Public components are not secrets; leave them. Wipe private exponents.
  jwk.d = '';
  jwk.p = '';
  jwk.q = '';
  jwk.dp = '';
  jwk.dq = '';
  jwk.qi = '';
}

/**
 * Compute EVM address from private key: uncompressed pubkey -> keccak256 -> last 20 bytes.
 */
function computeEvmAddress(privateKey: Uint8Array): string {
  const uncompressed = secp256k1.getPublicKey(privateKey, false);
  const hash = keccak_256(uncompressed.slice(1));
  const addressHex = bytesToHex(hash.slice(-20));
  return toChecksumAddress(addressHex);
}

/**
 * EIP-55 checksum address encoding.
 */
function toChecksumAddress(addressHex: string): string {
  const lower = addressHex.toLowerCase();
  const hashHex = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const ch = lower.charAt(i);
    const hashNibble = parseInt(hashHex.charAt(i), 16);
    out += hashNibble >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}
