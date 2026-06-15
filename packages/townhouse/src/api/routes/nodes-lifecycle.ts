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
import { saveConfig } from '../../config/loader.js';
import {
  assembleNodeEnv,
  resolveMillRelays,
  resolveDvmTurboToken,
  resolvePublicBtpUrl,
} from '../../state/node-env.js';
import {
  resolveTownSettlementAsset,
  UnsupportedSettlementError,
} from '../../config/supported-tokens.js';
import type { ApiDeps } from '../types.js';
import type { NodeType } from '../types.js';
import type {
  TownhouseConfig,
  ChainProviderEntry,
} from '../../config/schema.js';
import { DEFAULT_HS_CHAIN_PROVIDERS } from '../../config/defaults.js';
import { readNodesYaml, writeNodesYaml } from '../../state/nodes-yaml.js';
import {
  readImageManifest,
  isSyntheticDigest,
} from '../../state/image-manifest.js';
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
 * Build the initial mill.config.json object for a freshly provisioned Mill.
 *
 * Mill's parseRawConfig() converts channels[*].cumulativeAmount / nonce and
 * inventory[*] from string → bigint. JSON cannot serialize bigint natively, so
 * these fields MUST be written as strings.
 *
 * The bootstrap channel and zero inventory allow validateConfig() to pass
 * without pre-funding the operator's Mill inventory.
 *
 * NOTE: validateConfig() also requires a non-empty `relayUrls` array, which
 * is NOT included here — it is injected at runtime via the `MILL_RELAYS`
 * environment variable (set in townhouse-hs.yml compose env). The POST handler
 * checks MILL_RELAYS before calling this function, so a missing env var is
 * caught before any file is written.
 */
/**
 * A valid-FORMAT zero/sentinel channelId for `chain` that never matches a real
 * on-chain channel. The format is chain-specific and is validated client-side:
 * `streamSwap`'s `validateChainAddress` rejects a `0x…`-format channelId echoed
 * back for a `solana:*` target (it must base58-decode to 32 bytes), which
 * surfaces as `FULFILL_DECODE_FAILED` on the sender. So Solana uses the all-zero
 * base58 pubkey (`'1' × 32` → 32 zero bytes); EVM uses the 0x 32-byte zero word.
 */
function zeroChannelIdForChain(chain: string): string {
  if (chain.startsWith('solana:')) return '1'.repeat(32);
  return '0x' + '0'.repeat(64);
}

/**
 * The mill's per-packet claim service signs a TARGET-chain settlement claim per
 * swap packet; without a `chainProviders` entry covering `pair.to.chain` the
 * embedded connector rejects every swap with `T00 "Per-packet claim service not
 * configured"`. We thread the operator's configured chains through (the same
 * source the apex connector + child env use), falling back to the dev-Anvil EVM
 * default so a fresh install still validates. `keyId` is stripped — the mill
 * derives its OWN settlement key from `MILL_MNEMONIC`/`SETTLEMENT_PRIVATE_KEY`
 * and must sign claims with it (a baked-in dev keyId would make the recipient's
 * claim settle against the wrong signer). NOTE: cross-chain swaps to Solana
 * additionally require the operator to register a `solana:*` provider (via
 * `townhouse chains add --chain-type solana`) — the network presets carry no
 * Solana program id — and to fund the mill's target-chain inventory.
 */
function buildMillChainProviders(
  config: TownhouseConfig
): ChainProviderEntry[] {
  const source: readonly ChainProviderEntry[] =
    config.chainProviders && config.chainProviders.length > 0
      ? config.chainProviders
      : DEFAULT_HS_CHAIN_PROVIDERS;
  return source.map((provider) => {
    // Drop keyId (secret) — the mill supplies its own settlement key at runtime.
    const { keyId: _keyId, ...rest } = provider as ChainProviderEntry & {
      keyId?: string;
    };
    return rest as ChainProviderEntry;
  });
}

