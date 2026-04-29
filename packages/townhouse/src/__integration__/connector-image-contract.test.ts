/**
 * Connector Image Contract Smoke Test — Townhouse-Side (Story 21.7.5)
 *
 * Boots the real connector Docker image and verifies the admin HTTP contract
 * via `ConnectorAdminClient` — the same client production code uses. If the
 * client's paths or shape validators ever drift from what the connector
 * actually serves, this test fails first.
 *
 * Coverage (all routed through ConnectorAdminClient):
 *   - getHealth()  → /health on healthCheckPort serves HealthStatus
 *   - getPeers()   → /admin/peers on adminApi.port serves the peer envelope
 *   - getMetrics() → /admin/metrics.json on adminApi.port serves AdminMetricsJsonResponse
 *
 * Runtime
 *   <30s on image-cache hit (image-pull dominated on first run).
 *
 * Skip: any truthy value for SKIP_DOCKER ('1', 'true', 'yes' — case-insensitive).
 *   Useful in sandbox environments without Docker. CI runs without the skip.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type Docker from 'dockerode';

import { DEFAULT_CONNECTOR_IMAGE } from '../constants.js';
import { ConnectorAdminClient } from '../connector/admin-client.js';

// ── Port allocation for this test ─────────────────────────────────────────────
// We bind two internal ports to ephemeral host ports so this test can run
// alongside other integration tests without port conflicts.
//
// Inside the container:
//   - 9401 → healthCheckPort (serves /health with HealthStatus shape)
//   - 9402 → adminApi.port  (serves /admin/peers, /admin/metrics.json, …)

/** Truthy-value parser for SKIP_DOCKER: accepts 1/true/yes (case-insensitive). */
function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

