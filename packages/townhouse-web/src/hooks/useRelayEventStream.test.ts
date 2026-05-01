/**
 * useRelayEventStream hook tests (AC: #7 — story 21.10, Task 10.2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRelayEventStream } from './useRelayEventStream';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  url: string;
  readyState = 0;
  listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: { data?: unknown }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener() {}

  close() {
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => this.fire('close'));
  }

  fire(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }

  acceptOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.fire('open');
  }

  pushMessage(payload: unknown) {
    this.fire('message', JSON.stringify(payload));
  }
}

function makeEvent(content = 'hello', kind = 1) {
  return {
    id: Math.random().toString(16),
    kind,
    pubkey: 'aabbccdd',
    content,
    tags: [],
    sig: 'sig',
    created_at: Math.floor(Date.now() / 1000),
  };
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useRelayEventStream', () => {
  it('starts in connecting state', () => {
    const { result } = renderHook(() =>
      useRelayEventStream({
        nodeId: 'town-01',
        url: 'ws://localhost:9400/metrics?subscribe=relayEvents:town-01',
      })
    );
    expect(result.current.status).toBe('connecting');
    expect(result.current.events).toEqual([]);
  });

  it('transitions to open when socket opens', async () => {
    const { result } = renderHook(() =>
      useRelayEventStream({
        nodeId: 'town-01',
        url: 'ws://localhost:9400/metrics',
      })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
    });

    expect(result.current.status).toBe('open');
  });

  it('adds events to the buffer when relayEvents message arrives', async () => {
    const { result } = renderHook(() =>
      useRelayEventStream({
        nodeId: 'town-01',
        url: 'ws://localhost:9400/metrics',
      })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
      const event = makeEvent('test event');
      MockWebSocket.instances[0]!.pushMessage({
        type: 'relayEvents',
        nodeId: 'town-01',
        payload: event,
        ts: Date.now(),
      });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]!.content).toBe('test event');
  });

  it('only accepts events matching the subscribed nodeId', async () => {
    const { result } = renderHook(() =>
      useRelayEventStream({
        nodeId: 'town-01',
        url: 'ws://localhost:9400/metrics',
      })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
      // Different nodeId — should be ignored
      MockWebSocket.instances[0]!.pushMessage({
        type: 'relayEvents',
        nodeId: 'town-02',
        payload: makeEvent('other'),
        ts: Date.now(),
      });
    });

    expect(result.current.events).toHaveLength(0);
  });

  it('respects buffer size — oldest events are dropped when full', async () => {
    const BUFFER = 3;
    const { result } = renderHook(() =>
      useRelayEventStream({
        nodeId: 'town-01',
        url: 'ws://localhost:9400/metrics',
        bufferSize: BUFFER,
      })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
      for (let i = 0; i < 5; i++) {
        MockWebSocket.instances[0]!.pushMessage({
          type: 'relayEvents',
          nodeId: 'town-01',
          payload: makeEvent(`event-${i}`),
          ts: Date.now(),
        });
      }
    });

    expect(result.current.events).toHaveLength(BUFFER);
    // Oldest events should have been dropped
    expect(result.current.events[0]!.content).toBe('event-2');
  });

  it('marks connection degraded and reconnects on close', async () => {
    const { result } = renderHook(() =>
      useRelayEventStream({
        nodeId: 'town-01',
        url: 'ws://localhost:9400/metrics',
        initialBackoffMs: 50,
        maxBackoffMs: 100,
      })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
    });

    expect(result.current.status).toBe('open');

    await act(async () => {
      MockWebSocket.instances[0]!.close();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.status).toBe('degraded');

    // After backoff, a new WS should be created
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
  });

  it('processes batch messages containing relayEvents', async () => {
    const { result } = renderHook(() =>
      useRelayEventStream({
        nodeId: 'town-01',
        url: 'ws://localhost:9400/metrics',
      })
    );

    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
      MockWebSocket.instances[0]!.pushMessage({
        type: 'batch',
        messages: [
          {
            type: 'relayEvents',
            nodeId: 'town-01',
            payload: makeEvent('batched'),
            ts: Date.now(),
          },
        ],
        ts: Date.now(),
      });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]!.content).toBe('batched');
  });
});
