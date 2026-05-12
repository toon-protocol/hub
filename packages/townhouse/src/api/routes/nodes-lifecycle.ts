/**
 * Node lifecycle routes: POST /api/nodes and DELETE /api/nodes/:id.
 *
 * Implements the 6-step atomic provisioning pipeline (Story 46.2):
 *   1. derive-key   — WalletManager.deriveNodeKey (no state change)
 *   2. pull-image   — DockerOrchestrator.pullImage (no state change)
 *   3. write-yaml   — writeNodesYaml (first state mutation)
 *   4. start-container — DockerOrchestrator.startNodeViaCompose
 *   5. healthcheck  — waitForHealthy (HTTP poll until 200 or 60 s timeout)
 *   6. register-peer — ConnectorAdminClient.registerPeer
 *
 * YAML-FIRST ordering invariant: step 3 (nodes.yaml write) MUST happen
 * BEFORE step 6 (connector /admin/peers registration). The drift window
 * resolves in the safe direction — a yaml entry without a connector peer
 * is re-registered on next `hs up`; the reverse creates a peer the
 * reconciler cannot clean up. Never invert this order.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { bytesToHex } from '@noble/hashes/utils';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../types.js';
import type { NodeType } from '../types.js';
import { readNodesYaml, writeNodesYaml } from '../../state/nodes-yaml.js';
import { readImageManifest } from '../../state/image-manifest.js';
import {
  CONTAINER_PREFIX,
  NODE_BTP_PORT,
  TOWN_HEALTH_PORT,
  MILL_HEALTH_PORT,
  DVM_HEALTH_PORT,
  ACCOUNT_INDEX_TOWN,
  ACCOUNT_INDEX_MILL,
  ACCOUNT_INDEX_DVM,
} from '../../constants.js';
import {
  acquireNodeLifecycleMutex,
  releaseNodeLifecycleMutex,
} from '../config-mutex.js';

const HEALTH_PORT: Record<NodeType, number> = {
  town: TOWN_HEALTH_PORT,
  mill: MILL_HEALTH_PORT,
  dvm: DVM_HEALTH_PORT,
};

const ACCOUNT_INDEX: Record<NodeType, number> = {
  town: ACCOUNT_INDEX_TOWN,
  mill: ACCOUNT_INDEX_MILL,
  dvm: ACCOUNT_INDEX_DVM,
};

/** Default ILP prefix for the apex connector (constant from config-generator). */
const APEX_ILP_ADDRESS = 'g.townhouse';

/**
 * Poll `url` with a per-request timeout until the server returns HTTP 200.
 * Throws if `timeoutMs` elapses without a successful response.
 *
 * Body content is intentionally ignored — only HTTP status matters, so this
 * helper stays decoupled from the three distinct node health payload shapes.
 */
