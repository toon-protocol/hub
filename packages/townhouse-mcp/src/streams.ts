/**
 * Streaming adapters (design §5). MCP tools are request/response; the apex
 * telemetry sources stream. This module *consumes* a stream internally and
 * returns a bounded request/response value — it never holds an MCP tool call
 * open across a long-lived socket.
 *
 *   • `tailLogsViaSse`      — GET /api/logs/stream (SSE), collect a bounded
 *                             batch of `LogEvent`s, then close.
 *   • `metricsSnapshotViaWs` — WS /metrics, return the first non-heartbeat
 *                             metrics frame, then close.
 *
 * Both fail loud with a typed `StreamsUnavailableError` so the caller can fall
 * back to the (reliable) `townhouse` CLI JSON path. The WS factory defaults to
 * the runtime's global `WebSocket` (Node 21+/22); when absent the metrics path
 * is "unavailable" and the caller degrades to the CLI. Both are dependency-free
 * and injectable for unit tests.
 */
import type { MetricsPayload, WsMessage } from '@toon-protocol/townhouse';

/**
 * One structured log line off the SSE stream. Mirrors the apex's internal
 * `LogEvent` (docker/log-tail), which is not part of the townhouse public
 * surface — kept local + structural so we don't couple to an unexported type.
 */
export interface LogEvent {
  ts: string;
  service: string;
  level: string;
  msg: string;
  raw?: string;
}

/** Thrown when a stream can't be opened/consumed; signals "fall back to CLI". */
export class StreamsUnavailableError extends Error {
  constructor(
    readonly url: string,
    readonly causedBy?: unknown
  ) {
    super(`townhouse stream not available at ${url}`);
    this.name = 'StreamsUnavailableError';
  }
}

// ── SSE: live log tail ───────────────────────────────────────────────────────

export interface TailLogsOptions {
  /** Apex API base URL, e.g. `http://127.0.0.1:9400`. */
  baseUrl: string;
  /** Stop after this many matching events. Default 100. */
  maxLines?: number;
  /** Close the stream after this long (ms). Default 3000. */
  timeoutMs?: number;
  /** Only keep events from this service (town | mill | dvm | connector). */
  service?: string;
  /** Only keep events at this level. */
  level?: string;
  /** Injected fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Open the SSE log stream, collect up to `maxLines` matching `LogEvent`s or
 * until `timeoutMs` elapses, then close. `: heartbeat` comment frames are
 * dropped. A live tail is forward-looking: a quiet system yields `[]` — the
 * caller decides whether to fall back to the CLI's recent-history view.
 */
export async function tailLogsViaSse(
  opts: TailLogsOptions
): Promise<LogEvent[]> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/logs/stream`;
  const maxLines = opts.maxLines ?? 100;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
  } catch (err) {
    clearTimeout(timer);
    throw new StreamsUnavailableError(url, err);
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new StreamsUnavailableError(url);
  }

  const events: LogEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (events.length < maxLines) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const evt = parseSseDataBlock(block);
        if (evt && matchesFilter(evt, opts.service, opts.level)) {
          events.push(evt);
          if (events.length >= maxLines) break;
        }
      }
    }
  } catch (err) {
    // The timeout fires by aborting the fetch → AbortError mid-read. That's the
    // normal stop condition: return what we collected. Anything else propagates.
    if (!isAbortError(err)) {
      clearTimeout(timer);
      await cancelQuietly(reader);
      throw err;
    }
  } finally {
    clearTimeout(timer);
    await cancelQuietly(reader);
  }
  return events;
}

/** Parse one SSE event block into a `LogEvent`, or null for comments/garbage. */
function parseSseDataBlock(block: string): LogEvent | null {
  const data = block
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n');
  if (!data) return null; // `: heartbeat` comment frame, or a bare separator.
  try {
    return JSON.parse(data) as LogEvent;
  } catch {
    return null;
  }
}

function matchesFilter(
  evt: LogEvent,
  service?: string,
  level?: string
): boolean {
  return (
    (service === undefined || evt.service === service) &&
    (level === undefined || evt.level === level)
  );
}

// ── WS: metrics snapshot ─────────────────────────────────────────────────────

/** Minimal slice of the WHATWG `WebSocket` API this adapter relies on. */
export interface WsLike {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  close(): void;
}
export type WsFactory = (url: string) => WsLike;

export interface MetricsSnapshotOptions {
  baseUrl: string;
  /** Give up after this long (ms). Default 5000. */
  timeoutMs?: number;
  /** Injected WebSocket factory (tests). Defaults to global `WebSocket`. */
  wsFactory?: WsFactory;
}

/**
 * Open WS /metrics, resolve with the first metrics payload (skipping heartbeats,
 * unwrapping `batch` frames), then close. Rejects with `StreamsUnavailableError`
 * if the socket can't open, errors, or closes before a metrics frame arrives.
 */
export function metricsSnapshotViaWs(
  opts: MetricsSnapshotOptions
): Promise<MetricsPayload> {
  const wsUrl = `${opts.baseUrl
    .replace(/^http/, 'ws')
    .replace(/\/+$/, '')}/metrics`;
  const factory = opts.wsFactory ?? defaultWsFactory;

  return new Promise<MetricsPayload>((resolve, reject) => {
    let settled = false;
    let ws: WsLike;
    try {
      ws = factory(wsUrl);
    } catch (err) {
      reject(new StreamsUnavailableError(wsUrl, err));
      return;
    }

    const timer = setTimeout(() => {
      finish(() => reject(new StreamsUnavailableError(wsUrl, 'timeout')));
    }, opts.timeoutMs ?? 5000);

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      action();
    }

    ws.addEventListener('message', (ev) => {
      const payload = extractMetrics((ev as { data?: unknown }).data);
      if (payload) finish(() => resolve(payload));
    });
    ws.addEventListener('error', (ev) => {
      finish(() => reject(new StreamsUnavailableError(wsUrl, ev)));
    });
    ws.addEventListener('close', () => {
      finish(() => reject(new StreamsUnavailableError(wsUrl, 'closed')));
    });
  });
}

/** Pull a `MetricsPayload` out of a WS frame (direct or batched), else null. */
function extractMetrics(data: unknown): MetricsPayload | null {
  const msg = parseWsFrame(data);
  if (!msg) return null;
  if (msg.type === 'metrics') return msg.payload;
  if (msg.type === 'batch') {
    for (const inner of msg.messages) {
      if (inner.type === 'metrics') return inner.payload;
    }
  }
  return null;
}

function parseWsFrame(data: unknown): WsMessage | null {
  let text: string;
  if (typeof data === 'string') text = data;
  else if (data instanceof Uint8Array) text = new TextDecoder().decode(data);
  else if (typeof data === 'object' && data !== null && 'toString' in data)
    text = String(data);
  else return null;
  try {
    return JSON.parse(text) as WsMessage;
  } catch {
    return null;
  }
}

/** Default factory over the runtime's global `WebSocket` (Node 21+/22, browsers). */
function defaultWsFactory(url: string): WsLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WsLike })
    .WebSocket;
  if (!Ctor) {
    throw new Error(
      'global WebSocket unavailable in this runtime (need Node >=21); ' +
        'metrics will fall back to the townhouse CLI'
    );
  }
  return new Ctor(url);
}

// ── shared ───────────────────────────────────────────────────────────────────

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

async function cancelQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    /* already released */
  }
}
