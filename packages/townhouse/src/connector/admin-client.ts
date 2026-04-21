/**
 * Connector Admin Client for Townhouse (Story 21.3).
 *
 * HTTP client for the connector's admin API endpoints.
 * Uses Node.js native fetch (available in Node 20+).
 */

import type { HealthResponse, MetricsResponse, PeerStatus } from './types.js';

/**
 * ConnectorAdminClient communicates with the connector's admin API
 * to retrieve health, metrics, and peer status information.
 */
/** Default request timeout in milliseconds (5 seconds) */
const DEFAULT_TIMEOUT_MS = 5000;

export class ConnectorAdminClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /**
   * @param baseUrl - Base URL for the connector admin API (e.g., 'http://localhost:9401')
   * @param timeoutMs - Request timeout in milliseconds (default: 5000)
   */
  constructor(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    // Strip trailing slash to avoid double-slash in URL construction
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * GET /health — returns connector health status and uptime.
   *
   * @throws Error when connector is not running or returns non-200
   */
  async getHealth(): Promise<HealthResponse> {
    const response = await this.fetch('/health');
    const body: unknown = await response.json();
    const obj = body as Record<string, unknown>;
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof obj['status'] !== 'string' ||
      typeof obj['uptime'] !== 'number'
    ) {
      throw new Error('Connector admin API: invalid health response shape');
    }
    return body as HealthResponse;
  }

  /**
   * GET /metrics — returns packet forwarding and byte count metrics.
   *
   * @throws Error when connector is not running or returns non-200
   */
  async getMetrics(): Promise<MetricsResponse> {
    const response = await this.fetch('/metrics');
    const body: unknown = await response.json();
    const obj = body as Record<string, unknown>;
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof obj['packetsForwarded'] !== 'number' ||
      typeof obj['packetsRejected'] !== 'number' ||
      typeof obj['bytesSent'] !== 'number'
    ) {
      throw new Error('Connector admin API: invalid metrics response shape');
    }
    return body as MetricsResponse;
  }

  /**
   * GET /peers — returns status of all connected peers.
   *
   * @throws Error when connector is not running or returns non-200
   */
  async getPeers(): Promise<PeerStatus[]> {
    const response = await this.fetch('/peers');
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      throw new Error('Connector admin API: invalid peers response shape');
    }
    return body as PeerStatus[];
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
        throw new Error(
          `Connector admin API connection refused: ${msg}`
        );
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
