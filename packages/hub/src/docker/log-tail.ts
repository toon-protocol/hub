/**
 * Docker log tailing helpers (Story D6).
 *
 * Wraps `dockerode`'s `container.logs({ follow: true })` stream into an
 * AsyncIterable<LogEvent> emitting structured JSON events. The raw Docker
 * stream is multiplexed (8-byte framing per chunk: stdout/stderr) when the
 * container has no TTY; we strip the frame header and split on newlines.
 *
 * Each emitted event is shaped to be drop-in JSON for the SSE endpoint:
 *
 *   { ts: ISO8601, service: 'town'|'mill'|'dvm'|'connector',
 *     level: 'info'|'warn'|'error'|'debug', msg: string, raw?: string }
 *
 * The parser is exported separately so the unit tests can exercise the
 * stream-decoding logic in pure form (no dockerode required).
 */
import type Docker from 'dockerode';
import type { Readable } from 'node:stream';
import { CONTAINER_PREFIX } from '../constants.js';

export type LogService = 'town' | 'mill' | 'dvm' | 'connector';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEvent {
  ts: string;
  service: LogService;
  level: LogLevel;
  msg: string;
  raw?: string;
}

/** Possible service identifiers we tail. */
export const LOG_SERVICES: readonly LogService[] = [
  'town',
  'mill',
  'dvm',
  'connector',
] as const;

/**
 * Strip Docker's multiplexed-stream 8-byte frame headers, if present.
 *
 * Docker's `/containers/{id}/logs?follow=1` response is a "raw stream" when
 * the container has a TTY (just bytes) and a "multiplexed stream" when not.
 * In the multiplexed form, every payload chunk is preceded by an 8-byte
 * header: [STREAM_TYPE, 0, 0, 0, SIZE_BE_4]. STREAM_TYPE is 1=stdout, 2=stderr.
 *
 * Heuristic: a buffer is considered framed when the first byte is 1 or 2,
 * the next three bytes are zero, and the declared frame length lands within
 * the buffer. Otherwise we return the bytes as-is (TTY case, partial chunks).
 */
export function stripDockerFrame(chunk: Buffer): Buffer {
  if (chunk.length < 8) return chunk;
  const streamType = chunk[0];
  if (
    (streamType !== 1 && streamType !== 2) ||
    chunk[1] !== 0 ||
    chunk[2] !== 0 ||
    chunk[3] !== 0
  ) {
    return chunk;
  }
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= chunk.length) {
    const st = chunk[offset];
    if (
      (st !== 1 && st !== 2) ||
      chunk[offset + 1] !== 0 ||
      chunk[offset + 2] !== 0 ||
      chunk[offset + 3] !== 0
    ) {
      // Not a frame — return remainder verbatim.
      out.push(chunk.subarray(offset));
      return Buffer.concat(out);
    }
    const size = chunk.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > chunk.length) {
      // Partial frame — consumer will see the un-stripped tail next time.
      out.push(chunk.subarray(start));
      return Buffer.concat(out);
    }
    out.push(chunk.subarray(start, end));
    offset = end;
  }
  return Buffer.concat(out);
}

/**
 * Map a raw log line to a structured LogEvent. The line may be:
 *   - JSON-shaped Pino/Bunyan log (preferred)
 *   - "[level] message"-style text
 *   - free-form text (default level: info)
 *
 * `service` is supplied by the caller (we know which container produced it).
 */
export function parseLogLine(
  line: string,
  service: LogService
): LogEvent | null {
  const trimmed = line.replace(/\r$/, '').trim();
  if (!trimmed) return null;

  // Try JSON first (Pino-style logs from connector / mill / dvm)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const level = pinoLevelToLevel(obj['level']);
      const ts = pickTimestamp(obj['time'] ?? obj['ts'] ?? obj['@timestamp']);
      const msg =
        pickMsg(obj['msg'] ?? obj['message'] ?? obj['text']) ?? trimmed;
      return { ts, service, level, msg, raw: trimmed };
    } catch {
      // fall through to text parsing
    }
  }

  // Bracketed level prefix: "[ERROR] something happened" / "WARN: ..."
  const levelMatch = trimmed.match(
    /^\s*\[?(DEBUG|INFO|WARN|WARNING|ERROR|ERR|FATAL)\]?[:\s]+(.*)$/i
  );
  if (levelMatch && levelMatch[1] !== undefined) {
    const lvl = levelMatch[1].toUpperCase();
    const msg = levelMatch[2] ?? '';
    return {
      ts: new Date().toISOString(),
      service,
      level: textLevelToLevel(lvl),
      msg,
      raw: trimmed,
    };
  }

  return {
    ts: new Date().toISOString(),
    service,
    level: 'info',
    msg: trimmed,
    raw: trimmed,
  };
}