async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const POLL_INTERVAL_MS = 1_000;
  const REQUEST_TIMEOUT_MS = 3_000;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) return;
    } catch {
      // connection refused or abort — keep polling
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Health check timeout: ${url} did not return 200 within ${timeoutMs}ms`
  );
}

/**
 * Build the per-node env vars that compose interpolates at `up -d` time.
 * Callers must start from `process.env` and layer these on top (done inside
 * `startNodeViaCompose`). The returned object is the SECRET OVERLAY ONLY.
 *
 * NEVER log the return value of this function — it contains secret keys.
 */
function buildNodeEnv(
  type: NodeType,
  nostrSecretKeyHex: string,
  evmPrivateKeyHex: string,
  mnemonic: string | null,
  apexEvmAddress: string
): Record<string, string> {
  switch (type) {
    case 'town':
      return {
        TOWN_SECRET_KEY: nostrSecretKeyHex,
        TOWN_SETTLEMENT_PRIVATE_KEY: evmPrivateKeyHex,
        APEX_EVM_ADDRESS: apexEvmAddress,
      };
    case 'mill':
      return {
        MILL_SECRET_KEY: nostrSecretKeyHex,
        MILL_SETTLEMENT_PRIVATE_KEY: evmPrivateKeyHex,
        MILL_MNEMONIC: mnemonic ?? '',
        APEX_EVM_ADDRESS: apexEvmAddress,
      };
    case 'dvm':
      return {
        DVM_SECRET_KEY: nostrSecretKeyHex,
      };
  }
}

export function registerNodeLifecycleRoutes(
  app: FastifyInstance,
  deps: ApiDeps
): void {
  // ── GET /api/nodes ─────────────────────────────────────────────────────────
  // Yaml-driven node list: joins nodes.yaml entries with connector peer state.
  // Always returns 200; connector-down degrades to status:'unknown' (not 500).
  // Note: the legacy GET /nodes route (no /api prefix, docker-status-driven,
  // in nodes.ts) is intentionally separate and powers the SPA docker-state view.

  app.get('/api/nodes', async (request, reply) => {
    const homeDir = dirname(deps.configPath);
    const nodesYamlPath = join(homeDir, 'nodes.yaml');

    let yaml: Awaited<ReturnType<typeof readNodesYaml>>;
    try {
      yaml = await readNodesYaml(nodesYamlPath);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      request.log.error(
        { event: 'get_nodes_yaml_error', err: errMsg },
        'Failed to read nodes.yaml'
      );
      return reply.status(500).send({ error: 'yaml_read_failed', err: errMsg });
    }

    type PeerStatus = Awaited<
      ReturnType<typeof deps.connectorAdmin.getPeers>
    >[number];
    let peers: PeerStatus[] = [];
    let connectorUnreachable = false;
    try {
      peers = await deps.connectorAdmin.getPeers();
    } catch (err: unknown) {
      connectorUnreachable = true;
      request.log.warn(
        { event: 'get_nodes_connector_warn', err: String(err) },
        'connector unreachable during GET /api/nodes — returning status:unknown'
      );
    }

    const nodes = yaml.entries.map((entry) => {
      let status: 'connected' | 'disconnected' | 'unknown';
      if (connectorUnreachable) {
        status = 'unknown';
      } else {
        const peer = peers.find((p) => p.id === entry.peerId);
        status = peer?.connected ? 'connected' : 'disconnected';
      }
      return {
        id: entry.id,
        type: entry.type,
        peerId: entry.peerId,
        ilpAddress: entry.ilpAddress,
        status,
        enabledAt: entry.enabledAt,
        lastSeenAt: entry.lastSeenAt,
      };
    });

    return reply.status(200).send({ nodes });
  });

  // ── POST /api/nodes ────────────────────────────────────────────────────────

  app.post<{ Body: { type: NodeType } }>(
    '/api/nodes',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['town', 'mill', 'dvm'] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!acquireNodeLifecycleMutex()) {
        return reply.status(409).send({ error: 'node_lifecycle_in_flight' });
      }

      try {
        const { type } = request.body;
        const homeDir = dirname(deps.configPath);
        const nodesYamlPath = join(homeDir, 'nodes.yaml');
        const imageManifestPath = join(homeDir, 'image-manifest.json');
        const millConfigPath = join(homeDir, 'mill.config.json');

        // Pre-check: single instance per type (v1 constraint)
        const yaml = await readNodesYaml(nodesYamlPath);
        const existing = yaml.entries.find((e) => e.type === type);
        if (existing) {
          return reply.status(409).send({
            error: 'node_type_in_use',
            type,
            existingId: existing.id,
          });
        }

        const derivationIndex = ACCOUNT_INDEX[type];
        const id = type; // v1: id === type
        const peerId = type; // v1: peerId === id
        const ilpAddress = `${APEX_ILP_ADDRESS}.${type}`;
        const containerName = `${CONTAINER_PREFIX}hs-${type}`;
        const healthPort = HEALTH_PORT[type];
        const healthCheckUrl = `http://${containerName}:${healthPort}/health`;
        const btpUrl = `ws://${CONTAINER_PREFIX}hs-${type}:${NODE_BTP_PORT}`;

        // ── Step 1: derive-key ─────────────────────────────────────────────
        request.log.info(
          { event: 'node_lifecycle_step', step: 'derive-key', type, peerId },
          'Step 1: deriving node key'
        );
        let keys: Awaited<ReturnType<typeof deps.wallet.deriveNodeKey>>;
        try {
          keys = await deps.wallet.deriveNodeKey(type, derivationIndex);
        } catch (err: unknown) {
          const errMsg = sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err)
          );
          request.log.error(
            {
              event: 'node_lifecycle_failure',
              step: 'derive-key',
              err: errMsg,
            },
            'Step 1 failed: derive-key'
          );
          return reply.status(500).send({ step: 'derive-key', err: errMsg });
        }

        const nostrSecretKeyHex = bytesToHex(keys.nostrSecretKey);
        const evmPrivateKeyHex = bytesToHex(keys.evmPrivateKey);

        // Capture the mnemonic once at end of step 1. Step 1 succeeded, so the
        // wallet is unlocked; if `getMnemonic()` returns null now, the wallet
        // was locked between step 1's return and here (concurrent lock-route).
        // Fail-fast as a derive-key error rather than silently degrading later
        // env construction with empty-string secrets (P4).
        const mnemonicSnapshot = deps.wallet.getMnemonic();
        if (mnemonicSnapshot === null) {
          const errMsg =
            'Wallet locked between step 1 and step 4 — refusing to start container without mnemonic';
          request.log.error(
            {
              event: 'node_lifecycle_failure',
              step: 'derive-key',
              err: errMsg,
            },
            'Step 1 post-condition failed: mnemonic gone after derive'
          );
          return reply.status(500).send({ step: 'derive-key', err: errMsg });
        }
        // apex EVM address from the town node key (account 0 = primary wallet).
        const apexEvmAddress = deps.wallet.getNodeKeys('town').evmAddress;

        // ── Step 2: pull-image ─────────────────────────────────────────────
        request.log.info(
          { event: 'node_lifecycle_step', step: 'pull-image', type, peerId },
          'Step 2: pulling image'
        );
        try {
          const manifest = await readImageManifest(imageManifestPath);
          const entry = manifest.images[type];
          const imageRef = `${entry.name}@${entry.digest}`;
          await deps.orchestrator.pullImage(imageRef);
        } catch (err: unknown) {
          const errMsg = sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err)
          );
          request.log.error(
            {
              event: 'node_lifecycle_failure',
              step: 'pull-image',
              err: errMsg,
            },
            'Step 2 failed: pull-image'
          );
          return reply.status(502).send({ step: 'pull-image', err: errMsg });
        }

        // ── Step 3: write-yaml (BEFORE connector registration — invariant) ──
        request.log.info(
          { event: 'node_lifecycle_step', step: 'write-yaml', type, peerId },
          'Step 3: writing nodes.yaml entry'
        );
        const enabledAt = new Date().toISOString();
        const newEntry = {
          id,
          type,
          peerId,
          ilpAddress,
          derivationIndex,
          enabledAt,
          lastSeenAt: null,
        };
        try {
          await writeNodesYaml(nodesYamlPath, {
            entries: [...yaml.entries, newEntry],
          });
        } catch (err: unknown) {
          const errMsg = sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err)
          );
          request.log.error(
            {
              event: 'node_lifecycle_failure',
              step: 'write-yaml',
              err: errMsg,
            },
            'Step 3 failed: write-yaml'
          );
          return reply.status(500).send({ step: 'write-yaml', err: errMsg });
        }

        // ── Step 3b: mill — write mill.config.json (same rollback bucket as step 3) ──
        let millConfigWritten = false;
        if (type === 'mill') {
          try {
            const defaultMillConfig = JSON.stringify(
              { swapPairs: [], chains: ['evm'], channels: {} },
              null,
              2
            );
            await fs.mkdir(dirname(millConfigPath), {
              recursive: true,
              mode: 0o700,
            });
            // mkdir mode is a no-op on existing dirs — chmod explicitly so the
            // parent is 0o700 even if it pre-existed (P3).
            await fs.chmod(dirname(millConfigPath), 0o700);
            await fs.writeFile(millConfigPath, defaultMillConfig, {
              encoding: 'utf-8',
              mode: 0o600,
            });
            millConfigWritten = true;
          } catch (err: unknown) {
            const errMsg = sanitizeErrorMessage(
              err instanceof Error ? err.message : String(err)
            );
            request.log.error(
              {
                event: 'node_lifecycle_failure',
                step: 'write-yaml',
                err: errMsg,
              },
              'Step 3b failed: write mill.config.json'
            );
            // Rollback: remove the yaml entry we just added
            const rollbackError = await safeRollbackYaml(
              nodesYamlPath,
              peerId,
              request
            );
            return reply
              .status(500)
              .send({ step: 'write-yaml', err: errMsg, rollbackError });
          }
        }

        // ── Step 4: start-container ────────────────────────────────────────
        request.log.info(
          {
            event: 'node_lifecycle_step',
            step: 'start-container',
            type,
            peerId,
          },
          'Step 4: starting container via compose'
        );
        const nodeEnv = buildNodeEnv(
          type,
          nostrSecretKeyHex,
          evmPrivateKeyHex,
          mnemonicSnapshot,
          apexEvmAddress
        );
        try {
          await deps.orchestrator.startNodeViaCompose(type, nodeEnv);
        } catch (err: unknown) {
          const errMsg = sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err)
          );
          request.log.error(
            {
              event: 'node_lifecycle_failure',
              step: 'start-container',
              err: errMsg,
            },
            'Step 4 failed: start-container'
          );
          // Rollback: remove yaml entry (+ mill config)
          const rollbackError = await safeRollbackYaml(
            nodesYamlPath,
            peerId,
            request
          );
          let rollbackMillError: string | undefined;
          if (millConfigWritten) {
            rollbackMillError = await safeRollbackMillConfig(
              millConfigPath,
              request
            );
          }
          const combinedRollbackError = combineRollbackErrors(
            rollbackError,
            rollbackMillError
          );
          return reply.status(502).send({
            step: 'start-container',
            err: errMsg,
            rollbackError: combinedRollbackError,
          });
        }

        // ── Step 5: healthcheck ────────────────────────────────────────────
        request.log.info(
          {
            event: 'node_lifecycle_step',
            step: 'healthcheck',
            type,
            peerId,
            healthCheckUrl,
          },
          'Step 5: waiting for container to become healthy'
        );
        try {
          await waitForHealthy(healthCheckUrl, 60_000);
        } catch (err: unknown) {
          const errMsg = sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err)
          );
          request.log.error(
            {
              event: 'node_lifecycle_failure',
              step: 'healthcheck',
              err: errMsg,
            },
            'Step 5 failed: healthcheck'
          );
          // Rollback: remove yaml entry + stop container + mill config
          const rollbackYamlError = await safeRollbackYaml(
            nodesYamlPath,
            peerId,
            request
          );
          const rollbackStopError = await safeRollbackStop(
            type,
            deps.orchestrator,
            request
          );
          let rollbackMillError: string | undefined;
          if (millConfigWritten) {
            rollbackMillError = await safeRollbackMillConfig(
              millConfigPath,
              request
            );
          }
          const combinedRollbackError = combineRollbackErrors(
            rollbackYamlError,
            rollbackStopError,
            rollbackMillError
          );
          return reply.status(502).send({
            step: 'healthcheck',
            err: errMsg,
            rollbackError: combinedRollbackError,
          });
        }

        // ── Step 6: register-peer ──────────────────────────────────────────
        request.log.info(
          {
            event: 'node_lifecycle_step',
            step: 'register-peer',
            type,
            peerId,
            ilpAddress,
          },
          'Step 6: registering peer with connector'
        );
        try {
          await deps.connectorAdmin.registerPeer({
            id: peerId,
            url: btpUrl,
            authToken: '',
            routes: [{ prefix: ilpAddress, priority: 0 }],
            // Force direct (non-SOCKS5) BTP dial for this Docker-sibling
            // peer. The apex connector runs with `transport.type: socks5`
            // so the .anyone HS can publish; without this override, every
            // peer dial gets routed through the anon proxy and fails with
            // `HostUnreachable` on Docker-internal hostnames. Requires
            // connector >= 3.6.2 (toon-protocol/connector#70). Discovered
            // by Story 46.4 live gate run (Finding Q, 2026-05-12).
            transport: 'direct',
          });
        } catch (err: unknown) {
          const errMsg = sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err)
          );
          request.log.error(
            {
              event: 'node_lifecycle_failure',
              step: 'register-peer',
              err: errMsg,
            },
            'Step 6 failed: register-peer'
          );
          // Rollback: remove yaml entry + stop container + mill config
          const rollbackYamlError = await safeRollbackYaml(
            nodesYamlPath,
            peerId,
            request
          );
          const rollbackStopError = await safeRollbackStop(
            type,
            deps.orchestrator,
            request
          );
          let rollbackMillError: string | undefined;
          if (millConfigWritten) {
            rollbackMillError = await safeRollbackMillConfig(
              millConfigPath,
              request
            );
          }
          const combinedRollbackError = combineRollbackErrors(
            rollbackYamlError,
            rollbackStopError,
            rollbackMillError
          );
          return reply.status(502).send({
            step: 'register-peer',
            err: errMsg,
            rollbackError: combinedRollbackError,
          });
        }

        request.log.info(
          { event: 'node_lifecycle_success', type, peerId, ilpAddress },
          'Node provisioned successfully'
        );

        return reply.status(201).send({
          id,
          type,
          peerId,
          ilpAddress,
          hsRoute: ilpAddress,
          healthCheckUrl,
        });
      } finally {
        releaseNodeLifecycleMutex();
      }
    }
  );

  // ── DELETE /api/nodes/:id ──────────────────────────────────────────────────

  app.delete<{ Params: { id: string } }>(
    '/api/nodes/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: '^[a-z][a-z0-9-]*$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!acquireNodeLifecycleMutex()) {
        return reply.status(409).send({ error: 'node_lifecycle_in_flight' });
      }

      try {
        const { id } = request.params;
        const homeDir = dirname(deps.configPath);
        const nodesYamlPath = join(homeDir, 'nodes.yaml');
        const millConfigPath = join(homeDir, 'mill.config.json');

        const yaml = await readNodesYaml(nodesYamlPath);
        const entry = yaml.entries.find((e) => e.id === id);
        if (!entry) {
          return reply.status(404).send({ error: 'unknown_node', id });
        }

        // Reverse pipeline — each step is idempotent

        // Step 1: deregister from connector FIRST (stop routing before stopping container)
        request.log.info(
          {
            event: 'node_lifecycle_step',
            step: 'deregister-peer',
            type: entry.type,
            peerId: entry.peerId,
          },
          'DELETE step 1: deregistering peer from connector'
        );
        try {
          await deps.connectorAdmin.removePeer(entry.peerId);
        } catch (err: unknown) {
          const errMsg = sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err)
          );
          request.log.error(
            {
              event: 'node_lifecycle_failure',
              step: 'deregister-peer',
              err: errMsg,
            },
            'DELETE step 1 failed: deregister-peer'
          );
          return reply
            .status(502)
            .send({ step: 'deregister-peer', err: errMsg });
        }

        // Step 2: stop + remove container (idempotent — not running = no-op)
        request.log.info(
          {
            event: 'node_lifecycle_step',
            step: 'stop-container',
            type: entry.type,
          },
          'DELETE step 2: stopping container'
        );
        try {
          await deps.orchestrator.stopNodeViaCompose(entry.type);
        } catch (err: unknown) {
          const errMsg = sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err)
          );
          request.log.error(
            {
              event: 'node_lifecycle_failure',
              step: 'stop-container',
              err: errMsg,
            },
            'DELETE step 2 failed: stop-container'
          );
          return reply
            .status(502)
            .send({ step: 'stop-container', err: errMsg });
        }

        // Step 3: remove yaml entry (idempotent — if entry not present, writes same array)
        request.log.info(
          {
            event: 'node_lifecycle_step',
            step: 'remove-yaml',
            type: entry.type,
          },
          'DELETE step 3: removing nodes.yaml entry'
        );
        try {
          await writeNodesYaml(nodesYamlPath, {
            entries: yaml.entries.filter((e) => e.id !== id),
          });
        } catch (err: unknown) {
          const errMsg = sanitizeErrorMessage(
            err instanceof Error ? err.message : String(err)
          );
          request.log.error(
            {
              event: 'node_lifecycle_failure',
              step: 'remove-yaml',
              err: errMsg,
            },
            'DELETE step 3 failed: remove-yaml'
          );
          // P1: yaml write failure is disk-class (500), not docker/connector (502).
          return reply.status(500).send({ step: 'remove-yaml', err: errMsg });
        }

        // Step 3b: mill only — remove mill.config.json (force: true = idempotent)
        if (entry.type === 'mill') {
          await fs.rm(millConfigPath, { force: true });
        }

        request.log.info(
          { event: 'node_lifecycle_deleted', id, type: entry.type },
          'Node deprovisioned successfully'
        );

        return reply.status(200).send({ id, type: entry.type });
      } finally {
        releaseNodeLifecycleMutex();
      }
    }
  );
}

