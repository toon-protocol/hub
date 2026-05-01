import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWalletReveal } from './useWalletReveal';

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useWalletReveal', () => {
  it('happy path returns mnemonic', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ mnemonic: 'abandon abandon about' }));
    const { result } = renderHook(() => useWalletReveal({ url: '/api/wallet/reveal' }));
    const res = await result.current.reveal('mypassword');
    expect('mnemonic' in res && res.mnemonic).toBe('abandon abandon about');
  });

  it('401 returns invalid_password', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ error: 'invalid_password' }, 401));
    const { result } = renderHook(() => useWalletReveal({ url: '/api/wallet/reveal' }));
    const res = await result.current.reveal('wrongpassword');
    expect('error' in res && res.error).toBe('invalid_password');
  });

  it('503 returns wallet_not_initialized', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ error: 'wallet_not_initialized' }, 503));
    const { result } = renderHook(() => useWalletReveal({ url: '/api/wallet/reveal' }));
    const res = await result.current.reveal('password');
    expect('error' in res && res.error).toBe('wallet_not_initialized');
  });
});
