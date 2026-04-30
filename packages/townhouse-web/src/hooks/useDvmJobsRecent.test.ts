import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useDvmJobsRecent } from './useDvmJobsRecent';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const JOBS_PAYLOAD = {
  count: 5,
  volume: '1500000',
  byKind: [
    { kind: 5094, count: 3, volume: '900000' },
    { kind: 5250, count: 2, volume: '600000' },
  ],
  byStatus: { processing: 1, success: 3, error: 1, partial: 0 },
};

const url = '/api/nodes/dev-dvm-01/jobs/recent?windowSec=300';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(JOBS_PAYLOAD));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDvmJobsRecent', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() => useDvmJobsRecent({ nodeId: 'dev-dvm-01', url }));
    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeNull();
  });

  it('transitions to ready with jobs data', async () => {
    const { result } = renderHook(() => useDvmJobsRecent({ nodeId: 'dev-dvm-01', url }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data?.count).toBe(5);
    expect(result.current.data?.volume).toBe('1500000');
    expect(result.current.data?.byKind).toHaveLength(2);
    expect(result.current.data?.byStatus.processing).toBe(1);
  });

  it('transitions to error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useDvmJobsRecent({ nodeId: 'dev-dvm-01', url }));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('transitions to error on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 503));
    const { result } = renderHook(() => useDvmJobsRecent({ nodeId: 'dev-dvm-01', url }));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('aborts on unmount without throwing', () => {
    const { unmount } = renderHook(() => useDvmJobsRecent({ nodeId: 'dev-dvm-01', url }));
    unmount();
  });

  it('exposes a refetch handle that triggers a fresh fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(JOBS_PAYLOAD));
    const { result } = renderHook(() => useDvmJobsRecent({ nodeId: 'dev-dvm-01', url }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const beforeCalls = fetchMock.mock.calls.length;

    await act(async () => {
      result.current.refetch();
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeCalls);
  });

  it('builds default URL from nodeId when no url override is provided', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(JOBS_PAYLOAD));
    const { result } = renderHook(() =>
      useDvmJobsRecent({ nodeId: 'dev-dvm-02', windowSec: 60 })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/nodes/dev-dvm-02/jobs/recent?windowSec=60',
      expect.any(Object)
    );
  });
});
