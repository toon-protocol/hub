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
  ConnectorFeeEntry,
  EarningsResponse,
  EarningsTimestamp,
  HealthResponse,
  HsHostnameResponse,
  MetricsResponse,
  PeerEarnings,
  PeerStatus,
  PeersResponse,
  PacketLogFilter,
  PacketLogEntry,
  PacketLogResponse,
  RecentClaim,
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
   * GET /admin/hs-hostname — returns the connector's published .anyone hidden-service
   * hostname (Epic 45 / Story 44.1). Returns 200 with {hostname, publishedAt} both
   * possibly null while bootstrap is in progress, both non-null once anon publishes.
   * Returns 503 when the connector is anon-disabled (anon.enabled: false in config).
   *
   * @throws Error('connector is anon-disabled (HTTP 503)') on 503 — caller can match
   *   on this exact prefix for actionable diagnostics.
   * @throws Error on non-200/503 status, network error, or shape-validation failure.
   */
  async getHsHostname(): Promise<HsHostnameResponse> {
    const url = `${this.baseUrl}/admin/hs-hostname`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let body: unknown;
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
      if (response.status === 503) {
        throw new Error('connector is anon-disabled (HTTP 503)');
      }
      // fast-fail on unexpected non-200/503 status codes. Retrying a 404
      // (pre-v3.5.0 connector image) for 120 s silently burns the full readiness
      // timeout. Only 200 (success) and 503 (anon-disabled, caught above) are
      // expected — everything else is an immediate fatal error.
      if (!response.ok) {
        throw new Error(
          `Connector admin API unexpected status ${response.status} on /admin/hs-hostname — ` +
            `expected 200 or 503 (connector image may be too old or misconfigured)`
        );
      }
      // Body read MUST happen inside the AbortSignal-protected try so the
      // request timeout covers a slow / streaming JSON body. An AbortError
      // here means the body read itself timed out; surface as a timeout so
      // the readiness loop's diagnostics distinguish it from a malformed
      // body. Other JSON errors (true SyntaxError on non-JSON content)
      // re-throw as a shape error.
      try {
        body = await response.json();
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(
            `Connector admin API request timeout after ${this.timeoutMs}ms: ${url}`
          );
        }
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Connector admin API: invalid JSON in hs-hostname response: ${msg}`
        );
      }
    } finally {
      clearTimeout(timer);
    }
    if (typeof body !== 'object' || body === null) {
      throw new Error(
        'Connector admin API: invalid hs-hostname response shape'
      );
    }
    const obj = body as Record<string, unknown>;
    const hostname = obj['hostname'];
    const publishedAt = obj['publishedAt'];
    if (
      (hostname !== null && typeof hostname !== 'string') ||
      (publishedAt !== null && typeof publishedAt !== 'string')
    ) {
      throw new Error(
        'Connector admin API: invalid hs-hostname response shape'
      );
    }
    // Empty-string hostname / publishedAt are server-side bugs — reject so
    // the readiness loop fails fast instead of returning "ready" with an
    // unusable address or empty timestamp.
    if (typeof hostname === 'string' && hostname.length === 0) {
      throw new Error(
        'Connector admin API: invalid hs-hostname response shape'
      );
    }
    if (typeof publishedAt === 'string' && publishedAt.length === 0) {
      throw new Error(
        'Connector admin API: invalid hs-hostname response shape'
      );
    }
    // Enforce the `.anon` suffix at the trust boundary: the ATOR network uses
    // `.anon` as the hidden-service TLD (analogous to Tor's `.onion`). A
    // non-`.anon` value indicates connector-side misconfiguration and would
    // propagate as an unusable address through Story 45.4's CLI.
    if (typeof hostname === 'string' && !hostname.endsWith('.anon')) {
      throw new Error(
        'Connector admin API: invalid hs-hostname response shape'
      );
    }
    return body as HsHostnameResponse;
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
   * GET /admin/earnings.json — returns the connector's per-peer per-asset
   * earnings projection, mirroring `AdminEarningsJsonResponse` (connector v3.2.0+).
   *
   * Source of truth: @toon-protocol/connector
   *   packages/connector/src/http/admin-api.ts:1864-1945
   *
   * Returns HTTP 503 when the connector is started without settlement config
   * (accountManager / claimReceiver not wired). Townhouse's apex always wires
   * both; 503 in production indicates connector misconfiguration.
   *
   * Wire-shape adaptation: the connector's `timestamp: string` field is
   * wrapped into `{ iso: string }` on the way out (EarningsTimestamp).
   *
   * @throws Error when connector is not running, returns non-200, or shape is invalid
   */
  async getEarnings(): Promise<EarningsResponse> {
    const response = await this.fetch('/admin/earnings.json');
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      throw new Error('Connector admin API: invalid earnings response shape');
    }
    const obj = body as Record<string, unknown>;
    if (
      typeof obj['uptimeSeconds'] !== 'number' ||
      !Array.isArray(obj['peers']) ||
      !Array.isArray(obj['connectorFees']) ||
      !Array.isArray(obj['recentClaims']) ||
      typeof obj['timestamp'] !== 'string'
    ) {
      throw new Error('Connector admin API: invalid earnings response shape');
    }
    // Inner-element shape validation — AC #3 drift coverage for named fields
    // (peers[].byAsset[].claimsReceivedTotal, connectorFees[].assetCode, recentClaims[].direction).
    const peers = obj['peers'] as unknown[];
    for (const peer of peers) {
      if (typeof peer !== 'object' || peer === null) {
        throw new Error('Connector admin API: invalid earnings response shape');
      }
      const p = peer as Record<string, unknown>;
      if (typeof p['peerId'] !== 'string' || !Array.isArray(p['byAsset'])) {
        throw new Error('Connector admin API: invalid earnings response shape');
      }
      for (const asset of p['byAsset'] as unknown[]) {
        if (typeof asset !== 'object' || asset === null) {
          throw new Error(
            'Connector admin API: invalid earnings response shape'
          );
        }
        const a = asset as Record<string, unknown>;
        if (
          typeof a['assetCode'] !== 'string' ||
          typeof a['assetScale'] !== 'number' ||
          typeof a['claimsReceivedTotal'] !== 'string' ||
          typeof a['claimsSentTotal'] !== 'string' ||
          typeof a['netBalance'] !== 'string' ||
          (a['lastClaimAt'] !== null && typeof a['lastClaimAt'] !== 'string')
        ) {
          throw new Error(
            'Connector admin API: invalid earnings response shape'
          );
        }
      }
    }
    const fees = obj['connectorFees'] as unknown[];
    for (const fee of fees) {
      if (typeof fee !== 'object' || fee === null) {
        throw new Error('Connector admin API: invalid earnings response shape');
      }
      const f = fee as Record<string, unknown>;
      if (
        typeof f['assetCode'] !== 'string' ||
        typeof f['assetScale'] !== 'number' ||
        typeof f['total'] !== 'string'
      ) {
        throw new Error('Connector admin API: invalid earnings response shape');
      }
    }
    const claims = obj['recentClaims'] as unknown[];
    for (const claim of claims) {
      if (typeof claim !== 'object' || claim === null) {
        throw new Error('Connector admin API: invalid earnings response shape');
      }
      const c = claim as Record<string, unknown>;
      if (
        typeof c['peerId'] !== 'string' ||
        typeof c['assetCode'] !== 'string' ||
        typeof c['assetScale'] !== 'number' ||
        typeof c['amount'] !== 'string' ||
        (c['direction'] !== 'inbound' && c['direction'] !== 'outbound') ||
        typeof c['at'] !== 'string'
      ) {
        throw new Error('Connector admin API: invalid earnings response shape');
      }
    }
    const timestamp: EarningsTimestamp = { iso: obj['timestamp'] as string };
    // Explicit construction (not spread) — prevents forward-compat wire fields
    // from leaking through the typed surface.
    return {
      uptimeSeconds: obj['uptimeSeconds'] as number,
      peers: peers as PeerEarnings[],
      connectorFees: fees as ConnectorFeeEntry[],
      recentClaims: claims as RecentClaim[],
      timestamp,
    };
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

  /**
   * POST /admin/peers — register (or re-register, idempotent) a child peer
   * with the connector. Used by the boot reconciler (Story 46.1) to
   * re-register peers present in `nodes.yaml` but missing from the
   * connector's runtime peer roster (e.g., after a connector restart).
   *
   * The connector's POST /admin/peers handler treats a POST whose `id`
   * matches an existing peer as a re-registration (no-op for the peer
   * itself; routes are appended). A POST with a new `id` triggers
   * `addPeer()` and BTP connection setup.
   *
   * @param input.id - peer identifier (matches `nodes.yaml`'s `peerId` and
   *   the connector's `PeerStatus.id`).
   * @param input.url - BTP WebSocket URL the connector dials. MUST start
   *   with `ws://` or `wss://` (the connector validates this).
   * @param input.authToken - shared auth token; pass empty string for
   *   internal Townhouse peers (no auth).
   * @param input.routes - optional ILP route prefixes to register against
   *   this peer. The reconciler passes the peer's ilpAddress.
   * @param input.transport - optional per-peer transport selection
   *   (connector >= 3.6.2). `'direct'` forces the connector to bypass the
   *   global SOCKS5 transport for this peer, even when the apex itself
   *   runs in `transport.type: socks5` mode. Required for Docker-sibling
   *   peers in HS mode — the anon SOCKS5 proxy cannot resolve internal
   *   Docker hostnames. When omitted, the peer inherits the connector's
   *   global transport (back-compat with pre-3.6.2 connectors).
   *
   * @throws Error on non-2xx response, timeout, or connection refused.
   */
  async registerPeer(input: {
    id: string;
    url: string;
    authToken: string;
    routes?: { prefix: string; priority?: number }[];
    transport?: 'direct' | 'socks5';
  }): Promise<void> {
    if (!input.url.startsWith('ws://') && !input.url.startsWith('wss://')) {
      throw new Error(
        `Connector admin API: registerPeer.url must start with ws:// or wss:// (got: ${input.url})`
      );
    }
    const url = `${this.baseUrl}/admin/peers`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(
            `Connector admin API request timeout after ${this.timeoutMs}ms: POST ${url}`
          );
        }
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Connector admin API request failed: POST ${url} — ${msg}`
        );
      }
      if (!response.ok) {
        // Body read MUST happen inside the AbortSignal-protected try so a slow
        // response body cannot hang past the request timeout.
        let body = '';
        try {
          body = await response.text();
        } catch (error: unknown) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(
              `Connector admin API request timeout after ${this.timeoutMs}ms: POST ${url} (body read)`
            );
          }
          /* best-effort: leave body empty */
        }
        throw new Error(
          `Connector admin API error: POST /admin/peers returned ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * DELETE /admin/peers/:peerId?removeRoutes=true — deregister a child peer.
   *
   * Idempotent: a 404 from the connector (peer already removed) is treated as
   * success so callers can safely use this as a rollback step without knowing
   * whether the peer was ever registered.
   *
   * `removeRoutes=true` is always sent so the connector drops the ILP routing
   * entries for this peer along with the BTP connection config.
   *
   * @throws Error on empty peerId (rejected at client, no network request made)
   * @throws Error on non-2xx/404 response, timeout, or connection refused
   */
  async removePeer(peerId: string): Promise<void> {
    if (!peerId) {
      throw new Error(
        'Connector admin API: removePeer requires a non-empty peerId'
      );
    }
    const url = `${this.baseUrl}/admin/peers/${encodeURIComponent(peerId)}?removeRoutes=true`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'DELETE',
          signal: controller.signal,
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(
            `Connector admin API request timeout after ${this.timeoutMs}ms: DELETE ${url}`
          );
        }
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Connector admin API request failed: DELETE ${url} — ${msg}`
        );
      }
      // 404 means peer already gone — idempotent success.
      if (response.status === 404) {
        return;
      }
      if (!response.ok) {
        let body = '';
        try {
          body = await response.text();
        } catch (error: unknown) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(
              `Connector admin API request timeout after ${this.timeoutMs}ms: DELETE ${url} (body read)`
            );
          }
          /* best-effort: leave body empty */
        }
        throw new Error(
          `Connector admin API error: DELETE /admin/peers/${peerId} returned ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET /packets — returns the connector's raw packet log filtered by the
   * given criteria. Used by the timeseries aggregation route (story 21.10).
   *
   * Townhouse-Side Contract: see packages/sdk/CONNECTOR_MIGRATION.md §getPacketLog.
   * If the connector image does not expose GET /packets, this method throws
   * with a `ConnectorEndpointNotFound` error code so the route can return 503.
   *
   * @throws Error with code='ConnectorEndpointNotFound' when connector returns 404
   * @throws Error when connector is not running, returns non-200, or shape is invalid
   */
  async getPacketLog(filter: PacketLogFilter = {}): Promise<PacketLogEntry[]> {
    const params = new URLSearchParams();
    if (filter.ilpAddress !== undefined)
      params.set('ilpAddress', filter.ilpAddress);
    if (filter.since !== undefined) params.set('since', String(filter.since));
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const path = params.toString()
      ? `/packets?${params.toString()}`
      : '/packets';

    let response: Response;
    try {
      response = await this.fetch(path);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('404')) {
        const err = new Error(
          'Connector does not expose GET /packets — endpoint not found'
        );
        (err as NodeJS.ErrnoException).code = 'ConnectorEndpointNotFound';
        throw err;
      }
      throw error;
    }

    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      throw new Error(
        'Connector admin API: invalid packet log response shape — expected array'
      );
    }
    return body as PacketLogResponse;
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
