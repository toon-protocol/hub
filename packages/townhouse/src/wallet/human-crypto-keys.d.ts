/**
 * Type declaration for `human-crypto-keys` 0.1.4 — used in
 * `manager.ts::deriveArweaveKey` to deterministically generate RSA-4096
 * keypairs from a BIP-32 sub-seed.
 *
 * The package itself ships no types and is unmaintained (last release 2019).
 * We only consume `getKeyPairFromSeed` with RSA in PKCS#1 PEM form, so the
 * minimal declaration below is sufficient.
 */
declare module 'human-crypto-keys' {
  export interface RsaAlgorithm {
    id: 'rsa';
    modulusLength: number;
    publicExponent?: number;
  }

  export interface KeyPairOptions {
    privateKeyFormat?:
      | 'pkcs1-pem'
      | 'pkcs1-der'
      | 'pkcs8-pem'
      | 'pkcs8-der'
      | 'raw-pem'
      | 'raw-der';
    publicKeyFormat?: 'spki-pem' | 'spki-der' | 'pkcs1-pem' | 'pkcs1-der';
  }

  export interface KeyPair {
    privateKey: string;
    publicKey: string;
  }

  export function getKeyPairFromSeed(
    seed: Uint8Array,
    algorithm: RsaAlgorithm,
    options?: KeyPairOptions
  ): Promise<KeyPair>;

  export function getKeyPairFromMnemonic(
    mnemonic: string,
    algorithm: RsaAlgorithm,
    options?: KeyPairOptions
  ): Promise<KeyPair>;

  export function generateKeyPair(
    algorithm: RsaAlgorithm,
    options?: KeyPairOptions
  ): Promise<KeyPair & { mnemonic: string; seed: Uint8Array }>;
}
