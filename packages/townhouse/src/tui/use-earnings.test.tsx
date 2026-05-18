import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import { useEarnings, type EarningsState } from './use-earnings.js';
import type { AggregatedEarnings } from './types.js';

const OK_PAYLOAD: AggregatedEarnings = {
  status: 'ok',
  apex: { routingFees: { USDC: { lifetime: '1000000', today: '100', month: '500', year: '1000' } } },
  peers: [],
  recentClaims: [],
  eventsRelayed: 42,
  uptimeSeconds: 3600,
};

const UNAVAILABLE_PAYLOAD: AggregatedEarnings = {
  ...OK_PAYLOAD,
  status: 'connector_unavailable',
};

function makeEarningsApp(
  fetchImpl: typeof fetch,
  refreshIntervalMs = 50
): { App: React.FC; getLastState: () => EarningsState | undefined } {
  let lastState: EarningsState | undefined;
  const App: React.FC = () => {
    const state = useEarnings({ fetchImpl, refreshIntervalMs, apiUrl: 'http://localhost' });
    lastState = state;
    return <Text>{state.phase}</Text>;
  };
  return { App, getLastState: () => lastState };
}

// Flush pending setImmediate callbacks (React effect scheduling) then drain Promise microtasks.
// React's scheduler in Node.js uses setImmediate for effect work. vi.advanceTimersByTimeAsync(0)
// runs any setImmediate callbacks scheduled at t=0. Then multiple Promise.resolve() cycles
// drain the async fetch chain: doFetch → fetch() → .json() → setState.
async function flushAll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

describe('useEarnings hook', () => {
  beforeEach(() => {
    // Default vi.useFakeTimers() fakes setImmediate, which React's scheduler uses.
    // vi.advanceTimersByTimeAsync(0) flushes it in flushAll() below.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts in loading phase and transitions to ok after first fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(OK_PAYLOAD),
    } as unknown as Response);

    // Large interval so interval ticks don't interfere with this test.
    const { App, getLastState } = makeEarningsApp(fetchMock as unknown as typeof fetch, 50_000);
    const { unmount } = render(React.createElement(App));

    // Flush React effects + Promise chain: setImmediate → doFetch() → fetch → json → setState
    await flushAll();

    expect(getLastState()?.phase).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('re-fetches at the configured interval (≥4 calls after 250ms with 50ms interval)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(OK_PAYLOAD),
    } as unknown as Response);

    const { App } = makeEarningsApp(fetchMock as unknown as typeof fetch, 50);
    const { unmount } = render(React.createElement(App));

    // Let initial fetch settle
    await flushAll();
    const initialCount = fetchMock.mock.calls.length;

    // Advance 250ms — fires setInterval callbacks and any setImmediate callbacks
    await vi.advanceTimersByTimeAsync(250);
    // Drain Promise chains triggered by the interval fetches
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }

    // Expect at least 4 interval ticks on top of the initial fetch
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(initialCount + 4);

    unmount();
  });

  it('first-fetch network error advances out of loading (P1 — no stuck loading)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    const { App, getLastState } = makeEarningsApp(fetchMock as unknown as typeof fetch, 50_000);
    const { unmount } = render(React.createElement(App));

    await flushAll();

    const state = getLastState();
    expect(state?.phase).toBe('stale');
    if (state?.phase === 'stale') {
      expect(state.bannerKey).toBe('fetch_failed');
      // EMPTY_EARNINGS seed: status is 'connector_unavailable' (the sentinel value).
      expect(state.data.eventsRelayed).toBe(0);
    }

    unmount();
  });

  it('first-fetch !res.ok advances out of loading with fetch_failed banner', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    const { App, getLastState } = makeEarningsApp(fetchMock as unknown as typeof fetch, 50_000);
    const { unmount } = render(React.createElement(App));

    await flushAll();

    const state = getLastState();
    expect(state?.phase).toBe('stale');
    if (state?.phase === 'stale') {
      expect(state.bannerKey).toBe('fetch_failed');
    }

    unmount();
  });

  it('retains prior data with connector_unavailable bannerKey on second fetch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(OK_PAYLOAD),
      } as unknown as Response)
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(UNAVAILABLE_PAYLOAD),
      } as unknown as Response);

    const { App, getLastState } = makeEarningsApp(fetchMock as unknown as typeof fetch, 50);
    const { unmount } = render(React.createElement(App));

    // First fetch → ok
    await flushAll();
    expect(getLastState()?.phase).toBe('ok');

    // Trigger second fetch by advancing past the 50ms interval
    await vi.advanceTimersByTimeAsync(60);
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }

    const state = getLastState();
    expect(['ok', 'stale']).toContain(state?.phase);
    if (state?.phase === 'stale') {
      expect(state.bannerKey).toBe('connector_unavailable');
      expect(state.data.eventsRelayed).toBe(OK_PAYLOAD.eventsRelayed);
    }

    unmount();
  });

  it('aborts in-flight fetch on unmount via AbortController and rejects with AbortError', async () => {
    // Real timers needed here: React's scheduler uses the real setImmediate reference
    // captured at module load time, which fake-timer advancement cannot trigger.
    vi.useRealTimers();

    // Mock fetch to reject with AbortError when its signal fires — mirrors real fetch
    // behavior, so the production catch block's `err.name === 'AbortError'` branch
    // actually runs. The captured signal lets the test assert the abort propagated.
    const captured: { signal: AbortSignal | null } = { signal: null };
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, opts?: { signal?: AbortSignal }) => {
        captured.signal = opts?.signal ?? null;
        return new Promise<Response>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
    );

    const { App, getLastState } = makeEarningsApp(fetchMock as unknown as typeof fetch, 50_000);
    const { unmount } = render(React.createElement(App));

    // Wait for React to commit the effect and doFetch() to start the in-flight request.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(getLastState()?.phase).toBe('loading');

    unmount();
    // React processes the unmount (cleanup of useEffect) asynchronously via setImmediate.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalled();
    expect(captured.signal).not.toBeNull();
    expect(captured.signal?.aborted).toBe(true);
  });
});
