/**
 * Live log-tail SSE route (Story D6).
 *
 *   GET /api/logs/stream
 *
 * Streams structured JSON lines from running TOON containers (town, mill,
 * dvm, connector) as Server-Sent Events. Each event is one JSON object on
 * a single `data:` line.
 *
 * The route owns its dockerode connection so we don't have to plumb the
 * Docker handle through ApiDeps; the orchestrator's `docker` field is
 * private. This keeps the change surface contained to the new files.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Docker from 'dockerode';
import type { ApiDeps } from '../types.js';
import {
  tailContainerLogs,
  serviceFromContainerName,
  type LogEvent,
  type LogService,
} from '../../docker/log-tail.js';

/** Allow the test suite to inject a fake Docker. */
export interface RegisterLogsRoutesOptions {
  docker?: Docker;
  /**
   * Override the tail driver. Defaults to `tailContainerLogs`. Tests use this
   * to feed deterministic events without a real Docker daemon.
   */
  tailFn?: typeof tailContainerLogs;
}

/** Heartbeat cadence — keeps proxies/load-balancers from idling out. */
const HEARTBEAT_INTERVAL_MS = 15_000;

interface RunningContainer {
  name: string;
  service: LogService;
}

/** Discover running hub-managed containers (town/mill/dvm/connector). */
async function listHubContainers(
  docker: Docker
): Promise<RunningContainer[]> {
  const containers = await docker.listContainers({ all: false });
  const out: RunningContainer[] = [];
  for (const c of containers) {
    for (const rawName of c.Names) {
      const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
      const service = serviceFromContainerName(name);
      if (service) {
        out.push({ name, service });
        break;
      }
    }
  }
  return out;
}

export function registerLogsRoutes(
  app: FastifyInstance,
  _deps: ApiDeps,
  opts: RegisterLogsRoutesOptions = {}
): void {
  const docker = opts.docker ?? new Docker();
  const tailFn = opts.tailFn ?? tailContainerLogs;

  app.get('/api/logs/stream', async (request, reply) => {
    await streamLogs(request, reply, docker, tailFn);
  });
}

/**
 * Internal handler — extracted so tests can drive it directly.
 *
 * We bypass Fastify's reply.send and write to the underlying Node response
 * because SSE requires keeping the connection open and flushing each event.
 */
async function streamLogs(
  request: FastifyRequest,
  reply: FastifyReply,
  docker: Docker,
  tailFn: typeof tailContainerLogs
): Promise<void> {
  const raw = reply.raw;
  raw.statusCode = 200;
  raw.setHeader('Content-Type', 'text/event-stream');
  raw.setHeader('Cache-Control', 'no-cache, no-transform');
  raw.setHeader('Connection', 'keep-alive');
  // Defeat buffering on intermediaries (nginx, fly, etc.)
  raw.setHeader('X-Accel-Buffering', 'no');
  raw.flushHeaders?.();

  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    if (raw.writableEnded) return;
    try {
      raw.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      /* best-effort */
    }
  }, HEARTBEAT_INTERVAL_MS);

  function teardown(): void {
    clearInterval(heartbeat);
    controller.abort();
  }

  request.raw.on('close', teardown);
  request.raw.on('error', teardown);

  // Discover running containers up front; if Docker is unreachable we send a
  // single error event and close. This keeps the dashboard demoable even when
  // dockerd is in a weird state.
  let containers: RunningContainer[];
  try {
    containers = await listHubContainers(docker);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeEvent(raw, {
      ts: new Date().toISOString(),
      service: 'connector',
      level: 'error',
      msg: `log-tail: docker unavailable (${msg})`,
    });
    teardown();
    raw.end();
    return;
  }

  if (containers.length === 0) {
    writeEvent(raw, {
      ts: new Date().toISOString(),
      service: 'connector',
      level: 'warn',
      msg: 'log-tail: no hub containers running',
    });
  }

  // Spawn one tail per container; merge into the single SSE stream.
  const tasks = containers.map(async (c) => {
    try {
      for await (const evt of tailFn(docker, c.name, c.service, {
        signal: controller.signal,
        tail: 50,
      })) {
        if (raw.writableEnded) break;
        writeEvent(raw, evt);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      writeEvent(raw, {
        ts: new Date().toISOString(),
        service: c.service,
        level: 'error',
        msg: `log-tail: ${c.name} stream error (${msg})`,
      });
    }
  });

  // Wait for all tails (typically until client disconnects + abort fires).
  await Promise.allSettled(tasks);
  teardown();
  if (!raw.writableEnded) {
    raw.end();
  }
}

function writeEvent(
  raw: { write: (chunk: string) => boolean; writableEnded: boolean },
  evt: LogEvent
): void {
  if (raw.writableEnded) return;
  try {
    raw.write(`data: ${JSON.stringify(evt)}\n\n`);
  } catch {
    /* best-effort */
  }
}

// Exported for tests
export const __test__ = { listHubContainers, streamLogs };
