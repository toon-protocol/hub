/**
 * Wallet module public API (Story 21.4).
 */

export { WalletManager } from './manager.js';
export { encryptWallet, decryptWallet } from './crypto.js';
export { saveWallet, loadWallet } from './storage.js';
export type {
  WalletManagerConfig,
  WalletState,
  NodeKeys,
  DerivedNodeKeys,
  NodeKeyInfo,
  EncryptedWallet,
} from './types.js';
