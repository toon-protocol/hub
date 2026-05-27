/**
 * Unit tests for the Turbo SDK signer factory (epic-49, Phase 2).
 *
 * Verifies the EVM family / SOL / AR mapping produces the right concrete
 * signer class from @ardrive/turbo-sdk/node (which re-exports from
 * @dha-team/arbundles). Uses a stub WalletManager — no real BIP-39
 * derivation needed.
 */

import { describe, it, expect } from 'vitest';
import {
  ArweaveSigner,
  EthereumSigner,
  HexSolanaSigner,
} from '@ardrive/turbo-sdk/node';
import bs58 from 'bs58';

import {
  buildTurboSigner,
  canonicalTurboToken,
  type TurboTokenId,
} from './turbo-signer.js';
import type { WalletManager } from './manager.js';
import type { ArweaveJwk, NodeKeys } from './types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

/** Deterministic 32-byte hex (not a real key — never used on-chain). */
const FAKE_EVM_HEX = '11'.repeat(32);
const FAKE_SOL_HEX = '22'.repeat(32);
const FAKE_EVM_ADDR = '0x0000000000000000000000000000000000000001';
/**
 * Valid 32-byte SOL public key base58-encoded — must round-trip through
 * `bs58.decode` to exactly 32 bytes. The HexSolanaSigner constructor expects
 * a base58-encoded 64-byte secret (32 priv + 32 pub); turbo-signer.ts
 * validates each half is 32 bytes.
 */
const FAKE_SOL_ADDR = bs58.encode(Buffer.alloc(32, 0x33));
const FAKE_AR_ADDR = 'sample_arweave_address_base64url';

/**
 * Minimum-viable JWK for ArweaveSigner construction. The signer only checks
 * that `n` + `e` are non-empty strings during constructor (full signing
 * would need all the RSA components, but we never invoke `sign()` here).
 *
 * The real Arweave RSA-4096 derivation is 5-30s; we use a stub to keep the
 * test fast (<10ms).
 */
const STUB_JWK: ArweaveJwk = {
  kty: 'RSA',
  e: 'AQAB',
  n: 'sample_modulus_base64url',
  d: 'sample_private_exponent',
  p: 'sample_p',
  q: 'sample_q',
  dp: 'sample_dp',
  dq: 'sample_dq',
  qi: 'sample_qi',
};

/** Build a stub WalletManager. Only the methods used by buildTurboSigner. */
function makeStubWallet(): WalletManager {
  const stubKeys: Partial<NodeKeys> = {
    evmAddress: FAKE_EVM_ADDR,
    solanaAddress: FAKE_SOL_ADDR,
    arweaveAddress: FAKE_AR_ADDR,
    arweaveJwk: STUB_JWK,
  };
  return {
    getEvmPrivateKeyHex: (_n: string) => FAKE_EVM_HEX,
    getSolanaPrivateKeyHex: (_n: string) => FAKE_SOL_HEX,
    getArweaveJwk: (_n: string) => STUB_JWK,
    getNodeKeys: (_n: string) => stubKeys as NodeKeys,
    ensureArweaveKey: async (_n: string) => STUB_JWK,
  } as unknown as WalletManager;
}

// ── canonicalTurboToken ───────────────────────────────────────────────────

describe('canonicalTurboToken', () => {
  it('maps every friendly id to a Turbo canonical token string', () => {
    expect(canonicalTurboToken('eth')).toBe('ethereum');
    expect(canonicalTurboToken('pol')).toBe('pol');
    expect(canonicalTurboToken('base-eth')).toBe('base-eth');
    expect(canonicalTurboToken('base-usdc')).toBe('base-usdc');
    expect(canonicalTurboToken('usdc-eth')).toBe('usdc');
    expect(canonicalTurboToken('usdc-pol')).toBe('polygon-usdc');
    expect(canonicalTurboToken('sol')).toBe('solana');
    expect(canonicalTurboToken('ar')).toBe('arweave');
  });

  it('throws on unknown ids', () => {
    expect(() => canonicalTurboToken('btc' as TurboTokenId)).toThrow(
      /Unknown TurboTokenId/
    );
  });
});

