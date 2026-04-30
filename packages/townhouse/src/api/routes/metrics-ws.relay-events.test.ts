/**
 * relayEvents WS subscription tests (AC: #1, #2 — story 21.10, Task 1.5).
 *
 * Tests:
 *   - subscribe success: server opens upstream WS and forwards Nostr events to client
 *   - scoped delivery (no cross-node leak): subscribing to town-01 does not receive events for town-02
 *   - client-close cleans up upstream sockets
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WsClient, { WebSocketServer } from 'ws';
import * as net from 'node:net';
import { registerMetricsWsRoutes, getOpenWebSockets } from './metrics-ws.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { WalletManager } from '../../wallet/manager.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { getDefaultConfig } from '../../config/defaults.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find a free TCP port on loopback */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      server.close((err) => {
        if (err) reject(err);
        else resolve(addr.port);
      });
    });
  });
}

/** Open a WS client and resolve once connected. */
async function connect(url: string): Promise<WsClient> {
  const ws = new WsClient(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return ws;
}

/** Collect messages until predicate returns true or timeout. */
async function collectUntil(
  ws: WsClient,
  predicate: (msgs: unknown[]) => boolean,
  timeoutMs: number
): Promise<unknown[]> {
  const received: unknown[] = [];
  return new Promise<unknown[]>((resolve, reject) => {
    const to = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms — ${received.length} msgs`)),
      timeoutMs
    );
    ws.on('message', (data) => {
      try { received.push(JSON.parse(data.toString())); } catch { /* ignore */ }
      if (predicate(received)) {
        clearTimeout(to);
        resolve(received);
      }
    });
  });
}

/** Flatten WsMessage / WsBatchMessage into a plain array */
function flatten(msgs: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const m of msgs) {
    const obj = m as { type: string; messages?: unknown[] };
    if (obj.type === 'batch' && obj.messages) {
      out.push(...obj.messages);
    } else {
      out.push(m);
    }
  }
  return out;
}

// ── Stub orchestrator that records getNodeRelayEndpoint calls ─────────────────

class StubOrchestrator extends EventEmitter {
  private endpointMap = new Map<string, string>();

  registerEndpoint(nodeId: string, url: string) {
    this.endpointMap.set(nodeId, url);
  }

  async getNodeRelayEndpoint(nodeId: string): Promise<string> {
    const url = this.endpointMap.get(nodeId);
    if (!url) throw new Error(`No endpoint registered for nodeId: ${nodeId}`);
    return url;
  }

  async getContainerStats() { return null; }

  async status() { return []; }
}

class StubConnectorAdmin {
  async getMetrics() {
    return {
      uptimeSeconds: 0,
      aggregate: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0 },
      peers: [],
      timestamp: new Date().toISOString(),
    };
  }
}

class StubWallet { listKeys() { return []; } }

// ── Test setup ────────────────────────────────────────────────────────────────

describe('relayEvents WS subscription (AC #1, #2)', () => {
  let app: FastifyInstance;
  let orchestrator: StubOrchestrator;
  let metricsUrl: string;
  const relayServers: WebSocketServer[] = [];
  const relayPorts = new Map<string, number>();

  /** Start a minimal WS relay server that echoes nothing but can push events */
  async function startRelayServer(nodeId: string): Promise<{
    port: number;
    push: (event: object) => void;
    close: () => void;
  }> {
    const port = await getFreePort();
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    relayServers.push(wss);
    relayPorts.set(nodeId, port);
    orchestrator.registerEndpoint(nodeId, `ws://127.0.0.1:${port}`);

    const clients = new Set<WsClient>();
    wss.on('connection', (ws: WsClient) => clients.add(ws));

    return {
      port,
      push: (event: object) => {
        for (const c of clients) {
          if (c.readyState === WsClient.OPEN) {
            c.send(JSON.stringify(event));
          }
        }
      },
      close: () => wss.close(),
    };
  }

  beforeEach(async () => {
    app = Fastify();
    await app.register(websocket);
    orchestrator = new StubOrchestrator();

    const deps: ApiDeps = {
      configPath: '/tmp/test.yaml',
      config: getDefaultConfig(),
      orchestrator: orchestrator as unknown as DockerOrchestrator,
      wallet: new StubWallet() as unknown as WalletManager,
      connectorAdmin: new StubConnectorAdmin() as unknown as ConnectorAdminClient,
    };
    registerMetricsWsRoutes(app, deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    metricsUrl = `ws://127.0.0.1:${addr.port}/metrics`;
  });

  afterEach(async () => {
    getOpenWebSockets().clear();
    await app.close();
    for (const s of relayServers) s.close();
    relayServers.length = 0;
    relayPorts.clear();
    vi.useRealTimers();
  });

  it('subscribe success — server opens upstream WS and forwards Nostr events to client (AC #1)', async () => {
    const relay = await startRelayServer('town-01');

    const ws = await connect(`${metricsUrl}?subscribe=relayEvents:town-01`);

    // Give the server time to open the upstream connection
    await new Promise((r) => setTimeout(r, 100));

    const sampleEvent = {
      id: 'aabbcc',
      kind: 1,
      pubkey: '112233',
      content: 'hello',
      tags: [],
      sig: 'sig',
      created_at: 1000,
    };
    relay.push(sampleEvent);

    const msgs = await collectUntil(
      ws,
      (list) =>
        flatten(list).some(
          (m) =>
            (m as { type?: string }).type === 'relayEvents' &&
            (m as { nodeId?: string }).nodeId === 'town-01'
        ),
      3000
    );

    const relayMsg = flatten(msgs).find(
      (m) => (m as { type?: string }).type === 'relayEvents'
    ) as { type: string; nodeId: string; payload: object; ts: number } | undefined;

    expect(relayMsg).toBeTruthy();
    expect(relayMsg?.nodeId).toBe('town-01');
    expect(relayMsg?.payload).toMatchObject({ kind: 1, content: 'hello' });

    ws.close();
    relay.close();
  });

  it('scoped delivery — subscribing to town-01 does NOT receive events for town-02 (AC #2)', async () => {
    const relay01 = await startRelayServer('town-01');
    const relay02 = await startRelayServer('town-02');

    // Client A subscribes only to town-01
    const wsA = await connect(`${metricsUrl}?subscribe=relayEvents:town-01`);
    // Client B subscribes only to town-02
    const wsB = await connect(`${metricsUrl}?subscribe=relayEvents:town-02`);

    await new Promise((r) => setTimeout(r, 200));

    const eventA = { id: 'aa', kind: 1, pubkey: 'pp', content: 'from-01', tags: [], sig: 's', created_at: 1 };
    const eventB = { id: 'bb', kind: 1, pubkey: 'pp', content: 'from-02', tags: [], sig: 's', created_at: 2 };

    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    wsA.on('message', (d) => {
      try { receivedA.push(JSON.parse(d.toString())); } catch { /* ignore */ }
    });
    wsB.on('message', (d) => {
      try { receivedB.push(JSON.parse(d.toString())); } catch { /* ignore */ }
    });

    relay01.push(eventA);
    relay02.push(eventB);

    await new Promise((r) => setTimeout(r, 500));

    const flatA = flatten(receivedA).filter((m) => (m as { type?: string }).type === 'relayEvents');
    const flatB = flatten(receivedB).filter((m) => (m as { type?: string }).type === 'relayEvents');

    // Client A should only have events from town-01
    expect(flatA.every((m) => (m as { nodeId?: string }).nodeId === 'town-01')).toBe(true);
    expect(flatA.some((m) => (m as { payload?: { content?: string } }).payload?.content === 'from-01')).toBe(true);

    // Client B should only have events from town-02
    expect(flatB.every((m) => (m as { nodeId?: string }).nodeId === 'town-02')).toBe(true);
    expect(flatB.some((m) => (m as { payload?: { content?: string } }).payload?.content === 'from-02')).toBe(true);

    // No cross-node leak
    expect(flatA.some((m) => (m as { nodeId?: string }).nodeId === 'town-02')).toBe(false);
    expect(flatB.some((m) => (m as { nodeId?: string }).nodeId === 'town-01')).toBe(false);

    wsA.close();
    wsB.close();
    relay01.close();
    relay02.close();
  });

  it('client-close cleans up upstream relay sockets', async () => {
    const port = await getFreePort();
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    relayServers.push(wss);
    orchestrator.registerEndpoint('town-01', `ws://127.0.0.1:${port}`);

    let upstreamConnectCount = 0;
    let upstreamCloseCount = 0;
    wss.on('connection', (ws: WsClient) => {
      upstreamConnectCount++;
      ws.on('close', () => { upstreamCloseCount++; });
    });

    const ws = await connect(`${metricsUrl}?subscribe=relayEvents:town-01`);
    await new Promise((r) => setTimeout(r, 200));

    expect(upstreamConnectCount).toBe(1);
    expect(upstreamCloseCount).toBe(0);

    // Close the downstream (dashboard) client
    ws.close();
    await new Promise((r) => setTimeout(r, 300));

    // The upstream relay connection should have been cleaned up
    expect(upstreamCloseCount).toBe(1);
    wss.close();
  });

  it('no subscription — baseline still delivers metrics and heartbeat', async () => {
    const ws = await connect(metricsUrl);
    const msgs = await collectUntil(ws, (list) => list.length >= 1, 2000);
    expect(msgs.length).toBeGreaterThan(0);
    ws.close();
  });
});
