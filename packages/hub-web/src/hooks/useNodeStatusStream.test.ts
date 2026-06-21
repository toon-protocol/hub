import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNodeStatusStream } from './useNodeStatusStream';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: { data?: unknown }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener() {
    /* noop for tests */
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => {
      this.fire('close');
    });
  }

  fire(type: string, data?: unknown) {
    const list = this.listeners.get(type);
    if (!list) return;
    for (const fn of list) fn({ data });
  }

  acceptOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.fire('open');
  }

  pushMessage(payload: unknown) {
    this.fire('message', JSON.stringify(payload));
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useNodeStatusStream', () => {
  it('connects and updates statesByName on nodeState messages', async () => {
    const { result } = renderHook(() =>
      useNodeStatusStream({ url: 'ws://test/api/metrics' })
    );

    expect(result.current.connectionStatus).toBe('connecting');
    expect(MockWebSocket.instances.length).toBe(1);

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
    });
    expect(result.current.connectionStatus).toBe('open');

    await act(async () => {
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'town', state: 'running' },
        ts: Date.now(),
      });
    });
    expect(result.current.statesByName.town).toBe('running');

    await act(async () => {
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'town', state: 'paused' },
        ts: Date.now(),
      });
    });
    expect(result.current.statesByName.town).toBe('paused');
  });

  it('unpacks batch messages', async () => {
    const { result } = renderHook(() =>
      useNodeStatusStream({ url: 'ws://test/api/metrics' })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
      MockWebSocket.instances[0]!.pushMessage({
        type: 'batch',
        ts: Date.now(),
        messages: [
          {
            type: 'nodeState',
            payload: { name: 'town', state: 'running' },
            ts: Date.now(),
          },
          {
            type: 'nodeState',
            payload: { name: 'mill', state: 'paused' },
            ts: Date.now(),
          },
          { type: 'heartbeat', ts: Date.now() },
        ],
      });
    });

    expect(result.current.statesByName.town).toBe('running');
    expect(result.current.statesByName.mill).toBe('paused');
  });

  it('marks connection degraded after heartbeat timeout and forces reconnect', async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() =>
      useNodeStatusStream({
        url: 'ws://test/api/metrics',
        heartbeatTimeoutMs: 30_000,
        initialBackoffMs: 100,
        maxBackoffMs: 100,
      })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
    });
    expect(result.current.connectionStatus).toBe('open');

    // 30s with no message → degraded, current socket closed, new one scheduled.
    // Advance time + flush the close()'s queued microtask so `'close'` runs
    // and reschedules — but stop short of firing the 100ms reconnect timer.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      // Two microtask flushes: one for MockWebSocket.close()'s queueMicrotask,
      // one for the resulting React state update.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.connectionStatus).toBe('degraded');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('reconnects with exponential backoff on close, capping at maxBackoffMs', async () => {
    vi.useFakeTimers();

    renderHook(() =>
      useNodeStatusStream({
        url: 'ws://test/api/metrics',
        initialBackoffMs: 100,
        maxBackoffMs: 400,
      })
    );

    // 1st socket fails
    await act(async () => {
      MockWebSocket.instances[0]!.fire('close');
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(MockWebSocket.instances.length).toBe(2);

    // 2nd socket fails — backoff doubles to 200
    await act(async () => {
      MockWebSocket.instances[1]!.fire('close');
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(MockWebSocket.instances.length).toBe(3);

    // 3rd socket fails — backoff is now 400 (capped)
    await act(async () => {
      MockWebSocket.instances[2]!.fire('close');
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect(MockWebSocket.instances.length).toBe(4);
  });

  it('resets backoff after a successful open', async () => {
    vi.useFakeTimers();

    renderHook(() =>
      useNodeStatusStream({
        url: 'ws://test/api/metrics',
        initialBackoffMs: 100,
        maxBackoffMs: 1_000,
      })
    );

    // Fail first connect, doubling backoff to 200
    await act(async () => {
      MockWebSocket.instances[0]!.fire('close');
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    // 2nd attempt opens successfully — backoff should reset
    await act(async () => {
      MockWebSocket.instances[1]!.acceptOpen();
    });
    // Now drop again; reconnect should fire after the *initial* backoff (100), not 200
    await act(async () => {
      MockWebSocket.instances[1]!.fire('close');
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(MockWebSocket.instances.length).toBe(3);
  });

  it('normalizes hub-{type} container names and ignores other namespaces', async () => {
    const { result } = renderHook(() =>
      useNodeStatusStream({ url: 'ws://test/api/metrics' })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
      // Production DockerOrchestrator names: hub-{type}
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'hub-town', state: 'running' },
        ts: Date.now(),
      });
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'hub-mill', state: 'paused' },
        ts: Date.now(),
      });
      // Non-node namespaces — must be filtered out.
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'hub-connector', state: 'running' },
        ts: Date.now(),
      });
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'pull:toon-protocol/town:latest', state: 'pulling' },
        ts: Date.now(),
      });
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'connector', state: 'restarted' },
        ts: Date.now(),
      });
    });

    expect(result.current.statesByName).toEqual({
      town: 'running',
      mill: 'paused',
    });
  });

  it('schedules a reconnect when the WebSocket constructor throws', async () => {
    vi.useFakeTimers();

    let attempts = 0;
    class ThrowingWs extends MockWebSocket {
      constructor(url: string) {
        attempts += 1;
        if (attempts === 1) {
          // Synchronous throw on first call.
          throw new Error('CSP: WebSocket blocked');
        }
        super(url);
      }
    }
    vi.stubGlobal('WebSocket', ThrowingWs);

    renderHook(() =>
      useNodeStatusStream({
        url: 'ws://test/api/metrics',
        initialBackoffMs: 50,
        maxBackoffMs: 50,
      })
    );

    expect(attempts).toBe(1);
    expect(MockWebSocket.instances.length).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });

    expect(attempts).toBe(2);
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('warns and keeps the connection alive on malformed message payloads', async () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const { result } = renderHook(() =>
      useNodeStatusStream({ url: 'ws://test/api/metrics' })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
      // Plain string (not JSON). Hook should warn but stay open.
      MockWebSocket.instances[0]!.fire('message', 'not-json {{{');
    });

    expect(result.current.connectionStatus).toBe('open');
    expect(warnSpy).toHaveBeenCalled();

    // Subsequent valid message still applies — the connection wasn't poisoned.
    await act(async () => {
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'hub-town', state: 'running' },
        ts: Date.now(),
      });
    });
    expect(result.current.statesByName.town).toBe('running');
  });

  it('exposes reconnect() that immediately re-opens after manual call', async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() =>
      useNodeStatusStream({
        url: 'ws://test/api/metrics',
        initialBackoffMs: 1_000,
        maxBackoffMs: 1_000,
      })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
    });

    // Drop the socket — hook would normally wait 1 s before reconnecting.
    await act(async () => {
      MockWebSocket.instances[0]!.fire('close');
    });
    expect(MockWebSocket.instances.length).toBe(1);

    // Manual reconnect should bypass the backoff timer.
    await act(async () => {
      result.current.reconnect();
      await vi.runAllTimersAsync();
    });
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('cleans up on unmount and stops scheduling reconnects', async () => {
    const { unmount } = renderHook(() =>
      useNodeStatusStream({
        url: 'ws://test/api/metrics',
        initialBackoffMs: 100,
        maxBackoffMs: 100,
      })
    );

    expect(MockWebSocket.instances.length).toBe(1);
    unmount();

    // Flush microtasks so MockWebSocket.close()'s queued 'close' fires inside React's tree.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(MockWebSocket.instances[0]!.closed).toBe(true);

    // Wait longer than the backoff window — no new sockets should appear.
    await new Promise((r) => setTimeout(r, 200));
    expect(MockWebSocket.instances.length).toBe(1);
  });
});
