/**
 * Unit tests for buyCredits (epic-49, Phase 2).
 *
 * Mocks @ardrive/turbo-sdk/node TurboFactory + signer classes. No network,
 * no real wallet. Verifies:
 *   - quote-only path returns without calling topUpWithTokens
 *   - submit path calls topUpWithTokens with correctly-parsed BigInt amounts
 *   - feeMultiplier passes through verbatim
 *   - destinationAddress maps to turboCreditDestinationAddress
 *   - unsupported tokens reject
 *   - human-decimal parsing produces correct base units
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import bs58 from 'bs58';

import { buyCredits } from './buy.js';
import type { WalletManager } from '../wallet/manager.js';
import type { ArweaveJwk, NodeKeys } from '../wallet/types.js';
import type { TurboTokenId } from '../wallet/turbo-signer.js';

// ── Turbo SDK mock ────────────────────────────────────────────────────────

const mockGetWincForToken = vi.fn();
const mockTopUpWithTokens = vi.fn();
const mockAuthenticated = vi.fn();

vi.mock('@ardrive/turbo-sdk/node', async () => {
  // Identity classes — the buildTurboSigner instanceof checks pass because
  // we reuse the same constructors here.
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

// ── Stub WalletManager ────────────────────────────────────────────────────

const STUB_JWK: ArweaveJwk = {
  kty: 'RSA',
  e: 'AQAB',
  n: 'stub_n',
  d: 'stub_d',
  p: 'stub_p',
  q: 'stub_q',
  dp: 'stub_dp',
  dq: 'stub_dq',
  qi: 'stub_qi',
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

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetWincForToken.mockReset();
  mockTopUpWithTokens.mockReset();
  mockAuthenticated.mockReset();
  mockAuthenticated.mockImplementation(() => ({
    getWincForToken: mockGetWincForToken,
    topUpWithTokens: mockTopUpWithTokens,
  }));
});

describe('buyCredits — quote-only path', () => {
  it('returns a quote without calling topUpWithTokens', async () => {
    mockGetWincForToken.mockResolvedValue({
      winc: '1000000000',
      actualTokenAmount: '1000000',
      equivalentWincTokenAmount: '1000000000',
    });

    const result = await buyCredits({
      wallet: makeStubWallet(),
      nodeType: 'dvm',
      token: 'sol',
      amount: '0.001',
      quoteOnly: true,
    });

    expect(result.kind).toBe('quote');
    if (result.kind !== 'quote') throw new Error('expected quote');
    expect(result.winc).toBe(1_000_000_000n);
    expect(result.baseAmount).toBe(1_000_000n); // 0.001 SOL = 1_000_000 lamports
    expect(result.fromAddress).toBe(STUB_SOL_ADDR);
    expect(result.creditAddress).toBe(result.fromAddress);
    expect(mockTopUpWithTokens).not.toHaveBeenCalled();
  });

  it('passes parsed base-unit BigInt as string to getWincForToken', async () => {
    mockGetWincForToken.mockResolvedValue({
      winc: '0',
      actualTokenAmount: '0',
      equivalentWincTokenAmount: '0',
    });

    await buyCredits({
      wallet: makeStubWallet(),
      nodeType: 'dvm',
      token: 'usdc-eth',
      amount: '10',
      quoteOnly: true,
    });

    // USDC has 6 decimals → 10 USDC = 10_000_000 base units.
    expect(mockGetWincForToken).toHaveBeenCalledWith({
      tokenAmount: '10000000',
    });
  });
});

describe('buyCredits — submit path', () => {
  it('calls topUpWithTokens after a successful quote', async () => {
    mockGetWincForToken.mockResolvedValue({
      winc: '1000000000',
      actualTokenAmount: '1000000',
      equivalentWincTokenAmount: '1000000000',
    });
    mockTopUpWithTokens.mockResolvedValue({
      winc: '1000000000',
      id: 'tx-id-12345',
      status: 'pending',
      token: 'solana',
      quantity: '1000000',
      owner: 'owner',
      target: 'target',
    });

    const result = await buyCredits({
      wallet: makeStubWallet(),
      nodeType: 'dvm',
      token: 'sol',
      amount: '0.001',
    });

    expect(result.kind).toBe('submit');
    if (result.kind !== 'submit') throw new Error('expected submit');
    expect(result.id).toBe('tx-id-12345');
    expect(result.status).toBe('pending');
    expect(result.winc).toBe(1_000_000_000n);
    expect(mockTopUpWithTokens).toHaveBeenCalledOnce();
  });

  it('passes feeMultiplier through verbatim', async () => {
    mockGetWincForToken.mockResolvedValue({
      winc: '1',
      actualTokenAmount: '1',
      equivalentWincTokenAmount: '1',
    });
    mockTopUpWithTokens.mockResolvedValue({
      winc: '1',
      id: 'x',
      status: 'pending',
      token: 'ethereum',
      quantity: '1',
      owner: 'o',
      target: 't',
    });

    await buyCredits({
      wallet: makeStubWallet(),
      nodeType: 'dvm',
      token: 'eth',
      amount: '0.0001',
      feeMultiplier: 1.5,
    });

    expect(mockTopUpWithTokens).toHaveBeenCalledWith({
      tokenAmount: '100000000000000', // 0.0001 ETH in wei
      feeMultiplier: 1.5,
    });
  });

  it('maps destinationAddress to turboCreditDestinationAddress', async () => {
    mockGetWincForToken.mockResolvedValue({
      winc: '1',
      actualTokenAmount: '1',
      equivalentWincTokenAmount: '1',
    });
    mockTopUpWithTokens.mockResolvedValue({
      winc: '1',
      id: 'x',
      status: 'pending',
      token: 'solana',
      quantity: '1',
      owner: 'o',
      target: 't',
    });

    await buyCredits({
      wallet: makeStubWallet(),
      nodeType: 'dvm',
      token: 'sol',
      amount: '0.001',
      destinationAddress: 'TargetArweaveAddress_base64',
    });

    expect(mockTopUpWithTokens).toHaveBeenCalledWith({
      tokenAmount: '1000000',
      turboCreditDestinationAddress: 'TargetArweaveAddress_base64',
    });
  });

  it('omits feeMultiplier + destination when not provided', async () => {
    mockGetWincForToken.mockResolvedValue({
      winc: '1',
      actualTokenAmount: '1',
      equivalentWincTokenAmount: '1',
    });
    mockTopUpWithTokens.mockResolvedValue({
      winc: '1',
      id: 'x',
      status: 'pending',
      token: 'solana',
      quantity: '1',
      owner: 'o',
      target: 't',
    });

    await buyCredits({
      wallet: makeStubWallet(),
      nodeType: 'dvm',
      token: 'sol',
      amount: '0.001',
    });

    expect(mockTopUpWithTokens).toHaveBeenCalledWith({
      tokenAmount: '1000000',
    });
  });
});

describe('buyCredits — error paths', () => {
  it('rejects an unsupported token id before contacting Turbo', async () => {
    await expect(
      buyCredits({
        wallet: makeStubWallet(),
        nodeType: 'dvm',
        token: 'btc' as TurboTokenId,
        amount: '1',
      })
    ).rejects.toThrow(/Unknown TurboTokenId/);
    expect(mockGetWincForToken).not.toHaveBeenCalled();
  });

  it('rejects malformed amount before contacting Turbo', async () => {
    await expect(
      buyCredits({
        wallet: makeStubWallet(),
        nodeType: 'dvm',
        token: 'sol',
        amount: '1e-3',
      })
    ).rejects.toThrow(/Invalid decimal/);
    expect(mockGetWincForToken).not.toHaveBeenCalled();
  });

  it('surfaces Turbo getWincForToken errors verbatim', async () => {
    mockGetWincForToken.mockRejectedValue(new Error('network error: timeout'));
    await expect(
      buyCredits({
        wallet: makeStubWallet(),
        nodeType: 'dvm',
        token: 'sol',
        amount: '0.001',
        quoteOnly: true,
      })
    ).rejects.toThrow(/network error: timeout/);
  });
});
