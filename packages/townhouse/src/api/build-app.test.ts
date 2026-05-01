/**
 * Tests for buildFastifyApp shared helper (AC-9).
 */

import { describe, it, expect } from 'vitest';
import { buildFastifyApp, LOOPBACK_HOSTS } from './build-app.js';

describe('buildFastifyApp (AC-9)', () => {
  it('creates a Fastify instance with no errors', async () => {
    const app = await buildFastifyApp({ logger: false });
    expect(app).toBeDefined();
    expect(typeof app.inject).toBe('function');
    await app.close();
  });

  it('rejects non-loopback bind when requireLoopback=true', async () => {
    await expect(
      buildFastifyApp({ logger: false, bindHost: '0.0.0.0', requireLoopback: true })
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