// ── Rollback helpers ───────────────────────────────────────────────────────
// Each helper is "safe" — rollback failures are logged AND returned as a
// string so the route can surface them in the response body's `rollbackError`
// field (P6). The original step's HTTP response is still returned regardless —
// the rollback error is auxiliary, not a second error class. Returns undefined
// on rollback success.

type RollbackRequest = Pick<FastifyRequest, 'log'>;

/**
 * Remove the entry we just added from nodes.yaml.
 *
 * P13: re-reads the file inside the helper and filters out only `addedPeerId`
 * (instead of restoring a pre-pipeline snapshot). This is robust to external
 * edits during the up-to-60s healthcheck window — anything an operator or
 * another writer added stays intact, while our entry is removed.
 *
 * Idempotent: entry already absent is a no-op write of the same array.
 */
async function safeRollbackYaml(
  nodesYamlPath: string,
  addedPeerId: string,
  request: RollbackRequest
): Promise<string | undefined> {
  try {
    const current = await readNodesYaml(nodesYamlPath);
    const filtered = current.entries.filter((e) => e.peerId !== addedPeerId);
    await writeNodesYaml(nodesYamlPath, { entries: filtered });
    return undefined;
  } catch (err: unknown) {
    const errMsg = sanitizeErrorMessage(
      err instanceof Error ? err.message : String(err)
    );
    request.log.error(
      {
        event: 'node_lifecycle_rollback_failure',
        step: 'write-yaml',
        err: errMsg,
      },
      'Rollback: failed to remove yaml entry — operator may need to hand-edit nodes.yaml'
    );
    return `write-yaml: ${errMsg}`;
  }
}

