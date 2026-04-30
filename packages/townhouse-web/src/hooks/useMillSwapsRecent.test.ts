import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMillSwapsRecent } from './useMillSwapsRecent';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const SWAPS_PAYLOAD = {
  count: 3,
  volume: '3000000',
  byPair: [{ pair: 'a→b', count: 3, volume: '3000000' }],
};

const url = '/api/nodes/mill/swaps/recent?windowSec=300';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(SWAPS_PAYLOAD));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMillSwapsRecent', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() => useMillSwapsRecent({ nodeId: 'mill', url }));
    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeNull();
  });

  it('transitions to ready with swap data', async () => {
    const { result } = renderHook(() => useMillSwapsRecent({ nodeId: 'mill', url }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data?.count).toBe(3);
    expect(result.current.data?.volume).toBe('3000000');
  });

  it('transitions to error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useMillSwapsRecent({ nodeId: 'mill', url }));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('aborts on unmount', () => {
    const { unmount } = renderHook(() => useMillSwapsRecent({ nodeId: 'mill', url }));
    unmount();
  });

  it('exposes a refetch handle that triggers a fresh fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(SWAPS_PAYLOAD));
    const { result } = renderHook(() => useMillSwapsRecent({ nodeId: 'mill', url }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const beforeCalls = fetchMock.mock.calls.length;

    await act(async () => {
      result.current.refetch();
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeCalls);
  });

  it('builds default URL from nodeId when no url override is provided', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(SWAPS_PAYLOAD));
    const { result } = renderHook(() =>
      useMillSwapsRecent({ nodeId: 'dev-mill-02', windowSec: 60 })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/nodes/dev-mill-02/swaps/recent?windowSec=60',
      expect.any(Object)
    );
  });
});
