import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWalletBalances } from './useWalletBalances';

const BALANCES_PAYLOAD = {
  entries: [
    {
      nodeType: 'town',
      family: 'evm',
      token: 'ETH',
      address: '0x1111',
      balance: '1000',
      scale: 18,
      available: true,
    },
    {
      nodeType: 'mill',
      family: 'solana',
      token: 'SOL',
      address: 'SolAddr',
      balance: '500',
      scale: 9,
      available: true,
    },
  ],
  ts: 1234567890,
};

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(BALANCES_PAYLOAD));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useWalletBalances', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() =>
      useWalletBalances({ url: '/api/wallet/balances', pollIntervalMs: 60_000 })
    );
    expect(result.current.status).toBe('loading');
  });

  it('transitions to ready with entries', async () => {
    const { result } = renderHook(() =>
      useWalletBalances({ url: '/api/wallet/balances', pollIntervalMs: 60_000 })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.ts).toBe(1234567890);
  });

  it('transitions to error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() =>
      useWalletBalances({ url: '/api/wallet/balances', pollIntervalMs: 60_000 })
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('aborts on unmount', async () => {
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(((
      _url: string,
      init?: { signal?: AbortSignal }
    ) => {
      observedSignal = init?.signal;
      return new Promise<Response>(() => {
        /* never resolves */
      });
    }) as unknown as typeof fetch);
    const { unmount } = renderHook(() =>
      useWalletBalances({ url: '/api/wallet/balances', pollIntervalMs: 60_000 })
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
    unmount();
    expect(observedSignal?.aborted).toBe(true);
  });
});
