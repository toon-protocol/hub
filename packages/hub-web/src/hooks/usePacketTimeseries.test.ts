/**
 * usePacketTimeseries hook tests (AC: #10 — story 21.10, Task 10.2).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePacketTimeseries } from './usePacketTimeseries';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const TEST_URL =
  '/api/nodes/town/packets/timeseries?bucket=hour&since=2026-01-01T00%3A00%3A00.000Z';

describe('usePacketTimeseries', () => {
  it('starts in loading state', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ buckets: [] }));
    const { result } = renderHook(() =>
      usePacketTimeseries({ nodeType: 'town', url: TEST_URL })
    );
    expect(result.current.status).toBe('loading');
    expect(result.current.buckets).toEqual([]);
  });

  it('transitions to ready with buckets', async () => {
    const buckets = [
      { ts: 1000, count: 5 },
      { ts: 2000, count: 3 },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ buckets }));

    const { result } = renderHook(() =>
      usePacketTimeseries({ nodeType: 'town', url: TEST_URL })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.buckets).toEqual(buckets);
  });

  it('returns unavailable status when connector returns 503', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ error: 'connector_endpoint_not_found' }, 503)
    );

    const { result } = renderHook(() =>
      usePacketTimeseries({ nodeType: 'town', url: TEST_URL })
    );

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.buckets).toEqual([]);
  });

  it('returns error status on non-503 failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 500));

    const { result } = renderHook(() =>
      usePacketTimeseries({ nodeType: 'town', url: TEST_URL })
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('returns error status on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('net error'));

    const { result } = renderHook(() =>
      usePacketTimeseries({ nodeType: 'town', url: TEST_URL })
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});
