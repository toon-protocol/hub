/**
 * Townhouse CLI Lifecycle Integration Tests (Story 21.16, AC-3)
 *
 * Coverage map (AC-14):
 *   describe "full lifecycle"  → T-079, X-001 (init+up all nodes; 4 containers + connector health)
 *                                T-080 (connector admin peer list: town, mill, dvm connected)
 *                                T-083, R-004 (SIGTERM cleanup: containers + network removed)
 *   describe "mill-only"       → T-084 (single-node Mill-only operation)
 *   X-002 is satisfied across all blocks: each test gets its own mkdtempSync config dir.
 *
 * Prerequisites (run once per CI session):
 *   bash scripts/townhouse-test-infra.sh up   # warms Docker image cache
 *
 * Skip guards (AC-3, AC-5):
 *   RUN_DOCKER_INTEGRATION !== '1'  — not set in default dev/unit loops
 *   SKIP_DOCKER truthy (1/true/yes) — sandbox environments without Docker
 *
 * Per-test timeout: 120 s. Suite hookTimeout: 120 s (vitest.integration.config.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { ConnectorAdminClient } from '../connector/admin-client.js';
import {
  isTruthyEnv,
  runCli,
  waitForExit,
  waitForUrl,
  INFRA_SCRIPT,
} from './_test-helpers.js';

// ── Skip gates (AC-3, AC-5) ───────────────────────────────────────────────────
const SKIP_DOCKER = isTruthyEnv(process.env['SKIP_DOCKER']);
const RUN_INTEGRATION = process.env['RUN_DOCKER_INTEGRATION'] === '1';
const shouldRun = RUN_INTEGRATION && !SKIP_DOCKER;

if (!shouldRun) {
  console.warn(
    '\n⚠️  Skipping Townhouse CLI lifecycle integration tests.\n' +
      '   Set RUN_DOCKER_INTEGRATION=1 and ensure SKIP_DOCKER is unset.\n' +
      '   Pre-warm the image cache first: bash scripts/townhouse-test-infra.sh up\n'
  );
}

/** Run `townhouse-test-infra.sh down` best-effort; swallows errors. */
function infraDown(): void {
  try {
    execSync(`bash "${INFRA_SCRIPT}" down`, {
      stdio: 'inherit',
      timeout: 30_000,
    });
  } catch {
    // missing containers and networks are not errors
  }
}

/** List running containers whose names start with 'townhouse-'. */
function listTownhouseContainers(): string[] {
  const out = execSync(
    'docker ps --filter name=townhouse- --format "{{.Names}}"',
    { encoding: 'utf-8', timeout: 10_000 }
  );
  return out.trim().split('\n').filter(Boolean);
}

/** Check if the townhouse-net Docker network exists. */
function networkExists(): boolean {
  const out = execSync(
    'docker network ls --filter name=townhouse-net --format "{{.Name}}"',
    { encoding: 'utf-8', timeout: 10_000 }
  );
  return out.trim() === 'townhouse-net';
}

// ── Full lifecycle: init + up (all 3 nodes) ───────────────────────────────────
// Covers T-079, X-001, T-080, T-083, R-004

