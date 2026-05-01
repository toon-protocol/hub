/**
 * useNodeMetrics hook tests (AC: #8, #9 — story 21.10, Task 10.2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useNodeMetrics } from './useNodeMetrics';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const detailUrl = '/api/nodes/town';
const bandwidthUrl = '/api/nodes/town/bandwidth';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url === detailUrl) {
      return jsonRes({
        id: 'town',
        type: 'town',
        enabled: true,
        state: 'running',
        uptimeSeconds: 0,
        image: 'toon:town',
        config: { enabled: true },
        metrics: {
          packetsForwarded: 42,
          packetsRejected: 0,
          bytesSent: 0,
          attribution: 'aggregate',
          available: true,
        },
      });
    }
    if (url === bandwidthUrl) {
      return jsonRes({ bytesIn: 1024, bytesOut: 2048, sampleAt: 1000 });
    }
    throw new Error('unexpected ' + url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useNodeMetrics', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() =>
      useNodeMetrics({ nodeType: 'town', detailUrl, bandwidthUrl })
    );
    expect(result.current.status).toBe('loading');
  });

  it('transitions to ready and returns both metrics', async () => {
    const { result } = renderHook(() =>
      useNodeMetrics({ nodeType: 'town', detailUrl, bandwidthUrl })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.metrics.connectedClients).toBe(42);
    expect(result.current.metrics.bandwidth).toEqual({
      bytesIn: 1024,
      bytesOut: 2048,
      sampleAt: 1000,
    });
  });

  it('returns null bandwidth when endpoint returns null', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === detailUrl)
        return jsonRes({
          id: 'town',
          type: 'town',
          enabled: true,
          state: 'running',
          uptimeSeconds: 0,
          image: '',
          config: {},
          metrics: null,
        });
      if (url === bandwidthUrl) return jsonRes(null);
      throw new Error('unexpected ' + url);
    });

    const { result } = renderHook(() =>
      useNodeMetrics({ nodeType: 'town', detailUrl, bandwidthUrl })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.metrics.bandwidth).toBeNull();
  });

  it('transitions to error state on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() =>
      useNodeMetrics({ nodeType: 'town', detailUrl, bandwidthUrl })
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});
