import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTransportPatch } from './useTransportPatch';
import type { TransportPatchResponse } from '@toon-protocol/hub';

const SUCCESS_RESPONSE: TransportPatchResponse = {
  mode: 'ator',
  socksProxy: 'socks5h://proxy.ator.io:9050',
  restartTriggered: true,
  restartedAt: Date.now(),
};

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(SUCCESS_RESPONSE));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTransportPatch', () => {
  it('starts with pending=false and no error', () => {
    const { result } = renderHook(() =>
      useTransportPatch({ url: '/api/transport' })
    );
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets pending=true while request is in flight', async () => {
    let resolveRequest!: (v: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        })
    );

    const { result } = renderHook(() =>
      useTransportPatch({ url: '/api/transport' })
    );

    // Start the patch without awaiting it
    let patchPromise: Promise<unknown>;
    act(() => {
      patchPromise = result.current.patch({ mode: 'ator' });
    });
    // Give React a tick to re-render
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.pending).toBe(true);

    // Resolve the request
    act(() => resolveRequest(jsonRes(SUCCESS_RESPONSE)));
    await act(() => patchPromise);
    expect(result.current.pending).toBe(false);
  });

  it('returns the response on success', async () => {
    const { result } = renderHook(() =>
      useTransportPatch({ url: '/api/transport' })
    );
    let response!: TransportPatchResponse;
    await act(async () => {
      response = await result.current.patch({ mode: 'ator' });
    });
    expect(response.mode).toBe('ator');
    expect(response.restartTriggered).toBe(true);
  });

  it('calls onSuccess callback after successful patch', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useTransportPatch({ url: '/api/transport' })
    );
    await act(async () => {
      await result.current.patch({ mode: 'ator' }, onSuccess);
    });
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('sets error and throws on server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes(
        { error: 'connector_restart_failed', message: 'docker error' },
        500
      )
    );
    const { result } = renderHook(() =>
      useTransportPatch({ url: '/api/transport' })
    );
    await act(async () => {
      await expect(result.current.patch({ mode: 'ator' })).rejects.toThrow(
        'docker error'
      );
    });
    expect(result.current.error).toBe('docker error');
    expect(result.current.pending).toBe(false);
  });

  it('onSuccess is NOT called on error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ error: 'connector_restart_failed' }, 500)
    );
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useTransportPatch({ url: '/api/transport' })
    );
    await act(async () => {
      await expect(
        result.current.patch({ mode: 'ator' }, onSuccess)
      ).rejects.toThrow();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('pending flag goes false after error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() =>
      useTransportPatch({ url: '/api/transport' })
    );
    await act(async () => {
      await result.current.patch({ mode: 'ator' }).catch(() => {});
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});
