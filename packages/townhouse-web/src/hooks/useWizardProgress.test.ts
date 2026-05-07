import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useWizardProgress } from './useWizardProgress';
import type { WizardProgressMessage } from '@toon-protocol/townhouse';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  public listeners: Record<string, ((e?: unknown) => void)[]> = {};
  public closed = false;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, handler: (e?: unknown) => void) {
    this.listeners[event] = [...(this.listeners[event] ?? []), handler];
  }

  removeEventListener(event: string, handler: (e?: unknown) => void) {
    this.listeners[event] = (this.listeners[event] ?? []).filter(
      (h) => h !== handler
    );
  }

  close() {
    this.closed = true;
    (this.listeners['close'] ?? []).forEach((h) => h());
  }

  emit(event: string, data?: unknown) {
    (this.listeners[event] ?? []).forEach((h) => h(data));
  }
}

describe('useWizardProgress', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens with connecting status, then open when socket connects', async () => {
    const { result } = renderHook(() =>
      useWizardProgress({ url: 'ws://test/wizard/progress', maxReconnects: 0 })
    );
    expect(result.current.status).toBe('connecting');

    await act(async () => {
      const socket = MockWebSocket.instances[0];
      socket?.emit('open');
    });

    expect(result.current.status).toBe('open');
  });

  it('accumulates incoming messages', async () => {
    const { result } = renderHook(() =>
      useWizardProgress({ url: 'ws://test/wizard/progress', maxReconnects: 0 })
    );

    const msg: WizardProgressMessage = {
      type: 'pull_progress',
      image: 'toon:town',
      status: 'Pulling',
      ts: Date.now(),
    };

    await act(async () => {
      MockWebSocket.instances[0]?.emit('open');
      MockWebSocket.instances[0]?.emit('message', {
        data: JSON.stringify(msg),
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      type: 'pull_progress',
      image: 'toon:town',
    });
  });

  it('closes socket on unmount', async () => {
    const { unmount } = renderHook(() =>
      useWizardProgress({ url: 'ws://test/wizard/progress', maxReconnects: 0 })
    );

    const socket = MockWebSocket.instances[0];
    expect(socket?.closed).toBe(false);

    unmount();

    expect(socket?.closed).toBe(true);
  });

  it('with maxReconnects: 0 transitions to closed status on socket close', async () => {
    const { result } = renderHook(() =>
      useWizardProgress({ url: 'ws://test/wizard/progress', maxReconnects: 0 })
    );

    await act(async () => {
      MockWebSocket.instances[0]?.emit('open');
    });
    expect(result.current.status).toBe('open');

    await act(async () => {
      MockWebSocket.instances[0]?.close();
    });
    expect(result.current.status).toBe('closed');
  });

  it('with maxReconnects > 0 reconnects on transient close (status flips back to connecting)', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useWizardProgress({
          url: 'ws://test/wizard/progress',
          maxReconnects: 3,
        })
      );

      await act(async () => {
        MockWebSocket.instances[0]?.emit('open');
      });
      expect(result.current.status).toBe('open');
      expect(MockWebSocket.instances).toHaveLength(1);

      await act(async () => {
        MockWebSocket.instances[0]?.close();
      });
      expect(result.current.status).toBe('connecting');

      // Advance the backoff timer so the reconnect fires
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(MockWebSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
