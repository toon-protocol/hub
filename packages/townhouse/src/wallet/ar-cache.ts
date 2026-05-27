/**
 * On-disk cache for derived Arweave RSA-4096 JWKs (Followup A).
 *
 * The Arweave HD-derivation costs 5–30 s of RSA prime search per process
 * invocation. Persisting the derived JWK to `wallet.arweave.enc` (alongside
 * `wallet.enc`) pays the cost once per wallet, not once per CLI invocation.
 *
 * File format: JSON envelope, mode 0o600, JWK plaintext encrypted with the
 * same operator password as `wallet.enc`. Per-node-type map under `nodes`
 * so future per-node AR keys are forward-compatible (today only `dvm` is
 * populated). Each entry stores a public sub-seed fingerprint and AR address
 * so we can detect a stale cache (different mnemonic) without paying the
 * RSA cost.
 *
 *   {
 *     "version": 1,
 *     "nodes": {
 *       "dvm": {
 *         "subSeedFingerprint": "<base64url-sha256>",
 *         "arweaveAddress":     "<base64url-sha256>",
 *         "encryptedJwk":       { salt, iv, ciphertext, tag }
 *       }
 *     }
 *   }
 */

import { mkdir, readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { NodeType } from '../docker/types.js';
import type {
  ArweaveCacheEntry,
  ArweaveJwk,
  EncryptedArweaveCacheFile,
} from './types.js';
import { decryptArweaveJwk, encryptArweaveJwk } from './crypto.js';

/** Derive the cache file path from the wallet.enc path. Same directory. */
export function arweaveCachePath(encryptedWalletPath: string): string {
  return `${dirname(encryptedWalletPath)}/wallet.arweave.enc`;
}

/**
 * Load and parse the on-disk cache. Returns `null` if the file does not
 * exist. Throws on malformed JSON or schema mismatch.
 */
export async function loadArweaveCacheFile(
  path: string
): Promise<EncryptedArweaveCacheFile | null> {
  let data: string;
  try {
    data = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }

  // Permissions check — surface a warning via stderr if too open (best-effort,
  // mirrors loadWallet behavior; consumers can choose to harden separately).
  try {
    const stats = await stat(path);
    const mode = stats.mode & 0o777;
    if (mode & 0o077) {
      console.error(
        `Warning: arweave cache ${path} has permissions ${mode.toString(8)} (should be 600)`
      );
    }
  } catch {
    /* best-effort */
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(
      `Arweave JWK cache at ${path} is corrupt: not valid JSON. Delete the file and re-run to re-derive.`
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { nodes?: unknown }).nodes !== 'object' ||
    (parsed as { nodes: unknown }).nodes === null
  ) {
    throw new Error(
      `Arweave JWK cache at ${path} is corrupt: unexpected envelope shape. Delete the file and re-run to re-derive.`
    );
  }
  return parsed as EncryptedArweaveCacheFile;
}

/** Result of an attempted cache read — distinguishes miss from mismatch. */
export type ArweaveCacheReadResult =
  | { status: 'miss' }
  | {
      status: 'stale';
      cachedFingerprint: string;
      cachedAddress: string;
    }
  | { status: 'hit'; jwk: ArweaveJwk; entry: ArweaveCacheEntry };

/**
 * Read + verify + decrypt the cached JWK for `nodeType`.
 *
 *  - `miss`  → file or entry absent; caller should derive + write.
 *  - `stale` → entry exists but its sub-seed fingerprint does not match
 *              `expectedFingerprint` (cache was written from a different
 *              mnemonic). Caller should `deleteArweaveJwkFromCache` then
 *              derive + write.
 *  - `hit`   → fingerprint matches; JWK successfully decrypted. **Throws**
 *              if decryption fails (wrong password / corrupt ciphertext) —
 *              the spec disallows silently re-deriving on password mismatch.
 */
export async function readArweaveJwkFromCache(
  path: string,
  nodeType: NodeType,
  password: string,
  expectedFingerprint: string
): Promise<ArweaveCacheReadResult> {
  const file = await loadArweaveCacheFile(path);
  if (!file) return { status: 'miss' };
  const entry = file.nodes[nodeType];
  if (!entry) return { status: 'miss' };

  // Validate entry shape before doing anything else.
  if (
    typeof entry.subSeedFingerprint !== 'string' ||
    typeof entry.arweaveAddress !== 'string' ||
    typeof entry.encryptedJwk !== 'object' ||
    entry.encryptedJwk === null
  ) {
    throw new Error(
      `Arweave JWK cache entry for ${nodeType} at ${path} is corrupt: missing fields.`
    );
  }

  if (entry.subSeedFingerprint !== expectedFingerprint) {
    return {
      status: 'stale',
      cachedFingerprint: entry.subSeedFingerprint,
      cachedAddress: entry.arweaveAddress,
    };
  }

  // Fingerprint matched — now decrypt. If this throws, the password is wrong
  // (or the JWK plaintext is malformed); both surface to the caller.
  const jwk = decryptArweaveJwk(entry.encryptedJwk, password);
  return { status: 'hit', jwk, entry };
}

/**
 * Encrypt and write `jwk` for `nodeType` into the cache file. Preserves
 * entries for other node types. Idempotent re-write (overwrites the same
 * entry). File mode is 0o600; parent directory is created if missing.
 */
export async function writeArweaveJwkToCache(
  path: string,
  nodeType: NodeType,
  jwk: ArweaveJwk,
  password: string,
  subSeedFingerprint: string,
  arweaveAddress: string
): Promise<void> {
  const existing = await loadArweaveCacheFile(path);
  const entry: ArweaveCacheEntry = {
    subSeedFingerprint,
    arweaveAddress,
    encryptedJwk: encryptArweaveJwk(jwk, password),
  };
  const file: EncryptedArweaveCacheFile = existing ?? {
    version: 1,
    nodes: {},
  };
  file.nodes[nodeType] = entry;

  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(file, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * Delete the cache entry for a specific node type. Used when a stale-cache
 * mismatch is detected (e.g., operator restored from a different mnemonic).
 * No-op if the file or entry does not exist. Removes the file entirely
 * when the last entry is dropped, to keep the on-disk surface tidy.
 */
export async function deleteArweaveJwkFromCache(
  path: string,
  nodeType: NodeType
): Promise<void> {
  const file = await loadArweaveCacheFile(path);
  if (!file) return;
  if (!(nodeType in file.nodes)) return;
  const { [nodeType]: _removed, ...remaining } = file.nodes;
  file.nodes = remaining;

  if (Object.keys(file.nodes).length === 0) {
    try {
      await unlink(path);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return;
      }
      throw err;
    }
    return;
  }

  await writeFile(path, JSON.stringify(file, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}