// ── buildTurboSigner — EVM family ─────────────────────────────────────────

const EVM_FAMILY: TurboTokenId[] = [
  'eth',
  'pol',
  'base-eth',
  'base-usdc',
  'usdc-eth',
  'usdc-pol',
];

describe('buildTurboSigner — EVM family', () => {
  for (const token of EVM_FAMILY) {
    it(`builds an EthereumSigner for token='${token}'`, async () => {
      const wallet = makeStubWallet();
      const bundle = await buildTurboSigner(wallet, 'dvm', token);
      expect(bundle.signer).toBeInstanceOf(EthereumSigner);
      expect(bundle.address).toBe(FAKE_EVM_ADDR);
      expect(typeof bundle.token).toBe('string');
      expect(bundle.token.length).toBeGreaterThan(0);
    });
  }

  it('passes the friendly token id through to canonical mapping', async () => {
    const wallet = makeStubWallet();
    const bundle = await buildTurboSigner(wallet, 'dvm', 'usdc-eth');
    expect(bundle.token).toBe('usdc');
  });
});

// ── buildTurboSigner — Solana ─────────────────────────────────────────────

describe('buildTurboSigner — sol', () => {
  it('builds a HexSolanaSigner for token=sol', async () => {
    const wallet = makeStubWallet();
    const bundle = await buildTurboSigner(wallet, 'dvm', 'sol');
    expect(bundle.signer).toBeInstanceOf(HexSolanaSigner);
    expect(bundle.token).toBe('solana');
    expect(bundle.address).toBe(FAKE_SOL_ADDR);
  });
});

// ── buildTurboSigner — Arweave ────────────────────────────────────────────

describe('buildTurboSigner — ar', () => {
  it('builds an ArweaveSigner for token=ar (calls ensureArweaveKey first)', async () => {
    let ensureCalled = false;
    const wallet = {
      ...makeStubWallet(),
      ensureArweaveKey: async (_n: string) => {
        ensureCalled = true;
        return STUB_JWK;
      },
    } as unknown as WalletManager;

    const bundle = await buildTurboSigner(wallet, 'dvm', 'ar');
    expect(ensureCalled).toBe(true);
    expect(bundle.signer).toBeInstanceOf(ArweaveSigner);
    expect(bundle.token).toBe('arweave');
    expect(bundle.address).toBe(FAKE_AR_ADDR);
  });

  it('throws if arweaveAddress is missing after ensureArweaveKey', async () => {
    const wallet = {
      getEvmPrivateKeyHex: () => FAKE_EVM_HEX,
      getSolanaPrivateKeyHex: () => FAKE_SOL_HEX,
      getArweaveJwk: () => STUB_JWK,
      getNodeKeys: () => ({ evmAddress: FAKE_EVM_ADDR }) as NodeKeys,
      ensureArweaveKey: async () => STUB_JWK,
    } as unknown as WalletManager;

    await expect(buildTurboSigner(wallet, 'dvm', 'ar')).rejects.toThrow(
      /Arweave address not populated/
    );
  });
});

// ── buildTurboSigner — error paths ────────────────────────────────────────

describe('buildTurboSigner — error paths', () => {
  it('surfaces missing Solana key from WalletManager', async () => {
    const wallet = {
      getEvmPrivateKeyHex: () => FAKE_EVM_HEX,
      getSolanaPrivateKeyHex: () => {
        throw new Error("Solana private key not available for node 'town'");
      },
      getNodeKeys: () => ({}) as NodeKeys,
    } as unknown as WalletManager;

    await expect(buildTurboSigner(wallet, 'town', 'sol')).rejects.toThrow(
      /Solana private key not available/
    );
  });

  it('throws for an unsupported token id', async () => {
    const wallet = makeStubWallet();
    await expect(
      buildTurboSigner(wallet, 'dvm', 'btc' as TurboTokenId)
    ).rejects.toThrow(/Unknown TurboTokenId/);
  });
});
