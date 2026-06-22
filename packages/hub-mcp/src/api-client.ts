/**
 * Thin HTTP client for the apex Fastify control API (`127.0.0.1:9400`, started
 * by `hub up`). Live telemetry + money/config endpoints. Holds no keys;
 * the apex owns the wallet. Mirrors client-mcp's ControlClient error/timeout
 * idiom (AbortController timeout, typed errors, `ping()` liveness probe).
 */
import type {
  NodeInfo,
  WalletBalancesPayload,
  WithdrawRequest,
  WithdrawResponse,
  AggregatedEarnings,
  TransportStatusPayload,
  TransportPatchRequest,
} from '@toon-protocol/hub';

/** Error thrown when the apex API returns a non-2xx response. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when the apex API is unreachable (stack not up / wrong port). */
export class ApexUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly causedBy?: unknown
  ) {
    super(`hub apex API not reachable at ${baseUrl}`);
    this.name = 'ApexUnreachableError';
  }
}

export interface ApiClientOptions {
  /** Base URL of the apex API, e.g. `http://127.0.0.1:9400`. */
  baseUrl: string;
  /** Per-request timeout, ms. Default 35000 (withdraw waits on broadcast). */
  timeoutMs?: number;
  /** Inject a fetch implementation (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 35_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** Liveness probe: does the apex API answer `GET /api/nodes`? */
  async ping(): Promise<boolean> {
    try {
      await this.request('GET', '/api/nodes');
      return true;
    } catch (err) {
      if (err instanceof ApexUnreachableError) return false;
      // A reachable apex that errored still counts as "up".
      return err instanceof ApiError;
    }
  }

  // ── Telemetry / read ──────────────────────────────────────────────────────
  /** yaml-driven node list (`{ nodes: [...] }`); no exported type → unknown. */
  listNodes(): Promise<unknown> {
    return this.request('GET', '/api/nodes');
  }
  nodeRuntime(): Promise<NodeInfo[]> {
    return this.request<NodeInfo[]>('GET', '/nodes');
  }
  earnings(): Promise<AggregatedEarnings> {
    return this.request<AggregatedEarnings>('GET', '/api/earnings');
  }
  balances(): Promise<WalletBalancesPayload> {
    return this.request<WalletBalancesPayload>('GET', '/wallet/balances');
  }
  chains(): Promise<unknown> {
    return this.request('GET', '/api/chains');
  }
  transport(): Promise<TransportStatusPayload> {
    return this.request<TransportStatusPayload>('GET', '/api/transport');
  }
  network(): Promise<unknown> {
    return this.request('GET', '/api/network');
  }

  // ── Mutate (money / topology) ─────────────────────────────────────────────
  addNode(body: {
    type: 'town' | 'mill' | 'dvm';
    // mill: Nostr relay URLs (required for mill unless set in config/env).
    relays?: string[];
    // dvm: Arweave Turbo credential (JWK string) for larger/paid uploads.
    turboToken?: string;
    // town: settlement chain + token advertised in kind:10032.
    settlementChainId?: string;
    assetCode?: string;
  }): Promise<unknown> {
    return this.request('POST', '/api/nodes', body);
  }
  removeNode(id: string): Promise<unknown> {
    return this.request('DELETE', `/api/nodes/${encodeURIComponent(id)}`);
  }
  setNodeConfig(type: string, body: unknown): Promise<unknown> {
    return this.request(
      'PATCH',
      `/nodes/${encodeURIComponent(type)}/config`,
      body
    );
  }
  withdraw(body: WithdrawRequest): Promise<WithdrawResponse> {
    return this.request<WithdrawResponse>('POST', '/wallet/withdraw', body);
  }
  setTransport(body: TransportPatchRequest): Promise<unknown> {
    return this.request('PATCH', '/api/transport', body);
  }
  setNetwork(body: unknown): Promise<unknown> {
    return this.request('PATCH', '/api/network', body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new ApexUnreachableError(this.baseUrl, err);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      // The control API surfaces two error shapes: the generic
      // `{ error, retryable, detail }` and the node-lifecycle
      // `{ step, err }` (e.g. `{"step":"preflight","err":"MILL_RELAYS is
      // not set..."}`). Read both so the operator agent sees WHY a
      // lifecycle call failed instead of a bare `HTTP 400`.
      const e = (json ?? {}) as {
        error?: string;
        retryable?: boolean;
        detail?: string;
        step?: string;
        err?: string;
      };
      // Lifecycle `err` takes precedence, then the generic `error`.
      const reason = e.err ?? e.error;
      const stepPrefix = e.step ? `[${e.step}] ` : '';
      const message = reason
        ? `${stepPrefix}${reason}`
        : `${stepPrefix}HTTP ${res.status}`.trim();
      // Keep `detail` populated: prefer the explicit detail, else fall back
      // to the lifecycle `err`/`step` so it is never silently dropped.
      const detail = e.detail ?? (e.err ? e.err : undefined);
      throw new ApiError(
        message,
        res.status,
        e.retryable ?? res.status === 503,
        detail
      );
    }
    return json as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
