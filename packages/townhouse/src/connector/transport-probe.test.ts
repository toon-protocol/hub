import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import * as http from 'node:http';
import { TransportProbe } from './transport-probe.js';

/** Start a TCP server on localhost:0 and return { server, port }. */
async function startTcpServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

/** Start a minimal HTTP server on localhost:0, returns { server, url }. */
async function startHttpServer(): Promise<{
  server: http.Server;
  url: string;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

async function closeServer(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('TransportProbe', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('reports reachable=true when proxy TCP server is up', async () => {
    const { server, port } = await startTcpServer();
    const { server: httpSrv, url: directUrl } = await startHttpServer();

    const probe = new TransportProbe({
      proxyUrl: `socks5://127.0.0.1:${port}`,
      intervalMs: 60_000,
      directProbeUrl: directUrl,
    });
    probe.start();

    // Wait up to 1s for the first probe tick
    await vi.waitFor(
      () => {
        const s = probe.getStatus();
        expect(s.lastProbedAt).toBeGreaterThan(0);
      },
      { timeout: 1000 }
    );

    const status = probe.getStatus();
    expect(status.reachable).toBe(true);
    expect(status.latencyProxyMs).not.toBeNull();
    expect(status.latencyProxyMs).toBeLessThan(100);
    expect(status.probeError).toBeNull();

    probe.stop();
    await closeServer(server);
    await closeServer(httpSrv);
  });

  it('reports reachable=false when proxy TCP server is down', async () => {
    const { server: httpSrv, url: directUrl } = await startHttpServer();

    const probe = new TransportProbe({
      proxyUrl: 'socks5://127.0.0.1:1', // port 1 is always closed
      intervalMs: 60_000,
      directProbeUrl: directUrl,
    });
    probe.start();

    await vi.waitFor(
      () => {
        const s = probe.getStatus();
        expect(s.lastProbedAt).toBeGreaterThan(0);
      },
      { timeout: 5000 }
    );

    const status = probe.getStatus();
    expect(status.reachable).toBe(false);
    expect(status.probeError).toBeTruthy();

    probe.stop();
    await closeServer(httpSrv);
  });

  it('transitions from reachable to unreachable when server closes', async () => {
    const { server, port } = await startTcpServer();
    const { server: httpSrv, url: directUrl } = await startHttpServer();

    const probe = new TransportProbe({
      proxyUrl: `socks5://127.0.0.1:${port}`,
      intervalMs: 50, // fast for test
      directProbeUrl: directUrl,
    });
    probe.start();

    // Wait for the FIRST successful probe (lastProbedAt advances and reachable
    // is true). The default initial status is reachable=true with
    // lastProbedAt=0; checking only `reachable` would race past the first tick.
    await vi.waitFor(
      () => {
        const s = probe.getStatus();
        expect(s.lastProbedAt).toBeGreaterThan(0);
        expect(s.reachable).toBe(true);
      },
      { timeout: 1000 }
    );

    // Close the server — subsequent connects fail with ECONNREFUSED
    await closeServer(server);

    // Wait for a probe AFTER the server closed (lastProbedAt advances again
    // AND reachable flips false). Polling on `reachable` alone would race the
    // tick and miss the transition log.
    const probedBeforeClose = probe.getStatus().lastProbedAt;
    await vi.waitFor(
      () => {
        const s = probe.getStatus();
        expect(s.lastProbedAt).toBeGreaterThan(probedBeforeClose);
        expect(s.reachable).toBe(false);
      },
      { timeout: 2000 }
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[TransportProbe] proxy became unreachable')
    );

    probe.stop();
    await closeServer(httpSrv);
  });

  it('stop() halts the loop — no further status updates', async () => {
    const { server, port } = await startTcpServer();
    const { server: httpSrv, url: directUrl } = await startHttpServer();

    const probe = new TransportProbe({
      proxyUrl: `socks5://127.0.0.1:${port}`,
      intervalMs: 200, // long enough for the test to stop cleanly between ticks
      directProbeUrl: directUrl,
    });
    probe.start();

    // Wait for first tick to complete
    await vi.waitFor(
      () => expect(probe.getStatus().lastProbedAt).toBeGreaterThan(0),
      { timeout: 1000 }
    );

    // Wait a short settle period so we're not in the middle of a tick
    await new Promise((r) => setTimeout(r, 50));

    probe.stop();
    const snapshotAfterStop = probe.getStatus().lastProbedAt;

    // Wait > 1 interval — no new tick should fire
    await new Promise((r) => setTimeout(r, 300));
    expect(probe.getStatus().lastProbedAt).toBe(snapshotAfterStop);

    await closeServer(server);
    await closeServer(httpSrv);
  });

  it('stop() is idempotent', () => {
    const probe = new TransportProbe({ proxyUrl: '', intervalMs: 60_000 });
    probe.stop();
    probe.stop(); // should not throw
  });

  it('start() is idempotent — calling twice does not create double interval', async () => {
    const { server, port } = await startTcpServer();
    const { server: httpSrv, url: directUrl } = await startHttpServer();

    const probe = new TransportProbe({
      proxyUrl: `socks5://127.0.0.1:${port}`,
      intervalMs: 60_000,
      directProbeUrl: directUrl,
    });
    probe.start();
    probe.start(); // second call is no-op

    await vi.waitFor(
      () => expect(probe.getStatus().lastProbedAt).toBeGreaterThan(0),
      { timeout: 1000 }
    );

    probe.stop();
    await closeServer(server);
    await closeServer(httpSrv);
  });

  it('setProxyUrl redirects subsequent probes', async () => {
    const { server: server1, port: port1 } = await startTcpServer();
    const { server: httpSrv, url: directUrl } = await startHttpServer();

    const probe = new TransportProbe({
      proxyUrl: `socks5://127.0.0.1:${port1}`,
      intervalMs: 50,
      directProbeUrl: directUrl,
    });
    probe.start();

    await vi.waitFor(() => expect(probe.getStatus().reachable).toBe(true), {
      timeout: 1000,
    });

    // Redirect to port 1 (always closed)
    probe.setProxyUrl('socks5://127.0.0.1:1');

    await vi.waitFor(() => expect(probe.getStatus().reachable).toBe(false), {
      timeout: 2000,
    });

    probe.stop();
    await closeServer(server1);
    await closeServer(httpSrv);
  });

  it('surfaces invalid_proxy_url for garbage URL', async () => {
    const { server: httpSrv, url: directUrl } = await startHttpServer();

    const probe = new TransportProbe({
      proxyUrl: 'not a url at all !!',
      intervalMs: 60_000,
      directProbeUrl: directUrl,
    });
    probe.start();

    await vi.waitFor(
      () => expect(probe.getStatus().lastProbedAt).toBeGreaterThan(0),
      { timeout: 1000 }
    );

    const status = probe.getStatus();
    expect(status.reachable).toBe(false);
    expect(status.probeError).toBe('invalid_proxy_url');

    probe.stop();
    await closeServer(httpSrv);
  });

  it('no per-tick info-level logs for proxy host', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { server, port } = await startTcpServer();
    const { server: httpSrv, url: directUrl } = await startHttpServer();

    const probe = new TransportProbe({
      proxyUrl: `socks5://127.0.0.1:${port}`,
      intervalMs: 50,
      directProbeUrl: directUrl,
    });
    probe.start();

    // Allow 5 ticks
    await new Promise((r) => setTimeout(r, 300));
    probe.stop();

    // Should not have called console.info or console.log with proxy host
    const proxyHost = `127.0.0.1:${port}`;
    for (const call of consoleSpy.mock.calls) {
      expect(String(call[0])).not.toContain(proxyHost);
    }
    for (const call of logSpy.mock.calls) {
      expect(String(call[0])).not.toContain(proxyHost);
    }

    consoleSpy.mockRestore();
    logSpy.mockRestore();
    await closeServer(server);
    await closeServer(httpSrv);
  });

  it('direct mode (empty proxyUrl): reachable=true, no proxy latency', async () => {
    const { server: httpSrv, url: directUrl } = await startHttpServer();

    const probe = new TransportProbe({
      proxyUrl: '',
      intervalMs: 60_000,
      directProbeUrl: directUrl,
    });
    probe.start();

    await vi.waitFor(
      () => expect(probe.getStatus().lastProbedAt).toBeGreaterThan(0),
      { timeout: 1000 }
    );

    const status = probe.getStatus();
    expect(status.reachable).toBe(true);
    expect(status.latencyProxyMs).toBeNull();
    expect(status.latencyDirectMs).not.toBeNull();

    probe.stop();
    await closeServer(httpSrv);
  });
});