function buildMillSwapPairConfig(config: TownhouseConfig): object {
  // Both absent (undefined) and explicitly empty ([]) fall through to the
  // dev-Anvil sentinel — if a live EVM chain is configured, ensure
  // chainProviders has at least one entry with the correct chainId.
  const fromChain = config.chainProviders?.[0]?.chainId ?? 'evm:base:31337';
  // toChain is fixed at 'solana:devnet' for the v0.1 pilot — TownhouseConfig
  // has no Solana chain-ID field yet. Add one and read it here when mainnet
  // support is needed.
  const toChain = 'solana:devnet';

  return {
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: fromChain },
        to: { assetCode: 'USDC', assetScale: 6, chain: toChain },
        rate: '1.0',
        minAmount: '1000',
        maxAmount: '1000000000',
      },
    ],
    chains: ['evm', 'solana'],
    // Bootstrap: validateConfig() requires a non-empty channels array for
    // each distinct pair.to.chain. The sentinel channelId is valid-FORMAT for
    // the target chain (see zeroChannelIdForChain) and never matches a real
    // on-chain channel.
    channels: {
      [toChain]: [
        {
          channelId: zeroChannelIdForChain(toChain),
          cumulativeAmount: '0',
          nonce: '0',
        },
      ],
    },
    // Zero initial SOL inventory; parsed to 0n by the Mill CLI.
    inventory: {
      [toChain]: '0',
    },
    // Per-packet claim service config — REQUIRED for the mill to accept swaps.
    chainProviders: buildMillChainProviders(config),
  };
}

/**
 * Poll `url` with a per-request timeout until the server returns HTTP 200.
 * Throws if `timeoutMs` elapses without a successful response.
 *
 * Body content is intentionally ignored — only HTTP status matters, so this
 * helper stays decoupled from the three distinct node health payload shapes.
 */
/**
 * Read the published `.anyone` hostname from `<homeDir>/host.json` (written by
 * `townhouse hs up`). Returns undefined if the file is absent or unparseable —
 * the caller falls back to config/direct resolution. Best-effort: never throws.
 */
