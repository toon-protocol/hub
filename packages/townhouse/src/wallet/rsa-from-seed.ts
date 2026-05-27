/**
 * rsa-from-seed — CVE-free replacement for human-crypto-keys RSA derivation.
 *
 * Produces byte-for-byte identical RSA-4096 keys as
 * `human-crypto-keys.getKeyPairFromSeed(seed, {id:'rsa', modulusLength:4096},
 *   {privateKeyFormat:'pkcs1-pem'})`.
 *
 * Algorithm (preserved exactly to maintain golden test vectors):
 *   1. HMAC-DRBG(SHA-256, entropy=seed, nonce=[], pers=[])
 *      Re-implemented with @noble/hashes (already a workspace dep).
 *      Byte-for-byte identical to hmac-drbg@1.0.1 used by human-crypto-keys.
 *   2. node-forge 1.3.3 (CVE-free) PRIMEINC prime search driven by (1).
 *      Identical to node-forge 0.8.5 because jsbn.js and the PRIMEINC loop
 *      are unchanged between versions (verified by diff).
 *   3. Export private key as PKCS#1 PEM string.
 *
 * Why not Node.js crypto.generateKeyPair?
 *   It uses OpenSSL's system CSPRNG and cannot be seeded deterministically.
 *
 * Performance: same as before (~5–30s for RSA-4096 on a 2024 desktop).
 * The on-disk ar-cache.ts already amortises this cost after first derivation.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

// ── HMAC-DRBG (SP 800-90A, SHA-256 variant) ─────────────────────────────────
//
// Replicates hmac-drbg@1.0.1 with one key behavioural detail:
//   generate(n) in hmac-drbg discards leftover bytes and calls _update()
//   AFTER each call (not per 32-byte V-block).  Our getBytesSync() mirrors
//   that exact behaviour: generate fresh V-chain on every call, discard
//   surplus, then do a 2-step _update (no seed data ⇒ only K/V steps 1+2).

function hmacSha256(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const h = hmac.create(sha256, key);
  for (const p of parts) h.update(p);
  return h.digest();
}

const BYTE_00 = new Uint8Array([0x00]);
const BYTE_01 = new Uint8Array([0x01]);

/**
 * Create a HMAC-DRBG PRNG that returns forge-compatible "binary strings"
 * (Latin-1 encoded byte strings used internally by node-forge).
 *
 * @param seedBytes  32-byte BIP-32 sub-seed (raw entropy; hex-decoding step
 *                   from human-crypto-keys is a no-op and not replicated).
 * @param rawEncode  `forge.util.binary.raw.encode` — converts Uint8Array to
 *                   forge's internal binary string format.
 */
function makeHmacDrbgPrng(
  seedBytes: Uint8Array,
  rawEncode: (bytes: Uint8Array) => string
): { getBytesSync: (n: number) => string } {
  // Initialise K and V per SP 800-90A §10.1.2.3
  let K = new Uint8Array(32).fill(0x00);
  let V = new Uint8Array(32).fill(0x01);

  // _update(seed) — seeding phase (seed data present → full 4-step update)
  K = hmacSha256(K, V, BYTE_00, seedBytes);
  V = hmacSha256(K, V);
  K = hmacSha256(K, V, BYTE_01, seedBytes);
  V = hmacSha256(K, V);

  return {
    getBytesSync(size: number): string {
      // Generate V-chain until we have enough bytes (same as hmac-drbg's
      // `while (temp.length < len) { V = HMAC(K, V); temp.concat(V); }`).
      // Surplus bytes beyond `size` are discarded on purpose — matches the
      // original `temp.slice(0, len)` behaviour that ensures determinism.
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < size) {
        V = hmacSha256(K, V);
        chunks.push(V);
        total += V.length;
      }
      // Flatten and slice
      const flat = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        flat.set(c, offset);
        offset += c.length;
      }
      const out = flat.slice(0, size);

      // _update(undefined) — post-generate state update (2-step only,
      // since there is no additional data; mirrors the `if(!seed) return`
      // branch in hmac-drbg._update).
      K = hmacSha256(K, V, BYTE_00);
      V = hmacSha256(K, V);

      return rawEncode(out);
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Derive a deterministic RSA-4096 PKCS#1 PEM private key from a 32-byte seed.
 *
 * Identical output to:
 *   `human-crypto-keys.getKeyPairFromSeed(seed, {id:'rsa', modulusLength:4096},
 *     {privateKeyFormat:'pkcs1-pem'}).privateKey`
 *
 * @param seed  32-byte BIP-32 sub-seed. Zeroed by caller after this returns.
 * @returns     PKCS#1 PEM-encoded RSA-4096 private key string.
 */
export async function rsaPrivateKeyPemFromSeed(
  seed: Uint8Array
): Promise<string> {
  // Lazy-import node-forge so callers that never touch Arweave don't pay the
  // module-load cost.  node-forge is a CJS module; dynamic import wraps it.
  const forge = (await import('node-forge')).default;

  const prng = makeHmacDrbgPrng(seed, (bytes) =>
    forge.util.binary.raw.encode(bytes)
  );

  // Promisify the callback-based generateKeyPair
  const { privateKey } = await new Promise<{
    privateKey: forge.pki.rsa.PrivateKey;
    publicKey: forge.pki.rsa.PublicKey;
  }>((resolve, reject) => {
    forge.pki.rsa.generateKeyPair(
      4096,
      65537,
      { prng, algorithm: 'PRIMEINC' },
      (err, kp) => (err ? reject(err) : resolve(kp))
    );
  });

  return forge.pki.privateKeyToPem(privateKey);
}
