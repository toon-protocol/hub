import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTransportStatus } from './useTransportStatus';
import type { TransportStatusPayload } from '@toon-protocol/hub';

const DIRECT_STATUS: TransportStatusPayload = {
  mode: 'direct',
  reachable: true,
  latencyProxyMs: null,
  latencyDirectMs: 5,
  lastProbedAt: Date.now(),
  probeError: null,
  ts: Date.now(),
};

const ATOR_STATUS: TransportStatusPayload = {
  mode: 'ator',
  socksProxy: 'socks5h://proxy.ator.io:9050',
  reachable: true,
  latencyProxyMs: 120,
  latencyDirectMs: 5,
  lastProbedAt: Date.now(),
  probeError: null,
  ts: Date.now(),
};

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(DIRECT_STATUS));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTransportStatus', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() =>
      useTransportStatus({ url: '/api/transport', pollIntervalMs: 60_000 })
    );
    expect(result.current.statusKind).toBe('loading');
    expect(result.current.status).toBeNull();
  });

  it('transitions to ready with direct status', async () => {
    const { result } = renderHook(() =>
      useTransportStatus({ url: '/api/transport', pollIntervalMs: 60_000 })
    );
    await waitFor(() => expect(result.current.statusKind).toBe('ready'));
    expect(result.current.status?.mode).toBe('direct');
    expect(result.current.status?.reachable).toBe(true);
  });

  it('transitions to error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() =>
      useTransportStatus({ url: '/api/transport', pollIntervalMs: 60_000 })
    );
    await waitFor(() => expect(result.current.statusKind).toBe('error'));
  });

  it('transitions to error on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ error: 'server_error' }, 500)
    );
    const { result } = renderHook(() =>
      useTransportStatus({ url: '/api/transport', pollIntervalMs: 60_000 })
    );
    await waitFor(() => expect(result.current.statusKind).toBe('error'));
  });

  it('refetch invalidates cached status and re-fetches', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      callCount++;
      const status = callCount === 1 ? DIRECT_STATUS : ATOR_STATUS;
      return Promise.resolve(jsonRes(status));
    });

    const { result } = renderHook(() =>
      useTransportStatus({ url: '/api/transport', pollIntervalMs: 60_000 })
    );
    await waitFor(() => expect(result.current.statusKind).toBe('ready'));
    expect(result.current.status?.mode).toBe('direct');

    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.status?.mode).toBe('ator'));
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('does not throw on unmount during in-flight fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>(() => {
          /* never resolves */
        })
    );
    const { unmount } = renderHook(() =>
      useTransportStatus({ url: '/api/transport', pollIntervalMs: 60_000 })
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(() => unmount()).not.toThrow();
  });
});
