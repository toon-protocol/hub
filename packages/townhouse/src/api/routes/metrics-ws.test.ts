/**
 * WebSocket metrics route tests — WS /metrics (AC #5, #8, #10).
 *
 * Strategy: spin up a real Fastify instance on an ephemeral port and connect
 * a real `ws` client. Deterministic synchronous timing is achieved with
 * `vi.useFakeTimers({ shouldAdvanceTime: true })` only where we need to probe
 * timer-driven behaviour (heartbeat, throttle). Socket I/O stays on real
 * timers to avoid deadlocking on the event loop.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WsClient from 'ws';
import { registerMetricsWsRoutes, getOpenWebSockets } from './metrics-ws.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { getDefaultConfig } from '../../config/defaults.js';

class StubOrchestrator extends EventEmitter {
  async status() {
    return [];
  }
}

class StubWallet {
  listKeys() {
    return [];
  }
}

class StubConnectorAdmin {
  public failNext = false;
  async getMetrics() {
    if (this.failNext) {
      throw new Error('connector down');
    }
    return { packetsForwarded: 42, packetsRejected: 1, bytesSent: 9000 };
  }
}

/** Open a WS client and resolve once the underlying socket is open. */
async function connect(url: string): Promise<WsClient> {
  const ws = new WsClient(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return ws;
}

/** Collect all JSON-parsed messages until `predicate` returns true or timeout. */
async function collectUntil(
  ws: WsClient,
  predicate: (msgs: unknown[]) => boolean,
  timeoutMs: number
): Promise<unknown[]> {
  const received: unknown[] = [];
  return await new Promise<unknown[]>((resolve, reject) => {
    const to = setTimeout(() => {
      reject(
        new Error(
          `timed out after ${timeoutMs}ms; received ${received.length} messages`
        )
      );
    }, timeoutMs);
    ws.on('message', (data) => {
      try {
        received.push(JSON.parse(data.toString()));
      } catch {
        received.push(data.toString());
      }
      if (predicate(received)) {
        clearTimeout(to);
        resolve(received);
      }
    });
  });
}

describe('WebSocket /metrics', () => {
  let app: FastifyInstance;
  let orchestrator: StubOrchestrator;
  let connector: StubConnectorAdmin;
  let url: string;

  beforeEach(async () => {
    app = Fastify();
    await app.register(websocket);
    orchestrator = new StubOrchestrator();
    connector = new StubConnectorAdmin();
    const deps: ApiDeps = {
      configPath: '/tmp/test-config.yaml',
      config: getDefaultConfig(),
      orchestrator: orchestrator as unknown as DockerOrchestrator,
      wallet: new StubWallet() as unknown as WalletManager,
      connectorAdmin: connector as unknown as ConnectorAdminClient,
    };
    registerMetricsWsRoutes(app, deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    url = `ws://127.0.0.1:${addr.port}/metrics`;
  });

  afterEach(async () => {
    // Clear any tracked sockets from prior tests (shared module-level Set).
    getOpenWebSockets().clear();
    await app.close();
    vi.useRealTimers();
  });

  // AC #5: first metrics frame within 1 s of connect.
  it('delivers a metrics frame within 1 s of connect (AC #5)', async () => {
    const ws = await connect(url);
    const t0 = Date.now();
    const msgs = await collectUntil(
      ws,
      (list) =>
        list.some(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            // single-frame OR inside a batch
            ((m as { type: string }).type === 'metrics' ||
              ((m as { type: string; messages?: unknown[] }).type === 'batch' &&
                (m as { messages: { type: string }[] }).messages.some(
                  (inner) => inner.type === 'metrics'
                )))
        ),
      2000
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1500); // 1 s target with 500 ms slack
    expect(msgs.length).toBeGreaterThan(0);
    ws.close();
  });

  // AC #5: metrics frames reflect connector payload (happy path).
  it('metrics frames carry packetsForwarded/packetsRejected/bytesSent', async () => {
    const ws = await connect(url);
    const msgs = await collectUntil(ws, (list) => list.length >= 1, 2000);
    // First message might be a single metrics frame or a batch — unwrap.
    const first = msgs[0] as {
      type: string;
      payload?: unknown;
      messages?: { type: string; payload?: unknown }[];
    };
    const metricsFrame =
      first.type === 'metrics'
        ? first
        : first.messages?.find((m) => m.type === 'metrics');
    expect(metricsFrame).toBeTruthy();
    expect(
      (metricsFrame as { payload: { packetsForwarded: number } }).payload
    ).toMatchObject({
      packetsForwarded: 42,
      packetsRejected: 1,
      bytesSent: 9000,
      available: true,
      attribution: 'aggregate',
    });
    ws.close();
  });

  // AC #5: connector failure degrades gracefully to available:false.
  it('emits degraded metrics frame when connector fails', async () => {
    connector.failNext = true;
    const ws = await connect(url);
    const msgs = await collectUntil(ws, (list) => list.length >= 1, 2000);
    const first = msgs[0] as {
      type: string;
      payload?: { available?: boolean };
      messages?: { type: string; payload?: { available?: boolean } }[];
    };
    const metricsFrame =
      first.type === 'metrics'
        ? first
        : first.messages?.find((m) => m.type === 'metrics');
    expect(
      (metricsFrame as { payload: { available: boolean } }).payload.available
    ).toBe(false);
    ws.close();
  });

  // AC #8: throttling — >10 events/sec batched into ≤10 frames/sec.
  it('coalesces >10 events/sec into ≤10 frames/sec (AC #8)', async () => {
    const ws = await connect(url);

    // Wait for the socket to be fully wired before pushing events.
    await new Promise((r) => setTimeout(r, 50));

    const received: unknown[] = [];
    ws.on('message', (data) => {
      try {
        received.push(JSON.parse(data.toString()));
      } catch {
        /* ignore */
      }
    });

    // Emit 100 containerState events as fast as possible.
    for (let i = 0; i < 100; i++) {
      orchestrator.emit('containerState', { name: `n${i}`, state: 'running' });
    }

    // Collect for 1 s — flush cadence is 100 ms → at most ~10 frames.
    await new Promise((r) => setTimeout(r, 1000));

    // Count only frames that contain nodeState payloads (either directly or
    // inside a batch). Metrics/heartbeat frames are separate buckets.
    const nodeStateFrameCount = received.filter((m) => {
      const obj = m as { type: string; messages?: { type: string }[] };
      if (obj.type === 'nodeState') return true;
      if (obj.type === 'batch') {
        return obj.messages?.some((inner) => inner.type === 'nodeState');
      }
      return false;
    }).length;

    // 100 events in <1 s → at most ~10 flush windows of 100 ms each.
    expect(nodeStateFrameCount).toBeGreaterThan(0);
    expect(nodeStateFrameCount).toBeLessThanOrEqual(12); // 10 + slack
    ws.close();
  });

  // AC #5 / Task 5.2: subscribes to pullProgress and connectorRestarted too.
  it('delivers nodeState frames for pullProgress and connectorRestarted', async () => {
    const ws = await connect(url);
    await new Promise((r) => setTimeout(r, 50));

    const received: unknown[] = [];
    ws.on('message', (data) => {
      try {
        received.push(JSON.parse(data.toString()));
      } catch {
        /* ignore */
      }
    });

    orchestrator.emit('pullProgress', {
      image: 'toon:town',
      status: 'downloading',
    });
    orchestrator.emit('connectorRestarted', {});

    await new Promise((r) => setTimeout(r, 300));

    // Flatten single + batched frames.
    const allPayloads: { name: string; state: string }[] = [];
    for (const m of received) {
      const obj = m as {
        type: string;
        payload?: { name: string; state: string };
        messages?: { type: string; payload: { name: string; state: string } }[];
      };
      if (obj.type === 'nodeState' && obj.payload) {
        allPayloads.push(obj.payload);
      } else if (obj.type === 'batch' && obj.messages) {
        for (const inner of obj.messages) {
          if (inner.type === 'nodeState') allPayloads.push(inner.payload);
        }
      }
    }

    expect(
      allPayloads.some(
        (p) => p.name === 'pull:toon:town' && p.state === 'downloading'
      )
    ).toBe(true);
    expect(
      allPayloads.some((p) => p.name === 'connector' && p.state === 'restarted')
    ).toBe(true);
    ws.close();
  });

  // AC #10: 1001/`server_shutdown` close frame sent to clients on close().
  it('sends 1001/server_shutdown close frame on server close (AC #10)', async () => {
    const ws = await connect(url);

    // Wait for the open-sockets Set to register this client.
    await new Promise((r) => setTimeout(r, 100));
    expect(getOpenWebSockets().size).toBeGreaterThan(0);

    const closePromise = new Promise<{ code: number; reason: string }>(
      (resolve) => {
        ws.once('close', (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      }
    );

    // Simulate server.ts close() behaviour: close each tracked socket with
    // code 1001 and reason 'server_shutdown'.
    for (const socket of getOpenWebSockets()) {
      socket.close(1001, 'server_shutdown');
    }

    const result = await closePromise;
    expect(result.code).toBe(1001);
    expect(result.reason).toBe('server_shutdown');
  });
});
