import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWalletWithdraw } from './useWalletWithdraw';

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const MOCK_TX_HASH = '0x' + 'ab'.repeat(32);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useWalletWithdraw', () => {
  it('submit — happy path returns txHash', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ txHash: MOCK_TX_HASH, chainId: 31337 })
    );
    const { result } = renderHook(() => useWalletWithdraw({ withdrawUrl: '/api/wallet/withdraw' }));
    const res = await result.current.submit({
      nodeType: 'town',
      chainFamily: 'evm',
      token: 'native',
      recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      amount: '100000000000000000',
    });
    expect(res.txHash).toBe(MOCK_TX_HASH);
    expect(res.chainId).toBe(31337);
  });

  it('submit — 501 for Solana', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ error: 'chain_not_supported_for_withdrawal' }, 501)
    );
    const { result } = renderHook(() => useWalletWithdraw({ withdrawUrl: '/api/wallet/withdraw' }));
    const res = await result.current.submit({
      nodeType: 'mill',
      chainFamily: 'solana',
      token: 'native',
      recipient: 'SomeAddr',
      amount: '1000000000',
    });
    expect('error' in res).toBe(true);
  });

  it('submit — 400 for insufficient balance', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ error: 'insufficient_balance' }, 400)
    );
    const { result } = renderHook(() => useWalletWithdraw({ withdrawUrl: '/api/wallet/withdraw' }));
    const res = await result.current.submit({
      nodeType: 'town',
      chainFamily: 'evm',
      token: 'native',
      recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      amount: '9999999999999999999999999',
    });
    expect('error' in res).toBe(true);
  });

  it('getReceipt — polls and returns receipt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ status: 'success', blockNumber: 42, txHash: MOCK_TX_HASH })
    );
    const { result } = renderHook(() =>
      useWalletWithdraw({
        transactionUrl: (txHash) => `/api/wallet/transaction/${txHash}`,
      })
    );
    const receipt = await result.current.getReceipt(MOCK_TX_HASH);
    expect(receipt.status).toBe('success');
    expect(receipt.blockNumber).toBe(42);
  });
});
