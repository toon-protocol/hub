/**
 * Tests for buildFastifyApp shared helper (AC-9).
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { buildFastifyApp, LOOPBACK_HOSTS } from './build-app.js';

const _pkg = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};

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
