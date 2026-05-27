/**
 * Wallet encryption/decryption for Townhouse (Story 21.4, Task 2).
 *
 * Uses Node.js crypto: scrypt for KDF, AES-256-GCM for authenticated encryption.
 * The mnemonic is the plaintext being encrypted.
 */

import {
  scryptSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import type { ArweaveJwk, EncryptedWallet } from './types.js';

/** scrypt parameters — N=2^17 (~0.5-1s on modern hardware), r=8, p=1 */
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 32;
/** maxmem for scrypt: N * r * 128 * 2 (with headroom for Node.js overhead) */
const SCRYPT_MAXMEM = SCRYPT_N * SCRYPT_R * 256 + 32 * 1024 * 1024;

/** Salt length in bytes */
const SALT_LEN = 32;

/** AES-GCM IV length in bytes */
const IV_LEN = 12;

/** AES-GCM authentication tag length in bytes (128-bit) */
const AUTH_TAG_LEN = 16;

/**
 * Encrypt a mnemonic with a password using scrypt + AES-256-GCM.
 */
export function encryptWallet(
  mnemonic: string,
  password: string
): EncryptedWallet {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);

  const key = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_LEN,
    });
    const ciphertext = Buffer.concat([
      cipher.update(mnemonic, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypt an encrypted wallet with a password.
 * Throws on wrong password (GCM auth tag verification failure).
 */
export function decryptWallet(
  encrypted: EncryptedWallet,
  password: string
): string {
  const salt = Buffer.from(encrypted.salt, 'base64');
  const iv = Buffer.from(encrypted.iv, 'base64');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  const tag = Buffer.from(encrypted.tag, 'base64');

  const key = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_LEN,
    });
    decipher.setAuthTag(tag);

    try {
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      throw new Error(
        'Decryption failed: wrong password or corrupted wallet file'
      );
    }
  } finally {
    key.fill(0);
  }
}

/**
 * Generic string encryption — same envelope as encryptWallet, used by the
 * Arweave JWK cache (epic-49 Followup A) and any future caller that wants
 * to reuse the scrypt+AES-256-GCM primitive without committing to mnemonic
 * semantics.
 */
export function encryptString(
  plaintext: string,
  password: string
): EncryptedWallet {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_LEN,
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
  } finally {
    key.fill(0);
  }
}

/** Inverse of encryptString. Throws on wrong password / corruption. */
export function decryptString(
  encrypted: EncryptedWallet,
  password: string
): string {
  const salt = Buffer.from(encrypted.salt, 'base64');
  const iv = Buffer.from(encrypted.iv, 'base64');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  const tag = Buffer.from(encrypted.tag, 'base64');
  const key = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_LEN,
    });
    decipher.setAuthTag(tag);
    try {
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      throw new Error(
        'Decryption failed: wrong password or corrupted ciphertext'
      );
    }
  } finally {
    key.fill(0);
  }
}

/** Encrypt an Arweave RSA JWK under the operator password (epic-49 Followup A). */
export function encryptArweaveJwk(
  jwk: ArweaveJwk,
  password: string
): EncryptedWallet {
  return encryptString(JSON.stringify(jwk), password);
}

/**
 * Decrypt an Arweave RSA JWK previously produced by `encryptArweaveJwk`.
 * Throws if the password is wrong, ciphertext is corrupt, or the plaintext
 * is not a well-formed JWK (missing `kty`/`n`/`e`).
 */
export function decryptArweaveJwk(
  encrypted: EncryptedWallet,
  password: string
): ArweaveJwk {
  const plaintext = decryptString(encrypted, password);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error(
      'Arweave JWK cache is corrupt: plaintext is not valid JSON'
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { kty?: unknown }).kty !== 'RSA' ||
    typeof (parsed as { n?: unknown }).n !== 'string' ||
    typeof (parsed as { e?: unknown }).e !== 'string'
  ) {
    throw new Error(
      'Arweave JWK cache is corrupt: plaintext is not a well-formed RSA JWK'
    );
  }
  return parsed as ArweaveJwk;
}
