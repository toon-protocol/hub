import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSolanaBalance } from './solana-rpc.js';

const MOCK_RPC = 'http://localhost:19999';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getSolanaBalance', () => {
  it('returns lamports as decimal string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { value: 10_000_000_000 } }), // 10 SOL
    }));
    const balance = await getSolanaBalance(MOCK_RPC, 'SomeBase58Addr');
    expect(balance).toBe('10000000000');
  });

  it('returns 0 when value is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: {} }),
    }));
    const balance = await getSolanaBalance(MOCK_RPC, 'SomeBase58Addr');
    expect(balance).toBe('0');
  });

  it('throws on RPC error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: { message: 'account not found' } }),
    }));
    await expect(getSolanaBalance(MOCK_RPC, 'bad')).rejects.toThrow('account not found');
  });
});
