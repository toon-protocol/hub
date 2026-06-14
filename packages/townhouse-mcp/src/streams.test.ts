import { describe, it, expect } from 'vitest';
import {
  StreamsUnavailableError,
  metricsSnapshotViaWs,
  tailLogsViaSse,
  type WsLike,
} from './streams.js';

// ── SSE helpers ──────────────────────────────────────────────────────────────

/** Build a fetch returning an SSE body that streams `chunks` then ends. */
function sseFetch(chunks: string[], ok = true): typeof fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return { ok, body } as unknown as Response;
  }) as unknown as typeof fetch;
}

function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('tailLogsViaSse', () => {
  it('collects LogEvents, dropping heartbeats and garbage', async () => {
    const a = { ts: 't1', service: 'town', level: 'info', msg: 'a' };
    const b = { ts: 't2', service: 'mill', level: 'warn', msg: 'b' };
    const events = await tailLogsViaSse({
      baseUrl: 'http://x:9400',
      fetchImpl: sseFetch([
        ': heartbeat 1\n\n',
        sseEvent(a),
        'data: notjson\n\n',
        sseEvent(b),
      ]),
    });
    expect(events).toEqual([a, b]);
  });

  it('stops at maxLines', async () => {
    const mk = (i: number) => ({
      ts: `t${i}`,
      service: 'town',
      level: 'info',
      msg: `m${i}`,
    });
    const events = await tailLogsViaSse({
      baseUrl: 'http://x:9400',
      maxLines: 2,
      fetchImpl: sseFetch([sseEvent(mk(1)), sseEvent(mk(2)), sseEvent(mk(3))]),
    });
    expect(events).toHaveLength(2);
  });

  it('filters by service and level', async () => {
    const keep = { ts: 't', service: 'dvm', level: 'error', msg: 'k' };
    const drop1 = { ts: 't', service: 'town', level: 'error', msg: 'd' };
    const drop2 = { ts: 't', service: 'dvm', level: 'info', msg: 'd' };
    const events = await tailLogsViaSse({
      baseUrl: 'http://x:9400',
      service: 'dvm',
      level: 'error',
      fetchImpl: sseFetch([sseEvent(drop1), sseEvent(keep), sseEvent(drop2)]),
    });
    expect(events).toEqual([keep]);
  });

  it('throws StreamsUnavailableError on a non-2xx response', async () => {
    await expect(
      tailLogsViaSse({
        baseUrl: 'http://x:9400',
        fetchImpl: sseFetch([], false),
      })
    ).rejects.toBeInstanceOf(StreamsUnavailableError);
  });

  it('throws StreamsUnavailableError when fetch rejects', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      tailLogsViaSse({ baseUrl: 'http://x:9400', fetchImpl: boom })
    ).rejects.toBeInstanceOf(StreamsUnavailableError);
  });
});

// ── WS helpers ───────────────────────────────────────────────────────────────

/** A scriptable WS double that fires queued events on the next microtask. */
class FakeWs implements WsLike {
  private listeners = new Map<string, ((ev: unknown) => void)[]>();
  closed = false;
  constructor(private readonly script: () => void) {
    queueMicrotask(() => this.script.call(this));
  }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  emit(type: string, ev?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  close(): void {
    this.closed = true;
  }
}

describe('metricsSnapshotViaWs', () => {
  it('resolves the first metrics frame and closes', async () => {
    const payload = {
      packetsForwarded: 5,
      packetsRejected: 1,
      bytesSent: 99,
      attribution: 'aggregate',
      available: true,
    };
    let ws!: FakeWs;
    const got = await metricsSnapshotViaWs({
      baseUrl: 'http://x:9400',
      wsFactory: () => {
        ws = new FakeWs(function (this: FakeWs) {
          this.emit('message', { data: JSON.stringify({ type: 'heartbeat' }) });
          this.emit('message', {
            data: JSON.stringify({ type: 'metrics', payload, ts: 1 }),
          });
        });
        return ws;
      },
    });
    expect(got).toEqual(payload);
    expect(ws.closed).toBe(true);
  });

  it('unwraps a metrics frame nested in a batch', async () => {
    const payload = {
      packetsForwarded: 2,
      packetsRejected: 0,
      bytesSent: 10,
      attribution: 'aggregate',
      available: true,
    };
    const got = await metricsSnapshotViaWs({
      baseUrl: 'http://x:9400',
      wsFactory: () =>
        new FakeWs(function (this: FakeWs) {
          this.emit('message', {
            data: JSON.stringify({
              type: 'batch',
              messages: [{ type: 'nodeState' }, { type: 'metrics', payload }],
              ts: 1,
            }),
          });
        }),
    });
    expect(got).toEqual(payload);
  });

  it('rejects with StreamsUnavailableError on socket error', async () => {
    await expect(
      metricsSnapshotViaWs({
        baseUrl: 'http://x:9400',
        wsFactory: () =>
          new FakeWs(function (this: FakeWs) {
            this.emit('error', new Error('refused'));
          }),
      })
    ).rejects.toBeInstanceOf(StreamsUnavailableError);
  });

  it('rejects when the socket closes before any metrics frame', async () => {
    await expect(
      metricsSnapshotViaWs({
        baseUrl: 'http://x:9400',
        wsFactory: () =>
          new FakeWs(function (this: FakeWs) {
            this.emit('close');
          }),
      })
    ).rejects.toBeInstanceOf(StreamsUnavailableError);
  });

  it('rejects (unavailable) when the WS factory itself throws', async () => {
    await expect(
      metricsSnapshotViaWs({
        baseUrl: 'http://x:9400',
        wsFactory: () => {
          throw new Error('no global WebSocket');
        },
      })
    ).rejects.toBeInstanceOf(StreamsUnavailableError);
  });
});
