import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useNodes } from './useNodes';
import type { NodeInfo, NodeDetail } from '@toon-protocol/hub';

const baseList: NodeInfo[] = [
  {
    type: 'town',
    enabled: true,
    state: 'running',
    uptimeSeconds: 120,
    image: 'toon:town',
  },
  {
    type: 'mill',
    enabled: false,
    state: 'not-created',
    uptimeSeconds: null,
    image: 'toon:mill',
  },
];

const baseDetail: NodeDetail = {
  type: 'town',
  enabled: true,
  state: 'running',
  uptimeSeconds: 120,
  image: 'toon:town',
  config: { enabled: true, feePerEvent: 1 },
  metrics: {
    packetsForwarded: 42,
    packetsRejected: 0,
    bytesSent: 1024,
    attribution: 'aggregate',
    available: true,
  },
};

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useNodes', () => {
  it('fetches list and per-type metrics, transitions loading → ready', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url =
          typeof input === 'string' ? input : (input as URL).toString();
        if (url === '/api/nodes') return mockJsonResponse(baseList);
        if (url === '/api/nodes/town') return mockJsonResponse(baseDetail);
        throw new Error(`unexpected fetch: ${url}`);
      });

    const { result } = renderHook(() => useNodes());
    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.nodes).toEqual(baseList);
    expect(result.current.metricsByType.town?.packetsForwarded).toBe(42);
    // Mill is not enabled — no detail fetch
    expect(result.current.metricsByType.mill).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith('/api/nodes', expect.any(Object));
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/nodes/town',
      expect.any(Object)
    );
  });

  it('transitions to error when /api/nodes returns 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({}, 500));
    const { result } = renderHook(() => useNodes());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.message).toMatch(/500/);
  });

  it('transitions to error on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('network down')
    );
    const { result } = renderHook(() => useNodes());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.message).toMatch(/network down/);
  });

  it('tolerates per-type detail failures and still resolves to ready', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return mockJsonResponse(baseList);
      if (url === '/api/nodes/town') return mockJsonResponse({}, 503);
      throw new Error('unexpected');
    });
    const { result } = renderHook(() => useNodes());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.metricsByType.town).toBeNull();
  });

  it('refetch triggers a new request cycle', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url =
          typeof input === 'string' ? input : (input as URL).toString();
        if (url === '/api/nodes') return mockJsonResponse(baseList);
        if (url === '/api/nodes/town') return mockJsonResponse(baseDetail);
        throw new Error('unexpected');
      });
    const { result } = renderHook(() => useNodes());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const initialCalls = fetchSpy.mock.calls.length;
    act(() => result.current.refetch());
    await waitFor(() =>
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(initialCalls)
    );
  });

  it('refetch keeps prior nodes visible (status stays ready, isRefreshing flips)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return mockJsonResponse(baseList);
      if (url === '/api/nodes/town') return mockJsonResponse(baseDetail);
      throw new Error('unexpected');
    });
    const { result } = renderHook(() => useNodes());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.isRefreshing).toBe(false);

    act(() => result.current.refetch());
    // Status MUST stay 'ready' so the cards don't swap into the loading skeleton.
    expect(result.current.status).toBe('ready');
    expect(result.current.nodes).toEqual(baseList);
    expect(result.current.isRefreshing).toBe(true);

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
  });

  it('does not surface AbortError when the controller is aborted mid-flight', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        // Simulate a stream-read abort that surfaces as a TypeError-named
        // exception (matches Firefox behavior). The hook should observe the
        // aborted parent signal and suppress the error.
        const err = new TypeError(
          'NetworkError when attempting to fetch resource.'
        );
        throw err;
      });
    const { result, unmount } = renderHook(() => useNodes());
    // Unmount immediately to abort the in-flight request.
    unmount();
    await new Promise((r) => setTimeout(r, 10));
    // Status must NOT be 'error' — the abort was caller-initiated.
    expect(result.current.status).not.toBe('error');
    expect(fetchSpy).toHaveBeenCalled();
  });
});
