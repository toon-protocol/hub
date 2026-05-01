import { describe, it, expect, vi, afterEach } from 'vitest';
import { getMinaBalance } from './mina-graphql.js';

const MOCK_URL = 'http://localhost:19999/graphql';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getMinaBalance', () => {
  it('converts MINA decimal string to nanomina', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { account: { balance: { total: '1000.000000000' } } },
      }),
    }));
    const balance = await getMinaBalance(MOCK_URL, 'B62...');
    expect(balance).toBe('1000000000000'); // 1000 MINA * 1e9
  });

  it('returns 0 when account is null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { account: null } }),
    }));
    const balance = await getMinaBalance(MOCK_URL, 'B62...');
    expect(balance).toBe('0');
  });

  it('throws on GraphQL errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [{ message: 'not found' }] }),
    }));
    await expect(getMinaBalance(MOCK_URL, 'bad')).rejects.toThrow('not found');
  });
});
