/**
 * Live E2E gate — lazy peer node provisioning (Story 46.4, AC #1).
 *
 * Drives the real `townhouse node add|list|remove` CLI against the real
 * townhouse-api container (started via `townhouse hs up`) and asserts the
 * happy-path 5-step sequence completes end-to-end:
 *
 *   1. `townhouse node add town`  → 201, container running, nodes.yaml written
 *   2. `townhouse node list`      → 1 node, status connected (poll up to 30 s)
 *   3. `townhouse node remove <id>` → 200, container gone, nodes.yaml empty
 *   4. `townhouse node list`      → 0 nodes
 *   5. Re-run `townhouse hs up`   → idempotency probe, hostname unchanged,
 *                                    townhouse-hs-anon volume preserved
 *
 * Prerequisites:
 *   RUN_DOCKER_INTEGRATION=1            — opt-in to Docker-required tests
 *   SKIP_DOCKER unset or falsy          — sandbox environments set this to skip
 *   dist/image-manifest.json present    — downloaded from the latest publish CI run:
 *       gh run download <id> --name image-manifest -D packages/townhouse/dist/
 *   pnpm --filter @toon-protocol/hub build  — dist/cli.js must exist
 *
 * Wall-clock budget: ~8–12 min (cold image pull on first `hs up`, then ~30–60 s
 * per add, ~5–10 s per other step).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isTruthyEnv,
  runCli,
  waitForExit,
  waitForUrl,
} from './_test-helpers.js';
import { readNodesYaml } from '../state/nodes-yaml.js';

// ── Skip gates ──────────────────────────────────────────────────────────────
const SKIP_DOCKER = isTruthyEnv(process.env['SKIP_DOCKER']);
const RUN_INTEGRATION = process.env['RUN_DOCKER_INTEGRATION'] === '1';
const shouldRun = RUN_INTEGRATION && !SKIP_DOCKER;

if (!shouldRun) {
  console.warn(
    '\n⚠️  Skipping node lifecycle E2E gate (Story 46.4).\n' +
      '   Set RUN_DOCKER_INTEGRATION=1 and ensure SKIP_DOCKER is unset.\n' +
      '   Ensure packages/townhouse/dist/image-manifest.json is present.\n' +
      '   Pre-warm image cache: bash scripts/townhouse-test-infra.sh up\n'
  );
}

const TEST_PASSWORD = 'integration-test';
const HS_CONNECTOR_NAME = 'townhouse-hs-connector';
const HS_API_NAME = 'townhouse-hs-api';
const HS_TOWN_NAME = 'townhouse-hs-town';
const HS_ANON_VOLUME = 'townhouse-hs-anon';
// townhouse-api does not expose `/health`; poll `/api/nodes` instead — it's a
// pure read endpoint (no mutex) that returns 200 with `{nodes: []}` as soon
// as the API server is bound. This is the same endpoint test 1 will hit first.
const HS_API_HEALTH_URL = 'http://127.0.0.1:28090/api/nodes';

// ── Container / volume helpers ──────────────────────────────────────────────
// Inlined intentionally (Story 21.16 discipline — keep helpers per-test-file
// to avoid a shared mutation surface). Mirrors townhouse-hs-up.test.ts:54-91.

function dockerPs(): string[] {
  const out = execSync(
    `docker ps --filter name=townhouse-hs- --format "{{.Names}}"`,
    { encoding: 'utf-8' }
  );
  return out.trim().split('\n').filter(Boolean).sort();
}

function volumeExists(name: string): boolean {
  const out = execSync(
    `docker volume ls --filter name=${name} --format "{{.Name}}"`,
    { encoding: 'utf-8' }
  );
  return out.trim().split('\n').filter(Boolean).includes(name);
}

function cleanupContainersAndVolumes(): void {
  try {
    execSync(
      `docker ps -aq --filter name=townhouse-hs- | xargs -r docker rm -f`,
      { stdio: 'pipe' }
    );
  } catch {
    /* best-effort */
  }
  for (const vol of [
    HS_ANON_VOLUME,
    'townhouse-hs-town-data',
    'townhouse-hs-mill-data',
    'townhouse-hs-dvm-data',
  ]) {
    try {
      execSync(`docker volume rm -f ${vol}`, { stdio: 'pipe' });
    } catch {
      /* best-effort */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface NodeListEntry {
  id: string;
  type: string;
  peerId: string;
  ilpAddress: string;
  status: 'connected' | 'disconnected' | 'unknown';
  enabledAt: string;
  lastSeenAt: string | null;
}

describe.skipIf(!shouldRun)(
  'townhouse node lifecycle E2E — real CLI against real Docker (Story 46.4)',
  () => {
    let tmpDir: string;
    let firstHostname: string;
    let addedNodeId: string;

    beforeAll(async () => {
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = TEST_PASSWORD;

      // Defensive: tear down any leftover apex from a prior crashed run.
      cleanupContainersAndVolumes();

      tmpDir = mkdtempSync(join(tmpdir(), 'townhouse-node-e2e-'));

      // 1. townhouse init
      const init = runCli('init', {
        configDir: tmpDir,
        password: TEST_PASSWORD,
        env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
      });
      const initCode = await waitForExit(init.process, 30_000);
      if (initCode !== 0) {
        throw new Error(
          `townhouse init exited ${initCode}. stdout: ${init.stdout.join('')}`
        );
      }

      // 2. townhouse hs up — cold-boot path; exits 0 after "Apex live at ..." is
      //    printed (handleHsUp returns; the API + connector containers keep
      //    running independently of the CLI process).
      const up = runCli('hs', {
        configDir: tmpDir,
        password: TEST_PASSWORD,
        env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
        extraArgs: ['up'],
      });
      const upCode = await waitForExit(up.process, 360_000);
      if (upCode !== 0) {
        throw new Error(
          `townhouse hs up exited ${upCode}. stdout: ${up.stdout.join('')}`
        );
      }

      // 3. Capture initial hostname from host.json (structured artifact —
      //    more reliable than scraping stdout).
      const hostJsonPath = join(tmpDir, 'host.json');
      if (!existsSync(hostJsonPath)) {
        throw new Error(`host.json missing at ${hostJsonPath} after hs up`);
      }
      const hostJson = JSON.parse(readFileSync(hostJsonPath, 'utf-8')) as {
        hostname: string;
      };
      firstHostname = hostJson.hostname;
      expect(firstHostname).toMatch(/\.(anyone|anon)$/);

      // 4. Wait for townhouse-api /api/nodes to become 200 — guards AC #1
      //    step 1 against racing with the API server's boot.
      await waitForUrl(HS_API_HEALTH_URL, {
        maxMs: 30_000,
        label: 'townhouse-api /api/nodes',
      });
    }, 480_000);

    afterAll(async () => {
      // Best-effort `townhouse hs down` to drain via the real CLI path.
      try {
        const down = runCli('hs', {
          configDir: tmpDir,
          env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
          extraArgs: ['down'],
        });
        await waitForExit(down.process, 60_000);
      } catch {
        /* best-effort */
      }
      cleanupContainersAndVolumes();
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
    }, 120_000);

    // ── AC #1 step 1 ────────────────────────────────────────────────────────
    it('node add town provisions a Town node and registers with the connector', async () => {
      const add = runCli('node', {
        configDir: tmpDir,
        env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
        extraArgs: ['add', 'town', '--json'],
      });
      const code = await waitForExit(add.process, 180_000);
      const stdout = add.stdout.join('');
      expect(code, `node add stdout: ${stdout}`).toBe(0);

      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? '';
      const body = JSON.parse(lastLine) as {
        ok: boolean;
        id: string;
        type: string;
        peerId: string;
        ilpAddress: string;
        hsRoute?: string;
        healthCheckUrl?: string;
      };
      expect(body.ok).toBe(true);
      expect(body.type).toBe('town');
      expect(body.id).toBe('town');
      expect(body.peerId).toBe('town');
      expect(body.ilpAddress).toBe('g.townhouse.town');

      // nodes.yaml: exists, mode 0o600, one entry of type 'town'.
      const nodesYamlPath = join(tmpDir, 'nodes.yaml');
      expect(existsSync(nodesYamlPath)).toBe(true);
      const mode = statSync(nodesYamlPath).mode & 0o777;
      expect(mode).toBe(0o600);
      const yaml = await readNodesYaml(nodesYamlPath);
      expect(yaml.entries).toHaveLength(1);
      expect(yaml.entries[0]?.type).toBe('town');
      expect(yaml.entries[0]?.peerId).toBe('town');

      // Container running.
      expect(dockerPs()).toContain(HS_TOWN_NAME);

      addedNodeId = body.id;
    }, 180_000);

    // ── AC #1 step 2 ────────────────────────────────────────────────────────
    it('node list shows the Town node as active', async () => {
      // The connector's peer-connected flag transitions asynchronously after
      // register-peer returns 200 (BTP handshake). Poll up to 30 s for the
      // connected state, mirror townhouse-cli-lifecycle.test.ts:156-165.
      const deadline = Date.now() + 30_000;
      let lastBody: { nodes?: NodeListEntry[] } = {};
      let lastStdout = '';
      while (Date.now() < deadline) {
        const list = runCli('node', {
          configDir: tmpDir,
          env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
          extraArgs: ['list', '--json'],
        });
        const code = await waitForExit(list.process, 10_000);
        lastStdout = list.stdout.join('');
        expect(code, `node list stdout: ${lastStdout}`).toBe(0);
        const lines = lastStdout.trim().split('\n').filter(Boolean);
        const lastLine = lines[lines.length - 1] ?? '';
        lastBody = JSON.parse(lastLine) as { nodes?: NodeListEntry[] };
        if (
          lastBody.nodes?.length === 1 &&
          lastBody.nodes[0]?.status === 'connected'
        ) {
          break;
        }
        await sleep(2_000);
      }

      expect(lastBody.nodes, `final node list: ${lastStdout}`).toHaveLength(1);
      const node = lastBody.nodes?.[0];
      expect(node?.type).toBe('town');
      expect(node?.peerId).toBe('town');
      expect(node?.status).toBe('connected');
    }, 60_000);

    // ── AC #1 step 3 ────────────────────────────────────────────────────────
    it('node remove <id> deregisters and stops the Town node', async () => {
      expect(addedNodeId).toBeTruthy();

      const remove = runCli('node', {
        configDir: tmpDir,
        env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
        extraArgs: ['remove', addedNodeId, '--yes', '--json'],
      });
      const code = await waitForExit(remove.process, 60_000);
      const stdout = remove.stdout.join('');
      expect(code, `node remove stdout: ${stdout}`).toBe(0);

      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? '';
      const body = JSON.parse(lastLine) as {
        ok: boolean;
        id: string;
        type: string;
      };
      expect(body.ok).toBe(true);
      expect(body.id).toBe(addedNodeId);
      expect(body.type).toBe('town');

      // Container gone.
      expect(dockerPs()).not.toContain(HS_TOWN_NAME);

      // nodes.yaml: now empty.
      const yaml = await readNodesYaml(join(tmpDir, 'nodes.yaml'));
      expect(yaml.entries).toEqual([]);
    }, 90_000);

    // ── AC #1 step 4 ────────────────────────────────────────────────────────
    it('node list shows no active nodes after remove', async () => {
      const list = runCli('node', {
        configDir: tmpDir,
        env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
        extraArgs: ['list', '--json'],
      });
      const code = await waitForExit(list.process, 10_000);
      const stdout = list.stdout.join('');
      expect(code, `node list stdout: ${stdout}`).toBe(0);

      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? '';
      const body = JSON.parse(lastLine) as { nodes?: NodeListEntry[] };
      expect(body.nodes).toEqual([]);
    }, 15_000);

    // ── AC #1 step 5 ────────────────────────────────────────────────────────
    it('re-run hs up preserves volume + hostname (apex idempotent)', async () => {
      // Idempotency probe path (cli.ts:878-908) — admin client returns the
      // already-published hostname within ~3 s; no Docker mutation.
      const up = runCli('hs', {
        configDir: tmpDir,
        password: TEST_PASSWORD,
        env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
        extraArgs: ['up'],
      });
      const code = await waitForExit(up.process, 30_000);
      const stdout = up.stdout.join('');
      expect(code, `hs up (re-run) stdout: ${stdout}`).toBe(0);

      // Volume preserved.
      expect(volumeExists(HS_ANON_VOLUME)).toBe(true);

      // host.json hostname unchanged.
      const hostJson = JSON.parse(
        readFileSync(join(tmpDir, 'host.json'), 'utf-8')
      ) as { hostname: string };
      expect(hostJson.hostname).toBe(firstHostname);

      // Apex containers still up — name-based assertion is stable even
      // though IDs would not be (containers are not recreated on the
      // idempotent path).
      const names = dockerPs();
      expect(names).toContain(HS_CONNECTOR_NAME);
      expect(names).toContain(HS_API_NAME);
    }, 30_000);
  }
);
