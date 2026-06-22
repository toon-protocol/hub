/**
 * Hub Dev Stack Smoke Test (Story 21.8.0, AC-6)
 *
 * Verifies the full Hub dev topology is healthy after
 * `./scripts/hub-dev-infra.sh up` completes.
 *
 * Prerequisites:
 *   ./scripts/hub-dev-infra.sh up   # writes .env.hub-dev
 *
 * Skip guards:
 *   SKIP_DOCKER=1   — skips the entire suite (sandbox environments)
 *   Missing .env.hub-dev — skips with a clear "run up first" message
 *
 * Runtime budget: <30 s after stack is already running.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConnectorAdminClient } from '../connector/admin-client.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  return ['1', 'true', 'yes'].includes(v.trim().toLowerCase());
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    result[key] = value;
  }
  return result;
}

// Resolve workspace root relative to this file (packages/hub/src/__integration__)
const WORKSPACE_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ENV_FILE = join(WORKSPACE_ROOT, '.env.hub-dev');

// ── Skip flags ────────────────────────────────────────────────────────────────
// AC-6: skip the suite (do NOT silently pass) when prerequisites are missing.
// Evaluated at module load, before any test runs.
const SKIP_DOCKER = isTruthyEnv(process.env['SKIP_DOCKER']);
const ENV_FILE_MISSING = !existsSync(ENV_FILE);
if (ENV_FILE_MISSING && !SKIP_DOCKER) {
  console.warn(
    '\n⚠️  .env.hub-dev not found — skipping Hub dev stack smoke test.\n' +
      '   Run `./scripts/hub-dev-infra.sh up` first, then re-run this test.\n'
  );
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP_DOCKER || ENV_FILE_MISSING)(
  'Hub dev stack smoke test',
  () => {
    let connectorAdminUrl: string;

    // Child BLS health endpoints (name → URL)
    const childHealthEndpoints: Record<string, string> = {};

    beforeAll(() => {
      const env = parseEnvFile(readFileSync(ENV_FILE, 'utf-8'));

      connectorAdminUrl = env['TOWNHOUSE_CONNECTOR_ADMIN_URL'] ?? '';
      if (!connectorAdminUrl) {
        throw new Error(
          '.env.hub-dev is missing TOWNHOUSE_CONNECTOR_ADMIN_URL — was the file written by a current version of hub-dev-infra.sh?'
        );
      }

      childHealthEndpoints['town-01'] =
        env['TOWNHOUSE_DEV_TOWN_01_HEALTH'] ?? '';
      childHealthEndpoints['town-02'] =
        env['TOWNHOUSE_DEV_TOWN_02_HEALTH'] ?? '';
      childHealthEndpoints['mill-01'] =
        env['TOWNHOUSE_DEV_MILL_01_HEALTH'] ?? '';
      childHealthEndpoints['mill-02'] =
        env['TOWNHOUSE_DEV_MILL_02_HEALTH'] ?? '';
      childHealthEndpoints['dvm-01'] = env['TOWNHOUSE_DEV_DVM_01_HEALTH'] ?? '';
    }, 2_000);

    // AC-6 hard runtime budget: 30 s total. Per-test budgets fit within that:
    // beforeAll 2 s + test1 6 s + test2 8 s + test3 12 s = 28 s.

    // ── Test 1: Connector health ───────────────────────────────────────────────
    it('connector getHealth() returns 200 with valid HealthStatus shape', async () => {
      const client = new ConnectorAdminClient(connectorAdminUrl, 5_000);
      const health = await client.getHealth();

      expect(['healthy', 'unhealthy', 'starting', 'degraded']).toContain(
        health.status
      );
      expect(typeof health.uptime).toBe('number');
      expect(typeof health.peersConnected).toBe('number');
      expect(typeof health.totalPeers).toBe('number');
      expect(typeof health.timestamp).toBe('string');
    }, 6_000);

    // ── Test 2: Connector peers (5 children, all connected) ───────────────────
    it('connector getPeers() returns 5 entries with expected IDs, all connected', async () => {
      const client = new ConnectorAdminClient(connectorAdminUrl, 5_000);
      const peers = await client.getPeers();

      expect(Array.isArray(peers)).toBe(true);
      expect(peers).toHaveLength(5);

      const expectedIds = new Set([
        'town-01',
        'town-02',
        'mill-01',
        'mill-02',
        'dvm-01',
      ]);
      for (const peer of peers) {
        expect(expectedIds.has(peer.id), `Unexpected peer ID: ${peer.id}`).toBe(
          true
        );
        expect(peer.connected, `Expected peer ${peer.id} to be connected`).toBe(
          true
        );
      }
    }, 8_000);

    // ── Test 3: Child node BLS health endpoints ────────────────────────────────
    it('all 5 child nodes return 200 from their BLS health endpoints', async () => {
      const checks = Object.entries(childHealthEndpoints).map(
        async ([name, url]) => {
          if (!url) {
            throw new Error(
              `Health URL for ${name} is missing from .env.hub-dev`
            );
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5_000);
          try {
            const res = await fetch(`${url}/health`, {
              signal: controller.signal,
            });
            expect(
              res.status,
              `${name} health endpoint returned ${res.status}`
            ).toBe(200);
          } finally {
            clearTimeout(timer);
          }
        }
      );

      await Promise.all(checks);
    }, 12_000);
  }
);
