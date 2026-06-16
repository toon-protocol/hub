/**
 * HS-profile orchestrator integration test (Story 45.3, AC #13).
 *
 * Boots the real apex stack via the published HS compose template and
 * asserts hostname publication + volume preservation on down().
 *
 * Prerequisites (skip gates enforce this):
 *   RUN_DOCKER_INTEGRATION=1   — opt-in to Docker-required tests
 *   SKIP_DOCKER unset or falsy — sandbox environments set this to skip
 *   dist/image-manifest.json   — produced by `pnpm build` after the publish CI
 *                                 run; download via:
 *                                 gh run download <run-id> --name image-manifest
 *                                   -D packages/townhouse/dist/
 *
 * Typical CI invocation:
 *   RUN_DOCKER_INTEGRATION=1 pnpm --filter @toon-protocol/hub test:integration
 *     -- orchestrator-hs
 *
 * First run pulls connector + townhouse-api images (~2-3 min cold cache).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { DockerOrchestrator } from '../docker/orchestrator.js';
import { materializeComposeTemplate } from '../compose-loader.js';
import { ConnectorAdminClient } from '../connector/admin-client.js';
import { getDefaultConfig } from '../config/defaults.js';
import { isTruthyEnv } from './_test-helpers.js';

// ── Skip gates ──────────────────────────────────────────────────────────────
const SKIP_DOCKER = isTruthyEnv(process.env['SKIP_DOCKER']);
const RUN_INTEGRATION = process.env['RUN_DOCKER_INTEGRATION'] === '1';
const shouldRun = RUN_INTEGRATION && !SKIP_DOCKER;

if (!shouldRun) {
  console.warn(
    '\n⚠️  Skipping HS-profile orchestrator integration test.\n' +
      '   Set RUN_DOCKER_INTEGRATION=1 and ensure SKIP_DOCKER is unset.\n' +
      '   Ensure dist/image-manifest.json is present (run `pnpm build` after\n' +
      '   downloading the manifest from the latest publish CI run).\n'
  );
}

describe.skipIf(!shouldRun)(
  'HS profile orchestrator boots apex-only stack',
  () => {
    let tmpDir: string;
    let composePath: string;
    let orch: DockerOrchestrator;

    const previousWalletPassword = process.env['TOWNHOUSE_WALLET_PASSWORD'];

    beforeAll(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'townhouse-hs-orch-'));
      ({ composePath } = materializeComposeTemplate('hs', {
        townhouseHome: tmpDir,
      }));
      // The HS template uses ${TOWNHOUSE_WALLET_PASSWORD:?} — must be set or
      // docker compose up fails immediately with a substitution error.
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = 'integration-test-pwd';
      const docker = new Docker();
      // Pass a real TownhouseConfig (NOT undefined) — waitForHsHostname reads
      // config.connector.adminPort, so undefined here would TypeError mid-test.
      orch = new DockerOrchestrator(docker, getDefaultConfig(), undefined, {
        profile: 'hs',
        composePath,
      });
      await orch.up([]); // apex-only: connector + townhouse-api
    }, 240_000);

    afterAll(async () => {
      try {
        try {
          await orch.down();
        } catch {
          /* best-effort */
        }
        // Wipe named volumes so subsequent runs get a fresh .anyone address.
        try {
          execSync(`docker compose -f "${composePath}" down -v`, {
            timeout: 30_000,
          });
        } catch {
          /* best-effort */
        }
        rmSync(tmpDir, { recursive: true, force: true });
      } finally {
        // Always restore the wallet-password env var, even if cleanup throws,
        // so vitest worker reuse can't leak the test value into sibling suites.
        if (previousWalletPassword === undefined) {
          delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        } else {
          process.env['TOWNHOUSE_WALLET_PASSWORD'] = previousWalletPassword;
        }
      }
    }, 60_000);

    it('exactly two containers running: connector + townhouse-api', () => {
      const out = execSync(
        'docker ps --filter name=townhouse-hs- --format "{{.Names}}"',
        { encoding: 'utf-8' }
      );
      const names = out.trim().split('\n').filter(Boolean).sort();
      expect(names).toEqual(['townhouse-hs-api', 'townhouse-hs-connector']);
    }, 10_000);

    it('getHsHostname() returns a non-null .anyone address', async () => {
      const client = new ConnectorAdminClient('http://127.0.0.1:9401', 5_000);
      const result = await client.getHsHostname();
      expect(result.hostname).toMatch(/\.anyone$/);
      expect(result.publishedAt).toBeTruthy();
    }, 10_000);

    it('down() stops containers but preserves townhouse-hs-anon volume', async () => {
      await orch.down();
      const containers = execSync(
        'docker ps -a --filter name=townhouse-hs- --format "{{.Names}}"',
        { encoding: 'utf-8' }
      );
      expect(containers.trim()).toBe('');
      const volumes = execSync(
        'docker volume ls --filter name=townhouse-hs-anon --format "{{.Name}}"',
        { encoding: 'utf-8' }
      );
      expect(volumes.trim()).toBe('townhouse-hs-anon');
    }, 60_000);
  }
);
