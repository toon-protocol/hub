/**
 * Townhouse Config Propagation Integration Test (Story 21.16, AC-4)
 *
 * Coverage map (AC-14):
 *   T-082  — fee change via PATCH /nodes/town/config persists to disk
 *   X-003  — config-change chain: SPA → API PATCH → config.yaml → connector restart
 *   R-012  — connector restarts cleanly after config update (StartedAt advances)
 *
 * End-to-end scenario:
 *   1. Bring up a Town-only stack (faster than all-nodes for this specific test).
 *   2. Record the connector container's StartedAt timestamp.
 *   3. PATCH /nodes/town/config with feePerEvent: 5000.
 *   4. Poll docker inspect townhouse-connector --format '{{.State.StartedAt}}'
 *      until the timestamp advances (proves orchestrator.regenerateConnectorConfig ran).
 *   5. Read config.yaml; assert feePerEvent: 5000 is persisted.
 *
 * Implementation note (deviates from story AC-4 as written):
 *   The story suggested checking the connector container's Env block for the fee.
 *   In practice, ConnectorConfigGenerator.toEnvArray() only serializes:
 *     CONNECTOR_ADMIN_PORT, CONNECTOR_ILP_ADDRESS, CONNECTOR_PEERS, TRANSPORT_MODE
 *   The fee (FEE_PER_EVENT) lives in the TOWN node container's Env block and is
 *   NOT updated when regenerateConnectorConfig runs (the town node does not restart
 *   on fee-only changes in the current implementation). The canonical source of
 *   truth for fee changes is config.yaml — this test asserts that instead.
 *   The connector's StartedAt timestamp advance is still the polling signal that
 *   proves the PATCH was processed end-to-end.
 *   See Dev Agent Record for the full explanation.
 *
 * Skip guards: same as townhouse-cli-lifecycle.test.ts (AC-3, AC-5).
 * Per-test timeout: 90 s.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

import {
  isTruthyEnv,
  runCli,
  waitForExit,
  waitForUrl,
  INFRA_SCRIPT,
} from './_test-helpers.js';

// ── Skip gates (AC-5) ─────────────────────────────────────────────────────────
const SKIP_DOCKER = isTruthyEnv(process.env['SKIP_DOCKER']);
const RUN_INTEGRATION = process.env['RUN_DOCKER_INTEGRATION'] === '1';
const shouldRun = RUN_INTEGRATION && !SKIP_DOCKER;

if (!shouldRun) {
  console.warn(
    '\n⚠️  Skipping Townhouse config propagation integration test.\n' +
      '   Set RUN_DOCKER_INTEGRATION=1 and ensure SKIP_DOCKER is unset.\n'
  );
}

/** Run `townhouse-test-infra.sh down` best-effort. */
function infraDown(): void {
  try {
    execSync(`bash "${INFRA_SCRIPT}" down`, {
      stdio: 'inherit',
      timeout: 30_000,
    });
  } catch {
    // missing containers are not errors
  }
}

/** Read the connector container's StartedAt timestamp (ISO string). */
function connectorStartedAt(): string {
  return execSync(
    "docker inspect townhouse-connector --format '{{.State.StartedAt}}'",
    { encoding: 'utf-8', timeout: 10_000 }
  ).trim();
}

/** Poll until connector StartedAt changes from `prior` (max 30 s). */
async function waitForConnectorRestart(
  prior: string,
  {
    maxMs = 30_000,
    intervalMs = 1_000,
  }: { maxMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const current = connectorStartedAt();
      if (current !== prior) return;
    } catch {
      // container still restarting — keep polling
    }
  }
  throw new Error(
    `Connector did not restart within ${maxMs} ms (StartedAt stayed at ${prior})`
  );
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!shouldRun)(
  'Config propagation: PATCH fee → config.yaml → connector restart (T-082, X-003, R-012)',
  () => {
    let tmpDir: string;
    let upProcess: ReturnType<typeof runCli> | undefined;
    const TEST_PASSWORD = 'test-password-config-prop-789';
    const TOWN_API = 'http://127.0.0.1:9400';

    beforeAll(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'townhouse-test-config-'));
      infraDown();

      // init + up with town-only (fastest stack for this test's purpose)
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
        extraArgs: ['--town'],
      });

      // Wait for Fastify API and connector admin to be ready
      await Promise.all([
        waitForUrl(`${TOWN_API}/nodes`, {
          maxMs: 90_000,
          label: 'Townhouse API /nodes',
        }),
        waitForUrl('http://127.0.0.1:9401/health', {
          maxMs: 90_000,
          label: 'connector admin /health',
        }),
      ]);
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

    it('T-082 / X-003 / R-012: PATCH feePerEvent persists to config.yaml + connector restarts', async () => {
      // ── Step 1: record connector restart baseline ─────────────────────────
      const startedAtBefore = connectorStartedAt();

      // ── Step 2: PATCH feePerEvent on the town node ────────────────────────
      // Route is /nodes/:type/config (no /api prefix — Fastify API at 9400)
      const patchRes = await fetch(`${TOWN_API}/nodes/town/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feePerEvent: 5000 }),
      });

      expect(
        patchRes.ok,
        `PATCH /nodes/town/config returned ${patchRes.status}: ${await patchRes.text()}`
      ).toBe(true);

      const patchBody = (await patchRes.json()) as { feePerEvent?: number };
      expect(patchBody.feePerEvent).toBe(5000);

      // ── Step 3: wait for connector to restart ─────────────────────────────
      // The orchestrator calls regenerateConnectorConfig() after fee changes,
      // which stops + removes + recreates the connector container.
      // Polling StartedAt is the canonical race-free signal from outside the subprocess.
      await waitForConnectorRestart(startedAtBefore, {
        maxMs: 30_000,
        intervalMs: 1_000,
      });

      // ── Step 4: assert config.yaml has the new feePerEvent ────────────────
      const configPath = join(tmpDir, 'config.yaml');
      const configContent = readFileSync(configPath, 'utf-8');
      const config = parseYaml(configContent) as {
        nodes?: { town?: { feePerEvent?: number } };
      };

      expect(
        config.nodes?.town?.feePerEvent,
        `Expected config.yaml to persist feePerEvent: 5000, got: ${JSON.stringify(config.nodes?.town)}`
      ).toBe(5000);
    }, 90_000);
  }
);
