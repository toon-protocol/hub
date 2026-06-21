/**
 * Unit tests for getCreditBalance (epic-49, Phase 2).
 *
 * Mocks TurboFactory.authenticated()'s getBalance. Verifies that the
 * BigInt-typed result reflects Turbo's string fields, and that explicit
 * address overrides flow through to getBalance(address).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import bs58 from 'bs58';

import { getCreditBalance } from './balance.js';
import type { WalletManager } from '../wallet/manager.js';
import type { ArweaveJwk, NodeKeys } from '../wallet/types.js';

const mockGetBalance = vi.fn();
const mockAuthenticated = vi.fn();

vi.mock('@ardrive/turbo-sdk/node', async () => {
  class ArweaveSigner {
    constructor(public jwk: unknown) {}
  }
  class EthereumSigner {
    constructor(public hex: string) {}
  }
  class HexSolanaSigner {
    constructor(public hex: string) {}
  }
  return {
    ArweaveSigner,
    EthereumSigner,
    HexSolanaSigner,
    TurboFactory: {
      authenticated: (...args: unknown[]) => mockAuthenticated(...args),
    },
  };
});

const STUB_JWK: ArweaveJwk = {
  kty: 'RSA',
  e: 'AQAB',
  n: 'stub',
  d: 'stub',
  p: 'stub',
  q: 'stub',
  dp: 'stub',
  dq: 'stub',
  qi: 'stub',
};

/** Valid 32-byte SOL public key base58 — turbo-signer validates length. */
const STUB_SOL_ADDR = bs58.encode(Buffer.alloc(32, 0x33));

function makeStubWallet(): WalletManager {
  const stubKeys = {
    evmAddress: '0x0000000000000000000000000000000000000abc',
    solanaAddress: STUB_SOL_ADDR,
    arweaveAddress: 'ArAddressStub_base64url',
    arweaveJwk: STUB_JWK,
  } as Partial<NodeKeys>;
  return {
    getEvmPrivateKeyHex: () => '11'.repeat(32),
    getSolanaPrivateKeyHex: () => '22'.repeat(32),
    getArweaveJwk: () => STUB_JWK,
    getNodeKeys: () => stubKeys as NodeKeys,
    ensureArweaveKey: async () => STUB_JWK,
  } as unknown as WalletManager;
}

beforeEach(() => {
  mockGetBalance.mockReset();
  mockAuthenticated.mockReset();
  mockAuthenticated.mockImplementation(() => ({
    getBalance: mockGetBalance,
  }));
});

describe('getCreditBalance — happy path', () => {
  it('returns BigInt-typed balance for the signer address', async () => {
    mockGetBalance.mockResolvedValue({
      winc: '1000000000',
      controlledWinc: '1000000000',
      effectiveBalance: '1000000000',
      receivedApprovals: [],
      givenApprovals: [],
    });

    const result = await getCreditBalance({
      wallet: makeStubWallet(),
      nodeType: 'dvm',
      token: 'sol',
    });

    expect(result.winc).toBe(1_000_000_000n);
    expect(result.controlledWinc).toBe(1_000_000_000n);
    expect(result.effectiveBalance).toBe(1_000_000_000n);
    expect(result.address).toBe(STUB_SOL_ADDR);
    // getBalance() called with no args = signer's native address.
    expect(mockGetBalance).toHaveBeenCalledWith();
  });

  it('passes explicit address to getBalance(address)', async () => {
    mockGetBalance.mockResolvedValue({
      winc: '500',
      controlledWinc: '500',
      effectiveBalance: '500',
      receivedApprovals: [],
      givenApprovals: [],
    });

    const result = await getCreditBalance({
      wallet: makeStubWallet(),
      nodeType: 'dvm',
      token: 'sol',
      address: 'OverrideArAddress_base64',
    });

    expect(mockGetBalance).toHaveBeenCalledWith('OverrideArAddress_base64');
    expect(result.address).toBe('OverrideArAddress_base64');
    expect(result.winc).toBe(500n);
  });
});

describe('getCreditBalance — error paths', () => {
  it('surfaces Turbo getBalance errors verbatim', async () => {
    mockGetBalance.mockRejectedValue(new Error('payment service unavailable'));
    await expect(
      getCreditBalance({
        wallet: makeStubWallet(),
        nodeType: 'dvm',
        token: 'sol',
      })
    ).rejects.toThrow(/payment service unavailable/);
  });
});
