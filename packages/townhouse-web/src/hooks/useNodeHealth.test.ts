import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useNodeHealth } from './useNodeHealth';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const MILL_HEALTH = {
  status: 'ok',
  version: '1.0.0',
  nodePubkey: 'a'.repeat(64),
  swapPairsCount: 1,
  chains: ['evm'],
  uptimeSec: 60,
  inventory: {},
  swapPairs: [],
  inventoryAvailable: {},
};

const url = '/api/nodes/mill/health';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(MILL_HEALTH));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useNodeHealth', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() => useNodeHealth({ nodeId: 'mill', url }));
    expect(result.current.status).toBe('loading');
    expect(result.current.health).toBeNull();
  });

  it('transitions to ready with health payload', async () => {
    const { result } = renderHook(() => useNodeHealth({ nodeId: 'mill', url }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.health).not.toBeNull();
    expect((result.current.health as typeof MILL_HEALTH).status).toBe('ok');
  });

  it('transitions to error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useNodeHealth({ nodeId: 'mill', url }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.health).toBeNull();
  });

  it('transitions to error on 503 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 503));
    const { result } = renderHook(() => useNodeHealth({ nodeId: 'mill', url }));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('aborts on unmount', async () => {
    const { unmount } = renderHook(() =>
      useNodeHealth({ nodeId: 'mill', url })
    );
    unmount();
    // Should not throw
  });

  it('builds default URL from nodeId when no url override is provided', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonRes(MILL_HEALTH));
    const { result } = renderHook(() =>
      useNodeHealth({ nodeId: 'dev-mill-01' })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/nodes/dev-mill-01/health',
      expect.any(Object)
    );
  });
});
