import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDepositAddresses } from './useDepositAddresses';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const ADDRESSES_PAYLOAD = {
  chains: [
    { family: 'evm', address: '0x1234' },
    { family: 'solana', address: 'SolanaPubkey' },
    { family: 'mina', address: 'MinaPubkey' },
  ],
};

const url = '/api/nodes/mill/deposit-addresses';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(ADDRESSES_PAYLOAD));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDepositAddresses', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() => useDepositAddresses({ nodeId: 'mill', url }));
    expect(result.current.status).toBe('loading');
    expect(result.current.chains).toHaveLength(0);
  });

  it('transitions to ready with chains', async () => {
    const { result } = renderHook(() => useDepositAddresses({ nodeId: 'mill', url }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.chains).toHaveLength(3);
    expect(result.current.chains[0].family).toBe('evm');
  });

  it('transitions to error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useDepositAddresses({ nodeId: 'mill', url }));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('aborts on unmount', () => {
    const { unmount } = renderHook(() => useDepositAddresses({ nodeId: 'mill', url }));
    unmount();
  });

  it('builds default URL from nodeId when no url override is provided', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(ADDRESSES_PAYLOAD));
    const { result } = renderHook(() => useDepositAddresses({ nodeId: 'dev-mill-01' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/nodes/dev-mill-01/deposit-addresses',
      expect.any(Object)
    );
  });
});