describe.skipIf(!shouldRun)(
  'Townhouse full lifecycle: init + up (all nodes) + SIGTERM (T-079, T-080, T-083, R-004, X-001)',
  () => {
    let tmpDir: string;
    let upProcess: ReturnType<typeof runCli> | undefined;
    const TEST_PASSWORD = 'test-password-lifecycle-123';

    beforeAll(async () => {
      // X-002: fresh config dir — never reuses ~/.townhouse across test runs
      tmpDir = mkdtempSync(join(tmpdir(), 'townhouse-test-lifecycle-'));

      // Reset any orphan Docker state from prior crashed runs
      infraDown();

      // Run `townhouse init` synchronously (it exits on its own)
      const initResult = runCli('init', {
        configDir: tmpDir,
        password: TEST_PASSWORD,
      });
      const initCode = await waitForExit(initResult.process, 30_000);
      if (initCode !== 0) {
        throw new Error(
          `townhouse init exited with code ${initCode}. stdout: ${initResult.stdout.join('')}`
        );
      }

      // Spawn `townhouse up --town --mill --dvm` (long-running subprocess)
      upProcess = runCli('up', {
        configDir: tmpDir,
        password: TEST_PASSWORD,
        extraArgs: ['--town', '--mill', '--dvm'],
      });

      // Wait for connector admin to become healthy (proxy for "full stack up")
      await waitForUrl('http://127.0.0.1:9401/health', {
        maxMs: 90_000,
        label: 'connector admin /health',
      });
    }, 120_000);

    afterAll(async () => {
      // SIGTERM the subprocess if it is still alive (should have been killed by T-083)
      try {
        upProcess?.process.kill('SIGTERM');
        if (upProcess) await waitForExit(upProcess.process, 15_000);
      } catch {
        // already exited
      }
      // Best-effort Docker cleanup for any leftover state
      infraDown();
      rmSync(tmpDir, { recursive: true, force: true });
    }, 60_000);

    // ── T-079 / X-001 ─────────────────────────────────────────────────────────
    it('T-079 / X-001: 4 containers are running after init + up (all nodes)', () => {
      const containers = listTownhouseContainers();
      const expected = [
        'townhouse-connector',
        'townhouse-town',
        'townhouse-mill',
        'townhouse-dvm',
      ];
      for (const name of expected) {
        expect(
          containers,
          `Expected container ${name} to be running`
        ).toContain(name);
      }
    }, 30_000);

    // ── T-080 ─────────────────────────────────────────────────────────────────
    it('T-080: connector admin getPeers() returns town, mill, dvm — all connected', async () => {
      const client = new ConnectorAdminClient('http://127.0.0.1:9401', 10_000);

      // ILP peers connect asynchronously after their containers start;
      // connector /health=200 does not imply peers are connected yet.
      // Poll until all 3 peers are present and connected (max 30 s).
      let peers = await client.getPeers();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (peers.length === 3 && peers.every((p) => p.connected)) break;
        await new Promise((r) => setTimeout(r, 2_000));
        peers = await client.getPeers();
      }

      expect(Array.isArray(peers)).toBe(true);
      expect(peers).toHaveLength(3);

      const ids = new Set(peers.map((p) => p.id));
      expect(ids.has('town'), 'Expected peer id "town"').toBe(true);
      expect(ids.has('mill'), 'Expected peer id "mill"').toBe(true);
      expect(ids.has('dvm'), 'Expected peer id "dvm"').toBe(true);

      for (const peer of peers) {
        expect(peer.connected, `Expected peer ${peer.id} to be connected`).toBe(
          true
        );
      }
    }, 30_000);

    // ── T-083 / R-004 ─────────────────────────────────────────────────────────
    it('T-083 / R-004: after SIGTERM, all townhouse-* containers + townhouse-net removed', async () => {
      // Send SIGTERM — the CLI's SIGTERM handler (cli.ts:500-519) runs orchestrator.down()
      // which stops containers and removes the network.
      if (!upProcess)
        throw new Error('upProcess was not set — beforeAll failed');
      upProcess.process.kill('SIGTERM');
      await waitForExit(upProcess.process, 30_000);
      upProcess = undefined;

      // Allow orchestrator.down() to complete (it runs inside the subprocess)
      await new Promise((r) => setTimeout(r, 2_000));

      const containers = listTownhouseContainers();
      const townhouseContainers = containers.filter((n) =>
        [
          'townhouse-connector',
          'townhouse-town',
          'townhouse-mill',
          'townhouse-dvm',
        ].includes(n)
      );
      expect(
        townhouseContainers,
        `Expected all townhouse-* containers to be removed after SIGTERM, found: ${JSON.stringify(townhouseContainers)}`
      ).toHaveLength(0);

      expect(
        networkExists(),
        'Expected townhouse-net to be removed after SIGTERM'
      ).toBe(false);
    }, 60_000);
  }
);

// ── Single-node Mill-only operation (T-084) ────────────────────────────────────

describe.skipIf(!shouldRun)('Single-node Mill-only operation (T-084)', () => {
  let tmpDir: string;
  let upProcess: ReturnType<typeof runCli> | undefined;
  const TEST_PASSWORD = 'test-password-mill-only-456';

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'townhouse-test-mill-'));
    infraDown();

    const initResult = runCli('init', {
      configDir: tmpDir,
      password: TEST_PASSWORD,
    });
    const initCode = await waitForExit(initResult.process, 30_000);
    if (initCode !== 0) {
      throw new Error(
        `townhouse init exited with code ${initCode}. stdout: ${initResult.stdout.join('')}`
      );
    }

    upProcess = runCli('up', {
      configDir: tmpDir,
      password: TEST_PASSWORD,
      extraArgs: ['--mill'],
    });

    await waitForUrl('http://127.0.0.1:9401/health', {
      maxMs: 90_000,
      label: 'connector admin /health (T-084 setup)',
    });
  }, 120_000);

  afterAll(async () => {
    try {
      upProcess?.process.kill('SIGTERM');
      if (upProcess) await waitForExit(upProcess.process, 15_000);
    } catch {
      // already exited
    }
    infraDown();
    rmSync(tmpDir, { recursive: true, force: true });
  }, 60_000);

  it('T-084: docker ps shows townhouse-connector + townhouse-mill; NOT town or dvm', () => {
    const containers = listTownhouseContainers();
    expect(containers).toContain('townhouse-connector');
    expect(containers).toContain('townhouse-mill');
    expect(containers).not.toContain('townhouse-town');
    expect(containers).not.toContain('townhouse-dvm');
  }, 30_000);
});