// Skip the entire suite when Docker is unavailable (e.g., sandbox envs).
// CI runs without SKIP_DOCKER set, so the canary runs in CI.
describe.skipIf(isTruthyEnv(process.env['SKIP_DOCKER']))(
  `Connector image contract (${DEFAULT_CONNECTOR_IMAGE})`,
  () => {
    let docker: Docker;
    let container: Docker.Container | undefined;
    let healthPort: number;
    let adminApiPort: number;
    let healthClient: ConnectorAdminClient;
    let adminClient: ConnectorAdminClient;
    let tmpDir: string | undefined;

    beforeAll(async () => {
      const DockerLib = (await import('dockerode')).default;
      docker = new DockerLib();

      // ── Pull image if not already present ──────────────────────────────
      const images = await docker.listImages();
      const alreadyPulled = images.some((img) =>
        (img.RepoTags ?? []).includes(DEFAULT_CONNECTOR_IMAGE)
      );

      if (!alreadyPulled) {
        await new Promise<void>((resolve, reject) => {
          docker.pull(
            DEFAULT_CONNECTOR_IMAGE,
            (err: Error | null, stream: NodeJS.ReadableStream) => {
              if (err) {
                reject(err);
                return;
              }
              docker.modem.followProgress(stream, (fErr: Error | null) => {
                if (fErr) reject(fErr);
                else resolve();
              });
            }
          );
        });
      }

      // ── Write a minimal config.yaml for the connector ──────────────────
      // The connector image requires a config file — env vars are not consumed
      // by the standalone image entrypoint. We use healthCheckPort: 9401 and
      // adminApi.port: 9402 so both servers are reachable on separate ports.
      tmpDir = join(
        tmpdir(),
        `townhouse-canary-${randomBytes(8).toString('hex')}`
      );
      mkdirSync(tmpDir, { recursive: true });

      const configPath = join(tmpDir, 'config.yaml');
      writeFileSync(
        configPath,
        [
          'nodeId: townhouse-canary',
          'btpServerPort: 3000',
          'healthCheckPort: 9401',
          'environment: development',
          'deploymentMode: standalone',
          'logLevel: error',
          'adminApi:',
          '  enabled: true',
          '  port: 9402',
          '  host: 0.0.0.0',
          'peers: []',
          'routes: []',
        ].join('\n')
      );

      // ── Start the container ─────────────────────────────────────────────
      container = await docker.createContainer({
        Image: DEFAULT_CONNECTOR_IMAGE,
        HostConfig: {
          Binds: [`${configPath}:/app/config.yaml:ro`],
          PortBindings: {
            '9401/tcp': [{ HostPort: '' }], // healthCheckPort — auto-assign
            '9402/tcp': [{ HostPort: '' }], // adminApi.port   — auto-assign
          },
          AutoRemove: true,
        },
      });

      await container.start();

      // ── Discover the bound host ports ──────────────────────────────────
      const info = await container.inspect();
      const healthBindings = info.NetworkSettings?.Ports?.['9401/tcp'];
      const adminBindings = info.NetworkSettings?.Ports?.['9402/tcp'];

      const boundHealthPort = healthBindings?.[0]?.HostPort;
      const boundAdminPort = adminBindings?.[0]?.HostPort;

      expect(boundHealthPort).toBeTruthy();
      expect(boundAdminPort).toBeTruthy();

      healthPort = Number(boundHealthPort);
      adminApiPort = Number(boundAdminPort);

      healthClient = new ConnectorAdminClient(
        `http://127.0.0.1:${healthPort}`,
        2000
      );
      adminClient = new ConnectorAdminClient(
        `http://127.0.0.1:${adminApiPort}`,
        2000
      );

      // ── Poll /health until 200 (timeout 20s, throw with diagnostic on expiry) ──
      const deadline = Date.now() + 20_000;
      let lastError: unknown;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          await healthClient.getHealth();
          ready = true;
          break;
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      if (!ready) {
        const msg =
          lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(
          `Connector container failed to become healthy within 20s; last error: ${msg}`
        );
      }
    }, 30_000);

    afterAll(async () => {
      // AutoRemove: true handles container cleanup once stop() succeeds; if
      // the container was created but never started (rare beforeAll failure
      // path), AutoRemove never fires, so fall back to remove({force:true}).
      if (container) {
        try {
          await container.stop();
        } catch {
          // not running — fall through to force-remove below
        }
        try {
          await container.remove({ force: true });
        } catch {
          // already removed by AutoRemove or never created — nothing to do
        }
      }
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 15_000);

    // ── Health endpoint via ConnectorAdminClient ───────────────────────────
    // Validator passing is the contract: status, uptime, peersConnected,
    // totalPeers, timestamp must all be present and well-typed.

    it('getHealth() returns a valid HealthStatus from the connector image', async () => {
      const health = await healthClient.getHealth();
      expect(['healthy', 'unhealthy', 'starting', 'degraded']).toContain(
        health.status
      );
      expect(typeof health.uptime).toBe('number');
      expect(health.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof health.peersConnected).toBe('number');
      expect(typeof health.totalPeers).toBe('number');
      expect(typeof health.timestamp).toBe('string');
    }, 10_000);

    it('getPeers() returns an empty array for a connector started with peers: []', async () => {
      const peers = await adminClient.getPeers();
      expect(Array.isArray(peers)).toBe(true);
      expect(peers).toHaveLength(0);
    }, 10_000);

    it('getMetrics() returns AdminMetricsJsonResponse with aggregate counters', async () => {
      const metrics = await adminClient.getMetrics();
      expect(typeof metrics.uptimeSeconds).toBe('number');
      expect(typeof metrics.aggregate.packetsForwarded).toBe('number');
      expect(typeof metrics.aggregate.packetsRejected).toBe('number');
      expect(typeof metrics.aggregate.bytesSent).toBe('number');
      expect(Array.isArray(metrics.peers)).toBe(true);
      expect(typeof metrics.timestamp).toBe('string');
    }, 10_000);

    // ── Deliberate-failure ratchet (AC-8, opt-in) ─────────────────────────

    describe.runIf(process.env['RUN_CANARY_NEGATIVE'] === '1')(
      'negative canary — verifies canary catches a known-bad image',
      () => {
        it('fails for a non-existent image tag with a registry/manifest error (proves canary catches drift)', async () => {
          const badImage = 'ghcr.io/toon-protocol/connector:0.0.0-broken';
          let thrown = false;
          let errorMsg = '';

          try {
            await new Promise<void>((resolve, reject) => {
              docker.pull(
                badImage,
                (err: Error | null, stream: NodeJS.ReadableStream) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  docker.modem.followProgress(stream, (fErr: Error | null) => {
                    if (fErr) reject(fErr);
                    else resolve();
                  });
                }
              );
            });
          } catch (e) {
            thrown = true;
            errorMsg = e instanceof Error ? e.message : String(e);
          }

          expect(thrown, 'Expected pull of bad image tag to throw').toBe(true);
          // Tighten the assertion so the canary proves it caught the
          // failure mode it claims to catch: a registry/manifest error,
          // not e.g. a generic Docker daemon timeout.
          expect(
            errorMsg,
            `Expected error to indicate registry/manifest/not-found failure, got: '${errorMsg}'`
          ).toMatch(/manifest unknown|not found|denied|no such|404/i);
        }, 30_000);
      }
    );
  }
);
