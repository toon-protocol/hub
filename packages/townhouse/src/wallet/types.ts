/**
 * Wallet management types for Townhouse (Story 21.4).
 *
 * Defines interfaces for HD wallet key derivation, encryption at rest,
 * and node key management.
 */

import type { NodeType } from '../docker/types.js';

/** Configuration for the WalletManager */
export interface WalletManagerConfig {
  /** Path to encrypted wallet file */
  encryptedPath: string;
}

/**
 * Arweave JWK (RSA-4096) — matches `arweave-js` / `@ardrive/turbo-sdk`
 * `JWKInterface` shape. Defined locally to avoid an arweave-js dependency.
 *
 * All fields are base64url-encoded big-endian integers per JWA (RFC 7518).
 */
export interface ArweaveJwk {
  kty: 'RSA';
  /** Public exponent (typically "AQAB" = 65537) */
  e: string;
  /** Modulus n (base64url) */
  n: string;
  /** Private exponent d */
  d?: string;
  /** First prime factor p */
  p?: string;
  /** Second prime factor q */
  q?: string;
  /** d mod (p-1) */
  dp?: string;
  /** d mod (q-1) */
  dq?: string;
  /** q^-1 mod p */
  qi?: string;
}

/** Keys derived for a specific node type */
export interface NodeKeys {
  /** Nostr public key (hex-encoded, 32 bytes) */
  nostrPubkey: string;
  /** Nostr secret key (raw 32-byte scalar) */
  nostrSecretKey: Uint8Array;
  /** EVM address (checksummed, 0x-prefixed) */
  evmAddress: string;
  /** EVM private key (raw 32 bytes) */
  evmPrivateKey: Uint8Array;
  /** BIP-44 derivation path used for Nostr key */
  nostrDerivationPath: string;
  /** BIP-44 derivation path used for EVM key */
  evmDerivationPath: string;
  /** Base58-encoded Solana public key — derived for all node types */
  solanaAddress?: string;
  /** Raw 32-byte Ed25519 Solana private key seed */
  solanaPrivateKey?: Uint8Array;
  /** BIP-44 derivation path used for Solana key (SLIP-0010 all-hardened) */
  solanaDerivationPath?: string;
  /** Mina public key hex — mill only, omitted for town/dvm */
  minaAddress?: string;
  /** Arweave wallet address (base64url SHA-256 of modulus) — DVM only */
  arweaveAddress?: string;
  /**
   * Arweave RSA-4096 JWK — DVM only. The full private JWK is held in
   * memory for credit-buy + upload signing. Zeroed by `lock()`.
   */
  arweaveJwk?: ArweaveJwk;
  /** BIP-44 derivation path used for the Arweave RSA sub-seed */
  arweaveDerivationPath?: string;
}

/** Map of node type to its derived keys */
export interface DerivedNodeKeys {
  town: NodeKeys;
  mill: NodeKeys;
  dvm: NodeKeys;
}

/** Summary info for display (no secrets) */
export interface NodeKeyInfo {
  /** Node type */
  nodeType: NodeType;
  /** Nostr public key (hex) */
  nostrPubkey: string;
  /** EVM address (checksummed) */
  evmAddress: string;
  /** Nostr derivation path */
  nostrDerivationPath: string;
  /** EVM derivation path */
  evmDerivationPath: string;
  /** Base58-encoded Solana public key — derived for all node types */
  solanaAddress?: string;
  /** Solana derivation path — present whenever solanaAddress is */
  solanaDerivationPath?: string;
  /** Mina public key hex — mill only, omitted for town/dvm */
  minaAddress?: string;
  /** Arweave wallet address (base64url) — DVM only */
  arweaveAddress?: string;
  /** Arweave derivation path — present whenever arweaveAddress is */
  arweaveDerivationPath?: string;
}

/** Persisted wallet state (in memory after decryption) */
export interface WalletState {
  /** All derived node keys */
  keys: DerivedNodeKeys;
  /**
   * BIP-39 mnemonic held in memory for transient re-derivation.
   * Cleared on lock() by setting this.state = null. Never serialized.
   */
  mnemonic: string;
}

/** Encrypted wallet file format (JSON, all fields base64-encoded) */
export interface EncryptedWallet {
  /** scrypt salt (base64) */
  salt: string;
  /** AES-GCM initialization vector (base64) */
  iv: string;
  /** AES-256-GCM ciphertext (base64) */
  ciphertext: string;
  /** AES-GCM authentication tag (base64) */
  tag: string;
}

/**
 * Per-node-type entry in the on-disk AR cache file (epic-49 Followup A).
 * Encrypted JWK + a public sub-seed fingerprint that lets the wallet detect
 * "cache from a different mnemonic" without paying the 5–30s RSA cost.
 */
export interface ArweaveCacheEntry {
  /** SHA-256 of the BIP-32 sub-seed in base64url (NOT secret — fingerprint). */
  subSeedFingerprint: string;
  /** Arweave wallet address derived from the cached JWK (base64url). */
  arweaveAddress: string;
  /** Encrypted JWK plaintext (JSON-serialized) under the operator password. */
  encryptedJwk: EncryptedWallet;
}

/**
 * On-disk format for `wallet.arweave.enc`. Per-node-type keyed so future
 * per-node AR keys are forward-compatible (today only `dvm` populated).
 */
export interface EncryptedArweaveCacheFile {
  /** Schema version — bump if envelope shape changes. */
  version: 1;
  /** Per-node-type entries (only `dvm` populated in v0.1). */
  nodes: Partial<Record<NodeType, ArweaveCacheEntry>>;
}