async function readHostJsonHostname(
  homeDir: string
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(join(homeDir, 'host.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { hostname?: unknown };
    return typeof parsed.hostname === 'string' ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
}

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
        // x-only Nostr pubkey (issue #81). Undefined for legacy yaml entries
        // written before the field existed — omitted from the JSON in that case.
        ...(entry.nostrPubkey !== undefined
          ? { nostrPubkey: entry.nostrPubkey }
          : {}),
      };
    });

    return reply.status(200).send({ nodes });
  });

  // ── POST /api/nodes ────────────────────────────────────────────────────────

  app.post<{
    Body: {
      type: NodeType;
      relays?: string[];
      turboToken?: string;
      settlementChainId?: string;
      assetCode?: string;
    };
  }>(
    '/api/nodes',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['town', 'mill', 'dvm'] },
            // mill: Nostr relay URLs (CLI `--relays`, comma-split into an array).
            relays: {
              type: 'array',
              items: { type: 'string', maxLength: 512 },
              maxItems: 64,
            },
            // dvm: Arweave Turbo credential (CLI `--turbo-token`, a JWK string).
            turboToken: { type: 'string', maxLength: 8192 },
            // town: settlement chain + token (CLI `--settlement-chain` / `--asset`).
            settlementChainId: { type: 'string', maxLength: 128 },
            assetCode: { type: 'string', maxLength: 16 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!acquireNodeLifecycleMutex()) {
        return reply.status(409).send({ error: 'node_lifecycle_in_flight' });
      }

      try {
        const {
          type,
          relays: bodyRelays,
          turboToken: bodyTurboToken,
          settlementChainId: bodySettlementChainId,
          assetCode: bodyAssetCode,
        } = request.body;
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

        // Resolve operator-supplied node inputs (flag > config > env) BEFORE any
        // state mutation, so a validation failure rolls back nothing and the
        // resolved values can be both injected into the container env (step 4)
        // and — for mill relays — persisted to config.yaml (step 6).
        const millRelays =
          type === 'mill' ? resolveMillRelays(bodyRelays, deps.config) : [];
        const dvmTurboToken =
          type === 'dvm'
            ? resolveDvmTurboToken(bodyTurboToken, deps.config)
            : '';

        // Pre-check: mill REQUIRES at least one relay URL — mill's
        // validateConfig() throws INVALID_CONFIG on an empty relayUrls array,
        // producing a silent 60-second healthcheck timeout. Resolved from
        // flag/config/env above so the operator can pass `--relays` at add time
        // (no MILL_RELAYS export before `hs up` needed). Catching it here —
        // before writeNodesYaml (step 3) — means no rollback and an actionable
        // 400 with zero side-effects.
        if (type === 'mill' && millRelays.length === 0) {
          return reply.status(400).send({
            step: 'preflight',
            err: 'No relay URLs for Mill. Pass `--relays wss://relay1,wss://relay2` to `townhouse node add mill`, set nodes.mill.relays in config.yaml, or export MILL_RELAYS before `townhouse hs up`. See packages/townhouse/README.md.',
          });
        }

        // Pre-check: resolve + validate the town's settlement chain/token
        // (flag > config) against the deployment's supported set. Invalid →
        // actionable 400 before any state is written. The resolved selection is
        // written back onto deps.config so assembleNodeEnv derives the asset and
        // the success-path persist captures it.
        if (type === 'town') {
          try {
            const asset = resolveTownSettlementAsset(deps.config, {
              settlementChainId:
                bodySettlementChainId ??
                deps.config.nodes.town.settlementChainId,
              assetCode: bodyAssetCode ?? deps.config.nodes.town.assetCode,
            });
            if (asset) {
              deps.config.nodes.town.settlementChainId = asset.chainId;
              deps.config.nodes.town.assetCode = asset.assetCode;
            }
          } catch (err: unknown) {
            if (err instanceof UnsupportedSettlementError) {
              return reply
                .status(400)
                .send({ step: 'preflight', err: err.message });
            }
            throw err;
          }
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
          if (isSyntheticDigest(entry.digest)) {
            return reply.status(400).send({
              step: 'pull-image',
              err: `Synthetic-digest manifest: image-manifest.json was produced by the connector-publish-smoke workflow for smoke testing only. Fetch a real manifest via 'gh run download' or rerun without --skip-fetch before provisioning nodes.`,
            });
          }
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
          // x-only pubkey derived from the node secret — persisted so
          // `node list --json` can surface it without re-deriving (issue #81).
          nostrPubkey: keys.nostrPubkey,
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
          // millRelays resolved + non-empty guaranteed by the preflight above.
          try {
            const defaultMillConfig = JSON.stringify(
              buildMillSwapPairConfig(deps.config),
              null,
              2
            );
            await fs.mkdir(dirname(millConfigPath), {
              recursive: true,
              mode: 0o711,
            });
            // 0o711 (NOT 0o700): mill.config.json is a *direct file* bind-mount
            // (`${TOWNHOUSE_HOME}/mill.config.json:/config/mill.config.json:ro`)
            // into the mill container, which runs as uid 1001 (`toon`) — a
            // DIFFERENT uid than the host writer / the api+connector (uid 1000).
            // To open() that bind-mounted file the kernel needs search (+x) on
            // every parent dir; a 0o700 TOWNHOUSE_HOME denies +x to uid 1001, so
            // the mill crash-loops on `EACCES /config/mill.config.json`, fails
            // its 60s healthcheck, and the whole `node add mill` rolls back
            // (issue #145). 0o711 grants traverse-only (+x, NOT +r) to group/
            // others: uid 1001 can open the known file path but CANNOT list the
            // directory, so the operator's wallet/config.yaml/nodes.yaml stay
            // private. (town is unaffected — it uses a named volume `/data`, not
            // a bind-mount through TOWNHOUSE_HOME.)
            // mkdir mode is a no-op on existing dirs — chmod explicitly so the
            // parent is traversable even if it pre-existed at 0o700.
            await fs.chmod(dirname(millConfigPath), 0o711);
            // 0o644 (NOT 0o600): this file is bind-mounted read-only into the
            // mill container, which runs as a DIFFERENT uid (the image's `toon`
            // user, uid 1001) than the api that writes it (the operator's host
            // uid). A 0o600 file owned by the writer is unreadable by `toon` →
            // the mill crash-loops on `EACCES /config/mill.config.json` and
            // `node add mill` fails the health check. The mill's secret key is
            // injected via env (MILL_SECRET_KEY/MILL_MNEMONIC), NOT this file,
            // so world-readable swap-pair/chain metadata is acceptable.
            await fs.writeFile(millConfigPath, defaultMillConfig, {
              encoding: 'utf-8',
              mode: 0o644,
            });
            millConfigWritten = true;
          } catch (err: unknown) {
            const errMsg = sanitizeErrorMessage(
              err instanceof Error ? err.message : String(err)
            );
            request.log.error(
              {
                event: 'node_lifecycle_failure',
                step: 'write-mill-config',
                err: errMsg,
              },
              'Step 3b failed: write mill.config.json'
            );
            // Rollback: remove any partial mill.config.json first, then the yaml entry.
            const rollbackMillError = await safeRollbackMillConfig(
              millConfigPath,
              request
            );
            const rollbackYamlError = await safeRollbackYaml(
              nodesYamlPath,
              peerId,
              request
            );
            const rollbackError = combineRollbackErrors(
              rollbackMillError,
              rollbackYamlError
            );
            return reply
              .status(500)
              .send({ step: 'write-mill-config', err: errMsg, rollbackError });
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
        // Assemble the full container env (identity keys + chain env + resolved
        // operator inputs). compose interpolates `${MILL_RELAYS:-}` /
        // `${TURBO_TOKEN:-}` in the child service from this overlay
        // (startNodeViaCompose merges it over process.env), so the values travel
        // with the add request — they no longer depend on the API container's
        // frozen process.env. Same assembler the boot rebinder uses, so a node
        // started here and restarted on `hs up` get identical env.
        // Resolve the apex public BTP URL for the town's kind:10032. The
        // .anyone hostname (HS) is read from host.json, written by `hs up` once
        // the connector publishes — present when the operator adds a town after
        // the apex is live. If absent now, the next `hs up` rebind re-injects it.
        const publicBtpUrl =
          type === 'town'
            ? resolvePublicBtpUrl(
                deps.config,
                await readHostJsonHostname(homeDir)
              )
            : undefined;
        const nodeEnv = assembleNodeEnv({
          type,
          nostrSecretKeyHex,
          nostrPubkey: keys.nostrPubkey,
          evmPrivateKeyHex,
          mnemonic: mnemonicSnapshot,
          apexEvmAddress,
          config: deps.config,
          relays: millRelays,
          turboToken: dvmTurboToken || undefined,
          publicBtpUrl,
        });
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
            // Tag every provisioned node as a CHILD of the apex. The connector's
            // `requiresSettlementClaim()` returns false for children, so the apex
            // forwards client-paid PREPAREs to the node for FREE (parent→child
            // packets carry no per-packet claim — the apex settles in aggregate).
            // Without this the peer defaults to 'peer' and every paid packet
            // forwarded to a town/mill/dvm node is rejected `T00 No payment
            // channel available for peer`. Pairs with the child-side
            // `TOON_PARENT_PEER_ID` in townhouse-hs.yml (which MUST equal the
            // apex connector's nodeId so the child applies the parent relation).
            relation: 'child',
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

        // Persist the resolved mill relays to config.yaml so a later
        // `node remove && node add` (and any future reconciliation) reads them
        // back without re-supplying a flag or shell env var. Non-fatal: the node
        // is already live + registered, so a config-write failure must NOT fail
        // the request — log a warning and return success. The dvm Turbo token is
        // intentionally NOT persisted (it's a secret — see schema.ts).
        // (town's resolved settlementChainId/assetCode were already written onto
        // deps.config in the preflight above.)
        if (type === 'mill') deps.config.nodes.mill.relays = millRelays;
        if (type === 'mill' || type === 'town') {
          try {
            saveConfig(deps.configPath, deps.config);
          } catch (err: unknown) {
            request.log.warn(
              {
                event: 'node_lifecycle_config_persist_warn',
                type,
                err: sanitizeErrorMessage(
                  err instanceof Error ? err.message : String(err)
                ),
              },
              'Provisioned node but failed to persist its config.yaml selection — node is live; re-supply the flag if it is recreated'
            );
          }
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

// Matches `KEY=value` where KEY is a known-secret name; redacts the value
// up to the next whitespace, quote, or newline. Compiled once at module scope
// so repeated error-path calls don't re-join the array and re-compile the RegExp.
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
const REDACT_RE = new RegExp(`(${SECRET_KEYS.join('|')})=[^\\s"'\\n\\r]+`, 'g');

/**
 * Strip secret-name env assignments from an error message before it reaches
 * the HTTP response body (P5). Compose stderr can echo env interpolation in
 * error output; secrets injected via `startNodeViaCompose` would otherwise
 * surface to the API client. Conservative: replace the VALUE not the key, so
 * operators still see WHICH secret was involved.
 */
function sanitizeErrorMessage(msg: string): string {
  return msg.replace(REDACT_RE, '$1=[REDACTED]');
}