function pinoLevelToLevel(raw: unknown): LogLevel {
  if (typeof raw === 'number') {
    // Pino numeric levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal
    if (raw >= 50) return 'error';
    if (raw >= 40) return 'warn';
    if (raw >= 30) return 'info';
    return 'debug';
  }
  if (typeof raw === 'string') {
    return textLevelToLevel(raw.toUpperCase());
  }
  return 'info';
}

function textLevelToLevel(upper: string): LogLevel {
  switch (upper) {
    case 'DEBUG':
    case 'TRACE':
      return 'debug';
    case 'WARN':
    case 'WARNING':
      return 'warn';
    case 'ERR':
    case 'ERROR':
    case 'FATAL':
    case 'CRITICAL':
      return 'error';
    case 'INFO':
    default:
      return 'info';
  }
}

function pickTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function pickMsg(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Stateful line splitter — accumulates partial chunks across reads and emits
 * complete lines. Used by the live tail to handle TCP frames that don't align
 * with newlines.
 */
export class LineSplitter {
  private buffer = '';

  push(chunk: Buffer): string[] {
    this.buffer += stripDockerFrame(chunk).toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines;
  }

  flush(): string[] {
    if (!this.buffer) return [];
    const out = [this.buffer];
    this.buffer = '';
    return out;
  }
}

/**
 * Map a hub-managed container name to the service tag used in the SSE
 * events. Returns null when the name doesn't match any known prefix.
 *
 * Examples:
 *   hub-town            -> 'town'
 *   hub-mill            -> 'mill'
 *   hub-dvm             -> 'dvm'
 *   hub-connector       -> 'connector'
 *   hub-dev-town-01     -> 'town'   (preset multi-instance)
 *   hub-dev-mill-02     -> 'mill'
 */
export function serviceFromContainerName(name: string): LogService | null {
  const clean = name.replace(/^\//, '');
  if (!clean.startsWith(CONTAINER_PREFIX)) return null;
  const suffix = clean.slice(CONTAINER_PREFIX.length);
  for (const svc of LOG_SERVICES) {
    if (
      suffix === svc ||
      suffix.startsWith(`${svc}-`) ||
      suffix.includes(`-${svc}-`) ||
      suffix.endsWith(`-${svc}`)
    ) {
      return svc;
    }
  }
  return null;
}

export interface TailOptions {
  /** Number of historical lines to fetch on attach. Default: 50. */
  tail?: number;
  /** AbortSignal for graceful cancellation. */
  signal?: AbortSignal;
}

/**
 * Tail one container, yielding structured LogEvents. Resolves silently when
 * the underlying stream ends or the signal aborts.
 */
export async function* tailContainerLogs(
  docker: Docker,
  containerName: string,
  service: LogService,
  opts: TailOptions = {}
): AsyncGenerator<LogEvent> {
  const tail = opts.tail ?? 50;
  const container = docker.getContainer(containerName);

  // dockerode's typings vary by version — `logs({follow:true})` returns a
  // Readable. Fall back to `any` only here, to keep the surface tiny.
  const stream = (await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail,
    timestamps: false,
  })) as unknown as Readable;

  const splitter = new LineSplitter();
  const queue: LogEvent[] = [];
  let waiter: (() => void) | null = null;
  let done = false;
  let err: Error | null = null;

  function wake() {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  }

  stream.on('data', (chunk: Buffer) => {
    for (const line of splitter.push(chunk)) {
      const evt = parseLogLine(line, service);
      if (evt) queue.push(evt);
    }
    wake();
  });
  stream.on('end', () => {
    for (const line of splitter.flush()) {
      const evt = parseLogLine(line, service);
      if (evt) queue.push(evt);
    }
    done = true;
    wake();
  });
  stream.on('error', (e: Error) => {
    err = e;
    done = true;
    wake();
  });

  if (opts.signal) {
    if (opts.signal.aborted) {
      try {
        stream.destroy();
      } catch {
        /* best-effort */
      }
      done = true;
    } else {
      opts.signal.addEventListener(
        'abort',
        () => {
          try {
            stream.destroy();
          } catch {
            /* best-effort */
          }
          done = true;
          wake();
        },
        { once: true }
      );
    }
  }

  while (true) {
    const next = queue.shift();
    if (next !== undefined) {
      yield next;
      continue;
    }
    if (done) break;
    await new Promise<void>((resolve) => {
      waiter = resolve;
    });
  }

  if (err) throw err;
}
