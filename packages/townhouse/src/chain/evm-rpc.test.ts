import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEvmBalance, getErc20Balance } from './evm-rpc.js';

const MOCK_RPC = 'http://localhost:19999';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getEvmBalance', () => {
  it('returns decimal balance string from hex response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: '0xde0b6b3a7640000' }), // 1 ETH in wei
    }));
    const balance = await getEvmBalance(MOCK_RPC, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(balance).toBe('1000000000000000000');
  });

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }));
    await expect(getEvmBalance(MOCK_RPC, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).rejects.toThrow('HTTP 500');
  });

  it('throws on JSON-RPC error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: { message: 'invalid address' } }),
    }));
    await expect(getEvmBalance(MOCK_RPC, 'bad')).rejects.toThrow('invalid address');
  });
});

describe('getErc20Balance', () => {
  it('returns decimal USDC balance from hex response', async () => {
    const usdcRaw = BigInt('1000000'); // 1 USDC (scale 6)
    const hexPadded = '0x' + usdcRaw.toString(16).padStart(64, '0');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: hexPadded }),
    }));
    const balance = await getErc20Balance(MOCK_RPC, '0x1234567890123456789012345678901234567890', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(balance).toBe('1000000');
  });

  it('returns 0 for empty result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: '0x' }),
    }));
    const balance = await getErc20Balance(MOCK_RPC, '0x1234567890123456789012345678901234567890', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(balance).toBe('0');
  });
});
