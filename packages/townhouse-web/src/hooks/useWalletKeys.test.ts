import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWalletKeys } from './useWalletKeys';

const KEYS_PAYLOAD = {
  keys: [
    { nodeType: 'town', nostrPubkey: 'aabb', evmAddress: '0x1111', nostrDerivationPath: "m/44'/1237'/0'/0/0", evmDerivationPath: "m/44'/60'/0'/0/0" },
    { nodeType: 'mill', nostrPubkey: 'ccdd', evmAddress: '0x2222', nostrDerivationPath: "m/44'/1237'/1'/0/0", evmDerivationPath: "m/44'/60'/1'/0/0" },
    { nodeType: 'dvm',  nostrPubkey: 'eeff', evmAddress: '0x3333', nostrDerivationPath: "m/44'/1237'/2'/0/0", evmDerivationPath: "m/44'/60'/2'/0/0" },
  ],
};

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(KEYS_PAYLOAD));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useWalletKeys', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() => useWalletKeys({ url: '/api/wallet' }));
    expect(result.current.status).toBe('loading');
  });

  it('transitions to ready with keys', async () => {
    const { result } = renderHook(() => useWalletKeys({ url: '/api/wallet' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.keys).toHaveLength(3);
    expect(result.current.keys[0]?.nodeType).toBe('town');
  });

  it('transitions to error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useWalletKeys({ url: '/api/wallet' }));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('refetch triggers a new fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(KEYS_PAYLOAD));
    const { result } = renderHook(() => useWalletKeys({ url: '/api/wallet' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    result.current.refetch();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });

  it('aborts on unmount', async () => {
    // Capture the AbortSignal that fetch is called with so we can assert it
    // actually transitions to aborted after unmount.
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(((_url: string, init?: { signal?: AbortSignal }) => {
      observedSignal = init?.signal;
      return new Promise<Response>(() => { /* never resolves — pending until abort */ });
    }) as unknown as typeof fetch);
    const { unmount } = renderHook(() => useWalletKeys({ url: '/api/wallet' }));
    await new Promise((r) => setTimeout(r, 0)); // let the effect run
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
    unmount();
    expect(observedSignal?.aborted).toBe(true);
  });
});
