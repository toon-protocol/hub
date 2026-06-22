/**
 * Logs SSE route tests (Story D6).
 *
 * Drives the route end-to-end with an injected fake Docker + tailFn so we
 * don't need a real daemon.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerLogsRoutes } from './logs.js';
import type { ApiDeps } from '../types.js';
import type { LogEvent, LogService } from '../../docker/log-tail.js';

// Minimal fake Docker for `listContainers` discovery
function makeFakeDocker(containerNames: string[]): unknown {
  return {
    listContainers: async () =>
      containerNames.map((n) => ({ Names: [`/${n}`] })),
  };
}

// Build a tailFn that yields a fixed list of events for a given service.
function makeTailFn(byService: Record<string, LogEvent[]>) {
  return async function* tailFn(
    _docker: unknown,
    _name: string,
    service: LogService
  ): AsyncGenerator<LogEvent> {
    const events = byService[service] ?? [];
    for (const e of events) yield e;
  } as never;
}

function makeApiDeps(): ApiDeps {
  // Cast — we only need the shape, the route ignores nearly all fields.
  return {} as ApiDeps;
}

async function buildAppWith(
  docker: unknown,
  tailFn: ReturnType<typeof makeTailFn>
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerLogsRoutes(app, makeApiDeps(), {
    docker: docker as never,
    tailFn,
  });
  await app.ready();
  return app;
}

describe('GET /api/logs/stream', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('responds with SSE headers', async () => {
    const docker = makeFakeDocker([]);
    app = await buildAppWith(docker, makeTailFn({}));
    const res = await app.inject({ method: 'GET', url: '/api/logs/stream' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
  });

  it('emits a structured warning when no hub containers are running', async () => {
    const docker = makeFakeDocker([]);
    app = await buildAppWith(docker, makeTailFn({}));
    const res = await app.inject({ method: 'GET', url: '/api/logs/stream' });
    const body = res.body;
    expect(body).toContain('data: ');
    // Find the data: line and parse it
    const dataLine = body.split('\n').find((l) => l.startsWith('data: '))!;
    const parsed = JSON.parse(dataLine.slice('data: '.length)) as LogEvent;
    expect(parsed.level).toBe('warn');
    expect(parsed.msg).toMatch(/no hub containers running/);
  });

  it('streams events from each running container', async () => {
    const docker = makeFakeDocker(['hub-town', 'hub-mill']);
    const events: LogEvent[] = [
      {
        ts: '2026-04-01T00:00:00.000Z',
        service: 'town',
        level: 'info',
        msg: 'relay event accepted',
      },
      {
        ts: '2026-04-01T00:00:01.000Z',
        service: 'mill',
        level: 'error',
        msg: 'swap failed',
      },
    ];
    const tailFn = makeTailFn({
      town: [events[0]],
      mill: [events[1]],
    });
    app = await buildAppWith(docker, tailFn);
    const res = await app.inject({ method: 'GET', url: '/api/logs/stream' });
    expect(res.statusCode).toBe(200);

    const dataLines = res.body
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice('data: '.length)) as LogEvent);

    const services = new Set(dataLines.map((e) => e.service));
    expect(services.has('town')).toBe(true);
    expect(services.has('mill')).toBe(true);
    expect(dataLines.find((e) => e.msg === 'swap failed')?.level).toBe('error');
  });

  it('emits an error event if Docker discovery fails', async () => {
    const brokenDocker = {
      listContainers: async () => {
        throw new Error('docker.sock missing');
      },
    };
    app = await buildAppWith(brokenDocker, makeTailFn({}));
    const res = await app.inject({ method: 'GET', url: '/api/logs/stream' });
    expect(res.statusCode).toBe(200);
    const dataLine = res.body.split('\n').find((l) => l.startsWith('data: '))!;
    const parsed = JSON.parse(dataLine.slice('data: '.length)) as LogEvent;
    expect(parsed.level).toBe('error');
    expect(parsed.msg).toMatch(/docker unavailable/);
  });
});
