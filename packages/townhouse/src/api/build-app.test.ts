/**
 * Tests for buildFastifyApp shared helper (AC-9).
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  buildFastifyApp,
  LOOPBACK_HOSTS,
  _resolvePackageVersion,
} from './build-app.js';

const _pkg = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};

describe('_resolvePackageVersion (crash-proof version lookup)', () => {
  it('returns the version when a package.json with one is on the ladder', () => {
    const req = (rel: string) =>
      rel === '../package.json' ? { version: '1.2.3' } : undefined;
    expect(_resolvePackageVersion(req, {})).toBe('1.2.3');
  });

  it('skips a package.json that has no version (e.g. the Docker {"type":"module"} marker)', () => {
    // './package.json' resolves but is the bare ESM marker → must fall through.
    const req = (rel: string) =>
      rel === './package.json' ? { type: 'module' } : undefined;
    expect(_resolvePackageVersion(req, {})).toBe('0.0.0-unknown');
  });

  it('NEVER throws when no package.json resolves — falls back to a sentinel', () => {
    const req = () => {
      throw new Error("Cannot find module '../package.json'");
    };
    // This is the exact townhouse-api Docker crash scenario.
    expect(() => _resolvePackageVersion(req, {})).not.toThrow();
    expect(_resolvePackageVersion(req, {})).toBe('0.0.0-unknown');
  });

  it('honours the TOWNHOUSE_VERSION env override when package.json is unresolvable', () => {
    const req = () => {
      throw new Error('nope');
    };
    expect(_resolvePackageVersion(req, { TOWNHOUSE_VERSION: '9.9.9' })).toBe(
      '9.9.9'
    );
  });
});

describe('buildFastifyApp (AC-9)', () => {
  it('creates a Fastify instance with no errors', async () => {
    const app = await buildFastifyApp({ logger: false });
    expect(app).toBeDefined();
    expect(typeof app.inject).toBe('function');
    await app.close();
  });

  it('rejects non-loopback bind when requireLoopback=true', async () => {
    await expect(
      buildFastifyApp({
        logger: false,
        bindHost: '0.0.0.0',
        requireLoopback: true,
      })
    ).rejects.toThrow(/wizard refuses remote bind/);
  });

  it('LOOPBACK_HOSTS includes 127.0.0.1, ::1, localhost', () => {
    expect(LOOPBACK_HOSTS).toContain('127.0.0.1');
    expect(LOOPBACK_HOSTS).toContain('::1');
    expect(LOOPBACK_HOSTS).toContain('localhost');
  });

  it('accepts loopback bind addresses', async () => {
    const app = await buildFastifyApp({ logger: false, bindHost: '127.0.0.1' });
    expect(app).toBeDefined();
    await app.close();
  });
});

describe('GET /health (Story 48.5 / AC #7)', () => {
  it('returns 200 with JSON content-type', async () => {
    const app = await buildFastifyApp({ logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    await app.close();
  });

  it('response body has status: healthy', async () => {
    const app = await buildFastifyApp({ logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body) as {
      status: string;
      uptime: number;
      startedAt: string;
      version: string;
    };
    expect(body.status).toBe('healthy');
    await app.close();
  });

  it('response body has numeric uptime and parseable startedAt ISO string', async () => {
    const app = await buildFastifyApp({ logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body) as {
      status: string;
      uptime: number;
      startedAt: string;
      version: string;
    };
    expect(typeof body.uptime).toBe('number');
    expect(Number.isFinite(Date.parse(body.startedAt))).toBe(true);
    await app.close();
  });

  it('response body version matches package.json version', async () => {
    const app = await buildFastifyApp({ logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body) as { version: string };
    expect(body.version).toBe(_pkg['version']);
    await app.close();
  });
});
