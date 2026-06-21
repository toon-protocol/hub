/**
 * ATOR transport probe — periodically TCP-connects to the configured SOCKS5
 * proxy host:port and measures direct HTTPS latency for comparison.
 *
 * The probe answers a single operator question: "is my configured ATOR proxy
 * contactable from this host?" TCP connect is the right granularity — if the
 * TCP listener is up, the connector's real BTP traffic will succeed.
 *
 * The probe NEVER makes a real SOCKS5 handshake or proxied request — only a
 * plain TCP connect to the proxy host:port.
 */

import * as net from 'node:net';
import * as https from 'node:https';
import * as http from 'node:http';

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;
const PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_DIRECT_PROBE_URL = 'https://1.1.1.1/';

export interface TransportProbeOptions {
  proxyUrl: string;
  intervalMs?: number;
  /** Override the direct-latency probe URL (for tests — avoids real network). */
  directProbeUrl?: string;
}

export interface TransportProbeStatus {
  reachable: boolean;
  latencyProxyMs: number | null;
  latencyDirectMs: number | null;
  lastProbedAt: number;
  probeError: string | null;
}

export class TransportProbe {
  private proxyUrl: string;
  private readonly intervalMs: number;
  private readonly directProbeUrl: string;

  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private status: TransportProbeStatus = {
    reachable: true,
    latencyProxyMs: null,
    latencyDirectMs: null,
    lastProbedAt: 0,
    probeError: null,
  };

  constructor(opts: TransportProbeOptions) {
    this.proxyUrl = opts.proxyUrl;
    this.intervalMs = Math.max(
      MIN_INTERVAL_MS,
      opts.intervalMs ?? DEFAULT_INTERVAL_MS
    );
    this.directProbeUrl = opts.directProbeUrl ?? DEFAULT_DIRECT_PROBE_URL;
  }

  /** Start the probe loop. Idempotent — calling twice while running is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = (): void => {
      void this.tick().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[TransportProbe] tick failed: ${msg}`);
      });
    };
    // Run immediately on start, then on interval
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  /** Stop the probe loop. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns the latest probe snapshot synchronously. Never blocks. */
  getStatus(): TransportProbeStatus {
    return { ...this.status };
  }

  /**
   * Update the target proxy URL.
   * The next tick will use the new URL; the current tick may complete against the old URL.
   */
  setProxyUrl(url: string): void {
    this.proxyUrl = url;
  }

  // ── Private probe logic ──────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.running) return;

    const directMs = await this.probeDirectLatency();
    if (!this.running) return;

    if (!this.proxyUrl) {
      // Direct-mode: no proxy to probe
      const prev = this.status;
      this.status = {
        reachable: true,
        latencyProxyMs: null,
        latencyDirectMs: directMs,
        lastProbedAt: Date.now(),
        probeError: null,
      };
      this.logTransition(prev, this.status);
      return;
    }

    let host: string;
    let port: number;
    let hostPort: string;
    try {
      const parsed = new URL(this.proxyUrl);
      host = parsed.hostname;
      const rawPort = Number(parsed.port);
      if (
        !parsed.port ||
        !Number.isInteger(rawPort) ||
        rawPort < 1 ||
        rawPort > 65535
      ) {
        throw new Error('missing or invalid port');
      }
      port = rawPort;
      hostPort = `${host}:${port}`;
    } catch {
      const prev = this.status;
      this.status = {
        reachable: false,
        latencyProxyMs: null,
        latencyDirectMs: directMs,
        lastProbedAt: Date.now(),
        probeError: 'invalid_proxy_url',
      };
      this.logTransition(prev, this.status);
      return;
    }

    const { reachable, latencyMs, error } = await this.probeTcp(host, port);
    if (!this.running) return;
    const prev = this.status;
    this.status = {
      reachable,
      latencyProxyMs: latencyMs,
      latencyDirectMs: directMs,
      lastProbedAt: Date.now(),
      probeError: error ?? null,
    };
    this.logTransition(prev, this.status, hostPort);
  }

  private probeTcp(
    host: string,
    port: number
  ): Promise<{ reachable: boolean; latencyMs: number | null; error?: string }> {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = net.createConnection({ host, port });
      let settled = false;

      const settle = (result: {
        reachable: boolean;
        latencyMs: number | null;
        error?: string;
      }) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* best-effort */
        }
        resolve(result);
      };

      const timeout = setTimeout(() => {
        settle({ reachable: false, latencyMs: null, error: 'timeout' });
      }, PROBE_TIMEOUT_MS);

      socket.once('connect', () => {
        clearTimeout(timeout);
        settle({ reachable: true, latencyMs: Date.now() - start });
      });

      socket.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        settle({
          reachable: false,
          latencyMs: null,
          error: err.code ?? err.message,
        });
      });
    });
  }

  private probeDirectLatency(): Promise<number | null> {
    return new Promise((resolve) => {
      const start = Date.now();
      let settled = false;

      const settle = (ms: number | null) => {
        if (settled) return;
        settled = true;
        resolve(ms);
      };

      // Support both http:// (tests) and https:// (production)
      const isHttps = this.directProbeUrl.startsWith('https://');
      const requester = isHttps ? https : http;

      let req: http.ClientRequest | undefined;
      const timeout = setTimeout(() => {
        try {
          req?.destroy();
        } catch {
          /* best-effort */
        }
        settle(null);
      }, PROBE_TIMEOUT_MS);

      try {
        req = requester.request(
          this.directProbeUrl,
          { method: 'HEAD' },
          (res) => {
            clearTimeout(timeout);
            res.resume();
            settle(Date.now() - start);
          }
        );

        req.once('error', (err: NodeJS.ErrnoException) => {
          clearTimeout(timeout);
          console.debug(
            `[TransportProbe] direct latency probe failed: ${err.code ?? err.message}`
          );
          settle(null);
        });

        req.end();
      } catch (err) {
        clearTimeout(timeout);
        const msg = err instanceof Error ? err.message : String(err);
        console.debug(`[TransportProbe] direct latency probe threw: ${msg}`);
        settle(null);
      }
    });
  }

  private logTransition(
    prev: TransportProbeStatus,
    next: TransportProbeStatus,
    hostPort?: string
  ): void {
    // Suppress reachable→unreachable transition log on the very first probe;
    // the default initial state is reachable=true even before any probe ran.
    if (prev.lastProbedAt === 0) return;

    const target = hostPort ? ` (${hostPort})` : '';
    if (prev.reachable && !next.reachable) {
      console.warn(
        `[TransportProbe] proxy became unreachable${target}: ${next.probeError ?? 'unknown'}`
      );
    } else if (!prev.reachable && next.reachable) {
      console.debug(`[TransportProbe] proxy reachable${target}`);
    }
    // No per-tick info logs for the proxy host (see AC-22)
  }
}
