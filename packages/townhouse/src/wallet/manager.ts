/**
 * WalletManager — HD key derivation for Townhouse (Story 21.4, Task 1).
 *
 * Single BIP-39 mnemonic, deterministic HD derivation per node type.
 * Uses BIP-44 paths with distinct account indices per node type:
 *   - Town: account 0
 *   - Mill: account 1
 *   - DVM:  account 2
 *
 * Nostr keys use NIP-06 coin type 1237: m/44'/1237'/{account}'/0/0
 * EVM keys use standard coin type 60:   m/44'/60'/{account}'/0/0
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

import type { NodeType } from '../docker/types.js';
import {
  ACCOUNT_INDEX_TOWN,
  ACCOUNT_INDEX_MILL,
  ACCOUNT_INDEX_DVM,
} from '../constants.js';
import type {
  WalletManagerConfig,
  WalletState,
  NodeKeys,
  DerivedNodeKeys,
  NodeKeyInfo,
} from './types.js';
import { deriveMillKeys } from '@toon-protocol/mill';

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

/** Map node type to account index */
const NODE_ACCOUNT_INDEX: Record<NodeType, number> = {
  town: ACCOUNT_INDEX_TOWN,
  mill: ACCOUNT_INDEX_MILL,
  dvm: ACCOUNT_INDEX_DVM,
};

/**
 * WalletManager handles mnemonic generation, key derivation, and in-memory
 * key lifecycle for Townhouse node operations.
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
      if (nodeType === 'mill') {
        if (keys.solanaAddress) info.solanaAddress = keys.solanaAddress;
        if (keys.minaAddress) info.minaAddress = keys.minaAddress;
      }
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
    }
    this.state = null;
  }

  /**
   * Derive keys for all node types from a mnemonic.
   */
  private async deriveAllKeys(mnemonic: string): Promise<WalletState> {
    let seed: Uint8Array | undefined;
    try {
      seed = mnemonicToSeedSync(mnemonic);
      const millBaseKeys = this.deriveNodeKeys(seed, 'mill');

      // Derive Solana and Mina addresses for the mill node using the same
      // account index as the WalletManager (ACCOUNT_INDEX_MILL = 1). These
      // public addresses are exposed by GET /nodes/mill/deposit-addresses.
      let solanaAddress: string | undefined;
      let minaAddress: string | undefined;
      try {
        const millChainKeys = await deriveMillKeys({
          mnemonic,
          chains: ['solana', 'mina'],
          accountIndex: ACCOUNT_INDEX_MILL,
        });
        if (millChainKeys.solana) {
          solanaAddress = base58Encode(millChainKeys.solana.publicKey);
        }
        if (millChainKeys.mina) {
          minaAddress = millChainKeys.mina.publicKey;
        }
      } catch {
        // deriveMillKeys failure (e.g., unsupported platform) should not
        // prevent wallet init — addresses are optional at derivation time.
      }

      const keys: DerivedNodeKeys = {
        town: this.deriveNodeKeys(seed, 'town'),
        mill: { ...millBaseKeys, solanaAddress, minaAddress },
        dvm: this.deriveNodeKeys(seed, 'dvm'),
      };
      return { keys };
    } finally {
      if (seed) seed.fill(0);
    }
  }

  /**
   * Derive Nostr + EVM keys for a specific node type.
   */
  private deriveNodeKeys(seed: Uint8Array, nodeType: NodeType): NodeKeys {
    const accountIndex = NODE_ACCOUNT_INDEX[nodeType];

    // Nostr key: NIP-06 path m/44'/1237'/{account}'/0/0
    const nostrPath = `m/44'/1237'/${accountIndex}'/0/0`;
    const nostrHdKey = HDKey.fromMasterSeed(seed).derive(nostrPath);
    if (!nostrHdKey.privateKey) {
      throw new Error(`Nostr private key missing at ${nostrPath}`);
    }
    const nostrSecretKey = new Uint8Array(nostrHdKey.privateKey);
    const nostrPubkey = getPublicKey(nostrSecretKey);

    // EVM key: standard path m/44'/60'/{account}'/0/0
    const evmPath = `m/44'/60'/${accountIndex}'/0/0`;
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
