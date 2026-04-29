/**
 * Connector Admin Client for Townhouse (Story 21.3, contract aligned in 21.7.5).
 *
 * HTTP client for the connector's admin API endpoints. Paths and response
 * shapes mirror the connector source-of-truth — see
 * `@toon-protocol/connector` `packages/connector/src/http/{types,admin-api}.ts`.
 *
 * Uses Node.js native fetch (available in Node 20+).
 *
 * Two distinct HTTP servers live on the connector image:
 *   - healthCheckPort serves /health and /health/{live,ready}
 *   - adminApi.port serves /admin/* (peers, metrics.json, routes, channels, …)
 *
 * The base URL passed to this client must point at whichever server hosts
 * the endpoint being called: pass the healthCheckPort base for `getHealth`
 * and the adminApi.port base for `getPeers` / `getMetrics`. In practice
 * Townhouse currently runs both ports on the same host, so callers either
 * construct two clients or hit a shared base URL when the ports overlap.
 */

import type {
  HealthResponse,
  MetricsResponse,
  PeerStatus,
  PeersResponse,
} from './types.js';

/** Default request timeout in milliseconds (5 seconds) */
const DEFAULT_TIMEOUT_MS = 5000;

export class ConnectorAdminClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /**
   * @param baseUrl - Base URL for the connector admin API (e.g., 'http://localhost:9402')
   * @param timeoutMs - Request timeout in milliseconds (default: 5000)
   */
  constructor(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    // Strip trailing slash to avoid double-slash in URL construction
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * GET /health — returns the connector's HealthStatus from the healthCheckPort server.
   *
   * @throws Error when connector is not running, returns non-200, or shape is invalid
   */
  async getHealth(): Promise<HealthResponse> {
    const response = await this.fetch('/health');
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      throw new Error('Connector admin API: invalid health response shape');
    }
    const obj = body as Record<string, unknown>;
    const status = obj['status'];
    if (
      status !== 'healthy' &&
      status !== 'unhealthy' &&
      status !== 'starting' &&
      status !== 'degraded'
    ) {
      throw new Error('Connector admin API: invalid health response shape');
    }
    if (
      typeof obj['uptime'] !== 'number' ||
      typeof obj['peersConnected'] !== 'number' ||
      typeof obj['totalPeers'] !== 'number' ||
      typeof obj['timestamp'] !== 'string'
    ) {
      throw new Error('Connector admin API: invalid health response shape');
    }
    return body as HealthResponse;
  }

  /**
   * GET /admin/metrics.json — returns the connector's per-peer ILP counters
   * with an aggregate rollup, mirroring `AdminMetricsJsonResponse`.
   *
   * @throws Error when connector is not running, returns non-200, or shape is invalid
   */
  async getMetrics(): Promise<MetricsResponse> {
    const response = await this.fetch('/admin/metrics.json');
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      throw new Error('Connector admin API: invalid metrics response shape');
    }
    const obj = body as Record<string, unknown>;
    const aggregate = obj['aggregate'];
    if (
      typeof obj['uptimeSeconds'] !== 'number' ||
      typeof aggregate !== 'object' ||
      aggregate === null ||
      !Array.isArray(obj['peers']) ||
      typeof obj['timestamp'] !== 'string'
    ) {
      throw new Error('Connector admin API: invalid metrics response shape');
    }
    const agg = aggregate as Record<string, unknown>;
    if (
      typeof agg['packetsForwarded'] !== 'number' ||
      typeof agg['packetsRejected'] !== 'number' ||
      typeof agg['bytesSent'] !== 'number'
    ) {
      throw new Error('Connector admin API: invalid metrics response shape');
    }
    return body as MetricsResponse;
  }

  /**
   * GET /admin/peers — returns the connector's peer roster with route counts
   * and ILP addresses. Returns the unwrapped peers array (the wrapper's
   * nodeId / peerCount / connectedCount fields are dropped).
   *
   * @throws Error when connector is not running, returns non-200, or shape is invalid
   */
  async getPeers(): Promise<PeerStatus[]> {
    const response = await this.fetch('/admin/peers');
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      throw new Error('Connector admin API: invalid peers response shape');
    }
    const obj = body as Record<string, unknown>;
    if (!Array.isArray(obj['peers'])) {
      throw new Error('Connector admin API: invalid peers response shape');
    }
    return (body as PeersResponse).peers;
  }

  // ── Private helpers ──

  /**
   * Perform an HTTP GET request to the connector admin API.
   * Wraps fetch with error handling for connection refused and non-200 responses.
   */
  private async fetch(path: string): Promise<Response> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(
            `Connector admin API request timeout after ${this.timeoutMs}ms: ${url}`
          );
        }
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Connector admin API connection refused: ${msg}`);
      }

      if (!response.ok) {
        throw new Error(
          `Connector admin API error: ${response.status} ${response.statusText}`
        );
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}
