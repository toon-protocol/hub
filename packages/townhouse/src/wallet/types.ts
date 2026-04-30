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
  /** Base58-encoded Solana public key — mill only, omitted for town/dvm */
  solanaAddress?: string;
  /** Mina public key hex — mill only, omitted for town/dvm */
  minaAddress?: string;
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
  /** Base58-encoded Solana public key — mill only, omitted for town/dvm */
  solanaAddress?: string;
  /** Mina public key hex — mill only, omitted for town/dvm */
  minaAddress?: string;
}

/** Persisted wallet state (in memory after decryption) */
export interface WalletState {
  /** All derived node keys */
  keys: DerivedNodeKeys;
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
