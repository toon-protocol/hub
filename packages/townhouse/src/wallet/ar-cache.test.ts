import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  arweaveCachePath,
  loadArweaveCacheFile,
  readArweaveJwkFromCache,
  writeArweaveJwkToCache,
  deleteArweaveJwkFromCache,
} from './ar-cache.js';
import type { ArweaveJwk } from './types.js';

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `townhouse-ar-cache-test-${randomBytes(8).toString('hex')}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal JWK that passes decryptArweaveJwk's kty/n/e validation. */
const FAKE_JWK: ArweaveJwk = {
  kty: 'RSA',
  e: 'AQAB',
  n: Buffer.alloc(512, 0xaa).toString('base64url'),
};

const PASSWORD = 'test-password-123';
const FINGERPRINT = 'abc123fingerprint';
const AR_ADDRESS = 'test-ar-address';

describe('arweaveCachePath', () => {
  it('returns wallet.arweave.enc in the same directory as wallet.enc', () => {
    expect(arweaveCachePath('/home/user/.townhouse/wallet.enc')).toBe(
      '/home/user/.townhouse/wallet.arweave.enc'
    );
  });

  it('handles nested paths', () => {
    expect(arweaveCachePath('/a/b/c/wallet.enc')).toBe(
      '/a/b/c/wallet.arweave.enc'
    );
  });
});

describe('loadArweaveCacheFile', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  it('returns null when file does not exist', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const result = await loadArweaveCacheFile(join(dir, 'wallet.arweave.enc'));
    expect(result).toBeNull();
  });

  it('throws on invalid JSON', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    writeFileSync(path, 'not json', { mode: 0o600 });
    await expect(loadArweaveCacheFile(path)).rejects.toThrow(
      /corrupt: not valid JSON/
    );
  });

  it('throws when version field is missing', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    writeFileSync(path, JSON.stringify({ nodes: {} }), { mode: 0o600 });
    await expect(loadArweaveCacheFile(path)).rejects.toThrow(
      /corrupt: unexpected envelope shape/
    );
  });

  it('throws when nodes field is missing', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    writeFileSync(path, JSON.stringify({ version: 1 }), { mode: 0o600 });
    await expect(loadArweaveCacheFile(path)).rejects.toThrow(
      /corrupt: unexpected envelope shape/
    );
  });

  it('returns parsed object for valid envelope', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const walletPath = join(dir, 'wallet.enc');
    const cachePath = arweaveCachePath(walletPath);
    await writeArweaveJwkToCache(
      cachePath,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    const result = await loadArweaveCacheFile(cachePath);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(typeof result!.nodes).toBe('object');
  });
});

describe('writeArweaveJwkToCache + readArweaveJwkFromCache', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  it('returns miss when cache file does not exist', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    const result = await readArweaveJwkFromCache(
      path,
      'dvm',
      PASSWORD,
      FINGERPRINT
    );
    expect(result.status).toBe('miss');
  });

  it('returns miss when entry for nodeType is absent', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    const result = await readArweaveJwkFromCache(
      path,
      'town',
      PASSWORD,
      FINGERPRINT
    );
    expect(result.status).toBe('miss');
  });

  it('returns stale when fingerprint does not match', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    const result = await readArweaveJwkFromCache(
      path,
      'dvm',
      PASSWORD,
      'different-fingerprint'
    );
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.cachedFingerprint).toBe(FINGERPRINT);
      expect(result.cachedAddress).toBe(AR_ADDRESS);
    }
  });

  it('returns hit with decrypted JWK on fingerprint match', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    const result = await readArweaveJwkFromCache(
      path,
      'dvm',
      PASSWORD,
      FINGERPRINT
    );
    expect(result.status).toBe('hit');
    if (result.status === 'hit') {
      expect(result.jwk.kty).toBe('RSA');
      expect(result.jwk.e).toBe(FAKE_JWK.e);
      expect(result.jwk.n).toBe(FAKE_JWK.n);
    }
  });

  it('throws on wrong password even when fingerprint matches', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    await expect(
      readArweaveJwkFromCache(path, 'dvm', 'wrong-password', FINGERPRINT)
    ).rejects.toThrow(/Decryption failed/);
  });

  it('creates file with mode 0o600', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('preserves entries for other node types on re-write', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    await writeArweaveJwkToCache(
      path,
      'mill',
      FAKE_JWK,
      PASSWORD,
      'mill-fp',
      'mill-addr'
    );
    const file = await loadArweaveCacheFile(path);
    expect(file!.nodes['dvm']).toBeDefined();
    expect(file!.nodes['mill']).toBeDefined();
  });

  it('idempotent re-write updates the entry for the same node type', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    const newFp = 'new-fingerprint';
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      newFp,
      AR_ADDRESS
    );
    const file = await loadArweaveCacheFile(path);
    expect(file!.nodes['dvm']!.subSeedFingerprint).toBe(newFp);
  });

  it('creates parent directory if missing', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'nested', 'deep', 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    expect(existsSync(path)).toBe(true);
  });
});

describe('deleteArweaveJwkFromCache', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  it('is a no-op when file does not exist', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await expect(deleteArweaveJwkFromCache(path, 'dvm')).resolves.not.toThrow();
  });

  it('is a no-op when entry for nodeType is absent', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    await deleteArweaveJwkFromCache(path, 'town');
    expect(existsSync(path)).toBe(true);
    const file = await loadArweaveCacheFile(path);
    expect(file!.nodes['dvm']).toBeDefined();
  });

  it('removes the entry and deletes the file when it was the only entry', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    await deleteArweaveJwkFromCache(path, 'dvm');
    expect(existsSync(path)).toBe(false);
  });

  it('removes the entry and retains file when other entries exist', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    await writeArweaveJwkToCache(
      path,
      'mill',
      FAKE_JWK,
      PASSWORD,
      'mill-fp',
      'mill-addr'
    );
    await deleteArweaveJwkFromCache(path, 'dvm');
    expect(existsSync(path)).toBe(true);
    const file = await loadArweaveCacheFile(path);
    expect(file!.nodes['dvm']).toBeUndefined();
    expect(file!.nodes['mill']).toBeDefined();
  });

  it('after delete, readArweaveJwkFromCache returns miss', async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const path = join(dir, 'wallet.arweave.enc');
    await writeArweaveJwkToCache(
      path,
      'dvm',
      FAKE_JWK,
      PASSWORD,
      FINGERPRINT,
      AR_ADDRESS
    );
    await deleteArweaveJwkFromCache(path, 'dvm');
    const result = await readArweaveJwkFromCache(
      path,
      'dvm',
      PASSWORD,
      FINGERPRINT
    );
    expect(result.status).toBe('miss');
  });
});