async function safeRollbackMillConfig(
  millConfigPath: string,
  request: RollbackRequest
): Promise<string | undefined> {
  try {
    await fs.rm(millConfigPath, { force: true });
    return undefined;
  } catch (err: unknown) {
    const errMsg = sanitizeErrorMessage(
      err instanceof Error ? err.message : String(err)
    );
    request.log.error(
      {
        event: 'node_lifecycle_rollback_failure',
        step: 'remove-mill-config',
        err: errMsg,
      },
      'Rollback: failed to remove mill.config.json'
    );
    return `remove-mill-config: ${errMsg}`;
  }
}

async function safeRollbackStop(
  type: NodeType,
  orchestrator: ApiDeps['orchestrator'],
  request: RollbackRequest
): Promise<string | undefined> {
  try {
    await orchestrator.stopNodeViaCompose(type);
    return undefined;
  } catch (err: unknown) {
    const errMsg = sanitizeErrorMessage(
      err instanceof Error ? err.message : String(err)
    );
    request.log.error(
      {
        event: 'node_lifecycle_rollback_failure',
        step: 'stop-container',
        err: errMsg,
      },
      'Rollback: failed to stop container — operator may need to docker rm by hand'
    );
    return `stop-container: ${errMsg}`;
  }
}

/**
 * Collapse one-or-more rollback-error strings into a single response-body
 * field. Returns undefined when every rollback step succeeded so the field
 * stays absent in the JSON.
 */
