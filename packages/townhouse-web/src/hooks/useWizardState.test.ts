import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useWizardState } from './useWizardState';
import type { WizardStatePayload } from '@toon-protocol/townhouse';

const MOCK_STATE: WizardStatePayload = {
  config_exists: false,
  wallet_exists: false,
  containers_running: false,
  mode: 'wizard',
  ts: Date.now(),
};

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useWizardState', () => {
  it('polls the wizard state endpoint and returns data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(MOCK_STATE));

    const { result } = renderHook(() =>
      useWizardState({ url: '/test/wizard/state', pollIntervalMs: 10000 })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.state).toEqual(MOCK_STATE);
  });

  it('transitions to error status on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() =>
      useWizardState({ url: '/test/wizard/state', pollIntervalMs: 10000 })
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('cancels in-flight fetch on unmount (abort signal)', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Promise(() => {}); // never resolves
    });

    const { unmount } = renderHook(() =>
      useWizardState({ url: '/test/wizard/state', pollIntervalMs: 10000 })
    );

    // Let the hook mount and fire the fetch
    await new Promise((r) => setTimeout(r, 10));

    unmount();

    // Abort should have been called
    expect(capturedSignal?.aborted).toBe(true);
  });
});