function combineRollbackErrors(
  ...errors: (string | undefined)[]
): string | undefined {
  const present = errors.filter((e): e is string => e !== undefined);
  if (present.length === 0) return undefined;
  return present.join('; ');
}

/**
 * Strip secret-name env assignments from an error message before it reaches
 * the HTTP response body (P5). Compose stderr can echo env interpolation in
 * error output; secrets injected via `startNodeViaCompose` would otherwise
 * surface to the API client. Conservative: replace the VALUE not the key, so
 * operators still see WHICH secret was involved.
 */
function sanitizeErrorMessage(msg: string): string {
  // Matches `KEY=value` where KEY is a known-secret name; redacts the value
  // up to the next whitespace, quote, or newline.
  const SECRET_KEYS = [
    'TOWN_SECRET_KEY',
    'MILL_SECRET_KEY',
    'DVM_SECRET_KEY',
    'TOWN_SETTLEMENT_PRIVATE_KEY',
    'MILL_SETTLEMENT_PRIVATE_KEY',
    'DVM_SETTLEMENT_PRIVATE_KEY',
    'MILL_MNEMONIC',
    'TOWNHOUSE_WALLET_PASSWORD',
  ];
  const pattern = new RegExp(`(${SECRET_KEYS.join('|')})=[^\\s"'\\n\\r]+`, 'g');
  return msg.replace(pattern, '$1=[REDACTED]');
}
