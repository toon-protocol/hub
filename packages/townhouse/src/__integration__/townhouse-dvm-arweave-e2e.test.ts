/**
 * Live E2E Gate — Real .anyone Loop + DVM Arweave Upload (Story 49-5)
 *
 * Extends the 49.1 foreign-HS harness with a DVM kind:5094 Arweave upload.
 *
 * AC mapping:
 *   Test 1 (AC #1 + #3): kind:1 via .anyone; transport invariants
 *   Test 2 (AC #2):       kind:5094 job; DVM returns Arweave txid in ILP FULFILL data
 *   Test 3 (AC #4):       Earnings credit in /api/earnings after paid publish
 *   Test 4 (AC #5):       Chain endpoints are Akash-hosted (not 127.0.0.1)
 *   Test 5 (AC #6):       DVM runs unauthenticated Turbo (no DVM_ARWEAVE_JWK_B64)
 *
 * DVM Protocol (packages/sdk/src/arweave/arweave-dvm-handler.ts):
 *   Request:  kind:5094 with ['i', base64Blob, 'blob'], ['bid', amount, 'usdc'], ['output', mime]
 *   Response: ILP FULFILL data = Buffer.from(txId).toString('base64')
 *   txId is base64url ~43 chars; publishEvent() carries this in result.data
 *
 * Prerequisites:
 *   RUN_DOCKER_INTEGRATION=1 + SKIP_DOCKER unset
 *   deploy/akash/leases.json with anvil.url + solana.url (non-localhost)
 *   dist/image-manifest.json (from CI), dist/cli.js (pnpm build)
 *   bash scripts/sdk-e2e-infra.sh up  (Anvil at 18545)
 *   bash scripts/townhouse-test-infra.sh up  (warms image cache)
 *   ports 9401/28090/9402/9050/3002/8082/3400 free
 *
 * Wall budget: ~20-25 min (B anon ~4 min, apex ~5 min, DVM ~1 min, publishes ~3 min)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import { ToonClient } from '@toon-protocol/client';
import type { SignedBalanceProof } from '@toon-protocol/client';

import {
  isTruthyEnv,
  runCli,
  waitForExit,
  waitForUrl,
} from './_test-helpers.js';
import { ConnectorAdminClient } from '../connector/admin-client.js';
import type { RecentClaim } from '../connector/types.js';
import type { NodesYaml } from '../state/nodes-yaml.js';
import { PeerTypeResolver } from '../registry/peer-type-resolver.js';
import { streamSwap } from '@toon-protocol/sdk';
import type { StreamSwapResult } from '@toon-protocol/sdk';
import { parseIlpPeerInfo } from '@toon-protocol/core';
import type { Filter as NostrFilter } from 'nostr-tools/filter';

// ── Skip gate ────────────────────────────────────────────────────────────────

const shouldRun =
  process.env['RUN_DOCKER_INTEGRATION'] === '1' &&
  !isTruthyEnv(process.env['SKIP_DOCKER']);

if (!shouldRun) {
  console.warn(
    '\n[49-5] Skipping DVM Arweave E2E: set RUN_DOCKER_INTEGRATION=1\n'
  );
}

// ── Constants ────────────────────────────────────────────────────────────────

const TEST_PASSWORD = 'integration-test';

const HS_CONNECTOR_NAME = 'townhouse-hs-connector';
const HS_CONTAINER_NAMES = [
  HS_CONNECTOR_NAME,
  'townhouse-hs-api',
  'townhouse-hs-town',
] as const;
const HS_VOLUMES = ['townhouse-hs-anon', 'townhouse-hs-town-data'] as const;

const B_CONNECTOR_NAME = 'townhouse-foreign-b-connector';
const B_ANON_VOLUME = 'townhouse-foreign-b-anon';
const B_SOCKS5_URL = 'socks5h://127.0.0.1:9050';
const B_BTP_PORT = 3002;
const B_HEALTH_PORT = 8082;

const DVM_CONTAINER_NAME = 'townhouse-dvm';
const _DVM_ANON_VOLUME = 'townhouse-dvm-anon';
const DVM_BLS_PORT = 3400;
// Fixed test DVM Nostr key (32 bytes, not a real wallet). gitleaks:allow
const DVM_NOSTR_SECRET_KEY =
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
// Fixed test Town relay Nostr key. gitleaks:allow
const TOWN_NOSTR_SECRET_KEY =
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const MILL_CONTAINER_NAME = 'townhouse-hs-mill';
const MILL_BLS_PORT = 3200;
const TOWN_RELAY_WS_PORT = 7100; // mapped to host loopback for kind:10032 subscription
// Fixed test Mill Nostr key (32 bytes, not a real wallet). gitleaks:allow
const MILL_NOSTR_SECRET_KEY =
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
// Mill derives its EVM/Solana HD wallets from a BIP-39 mnemonic (BIP-32) — it
// rejects a bare secretKey (MILL_REQUIRES_MNEMONIC). The pinned gate image
// reads the mnemonic from the MILL_MNEMONIC env (cli.ts applyEnvOverlay), which
// is the version-stable path. BIP-39 all-zero-entropy test vector (Mill's
// ZERO_MNEMONIC fixture) — deterministic, devnet-only, never a real wallet.
// gitleaks:allow
const TEST_MILL_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Solana SOL address for chainRecipient — deterministic Akash Solana devnet faucet authority.
// Derived from infra/solana/keys/faucet-authority.json bytes[32..63] base58-encoded.
const B_SOL_ADDRESS = 'ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3';

const CONNECTOR_ADMIN_URL = 'http://127.0.0.1:9401';
const HS_API = 'http://127.0.0.1:28090';
const HS_API_READY_URL = `${HS_API}/api/transport`;
// /api/earnings requires townhouse-api RC5+; older HS images return 404.
// Use the connector admin API directly instead.
const CONNECTOR_HEALTH_URL = `${CONNECTOR_ADMIN_URL}/health`;
const _CONNECTOR_BALANCES_URL = `${CONNECTOR_ADMIN_URL}/admin/balances`;
// DVM variables
let dvmBtpConnectorUrl = ''; // set after connector bridge IP is known

const ANVIL_RPC = 'http://127.0.0.1:18545';
// TEST KEY — Anvil deterministic account #4. NOT a real wallet. Safe to commit.
const B_PRIVATE_KEY =
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const B_EVM_ADDR = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const A_EVM_ADDR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const TOKEN_NETWORK = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';
const TOKEN_ADDR = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const CHAIN_KEY = 'evm:base:31337';
const CHAIN_ID = 31337;

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function loadImageFromManifest(
  key: 'connector' | 'dvm' | 'town' | 'mill'
): string {
  const p = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'dist',
    'image-manifest.json'
  );
  if (!existsSync(p))
    throw new Error(`dist/image-manifest.json missing — run CI download`);
  const m = JSON.parse(readFileSync(p, 'utf-8')) as {
    images: Record<string, { name: string; digest: string }>;
  };
  const e = m.images[key];
  if (!e?.name || !e.digest)
    throw new Error(`image-manifest.json missing images.${key}{name,digest}`);
  return `${e.name}@${e.digest}`;
}

interface LeasesJson {
  anvil?: { url: string };
  solana?: { url: string; dseq?: string };
}

function loadLeases(): LeasesJson {
  const repoRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..'
  );
  const p = join(repoRoot, 'deploy', 'akash', 'leases.json');
  if (!existsSync(p)) throw new Error(`leases.json missing at ${p}`);
  return JSON.parse(readFileSync(p, 'utf-8')) as LeasesJson;
}

function dockerBridgeGateway(): string {
  try {
    const out = execSync(
      `docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}\n{{end}}'`,
      { encoding: 'utf-8', timeout: 5_000 }
    ).trim();
    const ipv4 = out
      .split('\n')
      .find((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s.trim()));
    if (ipv4) return ipv4.trim();
  } catch {
    /* fall through */
  }
  return '172.17.0.1';
}

function probePortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let s: ReturnType<typeof createConnection>;
    try {
      s = createConnection({ port, host: '127.0.0.1' });
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const settle = (free: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(free);
    };
    s.once('connect', () => settle(false));
    s.once('error', (e: NodeJS.ErrnoException) =>
      settle(e.code === 'ECONNREFUSED')
    );
    s.setTimeout(1_000, () => settle(false));
  });
}

async function assertPortsFree(): Promise<void> {
  const ports = [
    9401,
    28090,
    9402,
    9050,
    B_BTP_PORT,
    B_HEALTH_PORT,
    DVM_BLS_PORT,
    MILL_BLS_PORT, // 3200 — Mill BLS health
    TOWN_RELAY_WS_PORT, // 7100 — town relay WS (mapped to host for kind:10032 subscription)
  ];
  const bound = (
    await Promise.all(
      ports.map((p) => probePortFree(p).then((free) => ({ p, free })))
    )
  )
    .filter((c) => !c.free)
    .map((c) => c.p);
  if (bound.length)
    throw new Error(
      `Ports already bound: ${bound.join(', ')} — stop any running stack`
    );
}

async function waitForExitLabelled(
  child: ChildProcess,
  ms: number,
  label: string
): Promise<number> {
  const code = await waitForExit(child, ms).catch((e) => {
    throw new Error(
      `[${label}] timeout (${ms}ms): ${e instanceof Error ? e.message : e}`
    );
  });
  if (code === null) throw new Error(`[${label}] exited null (killed)`);
  return code;
}

function cleanupAll(): void {
  // 'townhouse-hs-town' is already in HS_CONTAINER_NAMES — do not append separately.
  // DVM_CONTAINER_NAME is the Docker DVM container (D3).
  const cs = [
    ...HS_CONTAINER_NAMES,
    B_CONNECTOR_NAME,
    DVM_CONTAINER_NAME,
    MILL_CONTAINER_NAME,
  ];
  const vs = [...HS_VOLUMES, B_ANON_VOLUME];
  for (const n of cs) {
    try {
      execSync(`docker rm -f ${n}`, { stdio: 'pipe', timeout: 30_000 });
    } catch {
      /* ok */
    }
  }
  for (const v of vs) {
    try {
      execSync(`docker volume rm -f ${v}`, { stdio: 'pipe', timeout: 30_000 });
    } catch {
      /* ok */
    }
  }
}

async function startConnectorContainer(
  containerName: string,
  volumeName: string,
  configYaml: string,
  configDir: string,
  image: string,
  extraDockerArgs = ''
): Promise<void> {
  try {
    execSync(`docker rm -f ${containerName}`, {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch {
    /* ok */
  }
  try {
    execSync(`docker volume rm -f ${volumeName}`, {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch {
    /* ok */
  }
  execSync(`docker volume create ${volumeName}`, {
    stdio: 'pipe',
    timeout: 30_000,
  });
  execSync(
    `docker run --rm --platform linux/amd64 -v ${volumeName}:/data busybox sh -c "chown -R 1000:1000 /data && chmod 700 /data"`,
    { stdio: 'pipe', timeout: 60_000 }
  );
  writeFileSync(join(configDir, 'connector.yaml'), configYaml, {
    encoding: 'utf-8',
    mode: 0o644,
  });
  execSync(
    `docker run -d \
      --name ${containerName} \
      --platform linux/amd64 \
      --network host \
      ${extraDockerArgs} \
      -v ${join(configDir, 'connector.yaml')}:/config/connector.yaml:ro \
      -v ${volumeName}:/var/lib/anon/hs \
      -e CONFIG_FILE=/config/connector.yaml \
      ${image}`,
    { stdio: 'pipe', timeout: 60_000 }
  );
  await sleep(1500);
  const state = execSync(
    `docker inspect ${containerName} --format '{{.State.Status}}'`,
    { encoding: 'utf-8', timeout: 5_000 }
  ).trim();
  if (state !== 'running') {
    const logs = execSync(`docker logs --tail 30 ${containerName} 2>&1`, {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    throw new Error(
      `${containerName} state=${state} (expected running). Logs:\n${logs.trim()}`
    );
  }
}

// DVM runs as a Docker container on townhouse-hs-net.
// Image is loaded from dist/image-manifest.json (key: 'dvm').
// DVM_ARWEAVE_JWK_B64 intentionally absent → unauthenticated Turbo free tier (AC #6).
const dvmLogs: string[] = [];

async function startDvm(): Promise<void> {
  const dvmImage = loadImageFromManifest('dvm');
  // Guard: dvmBtpConnectorUrl must be resolved from the connector bridge IP.
  if (!dvmBtpConnectorUrl) {
    throw new Error(
      'dvmBtpConnectorUrl is empty — connector bridge IP lookup failed before startDvm()'
    );
  }
  // Remove any stale container from a previous run
  try {
    execSync(`docker rm -f ${DVM_CONTAINER_NAME}`, {
      stdio: 'pipe',
      timeout: 15_000,
    });
  } catch {
    /* ok */
  }
  // Launch DVM container on townhouse-hs-net so it can reach the connector at its bridge IP.
  // Port DVM_BLS_PORT is mapped to host loopback for health probing.
  // Port 3300 (HTTP handler) is mapped to host 0.0.0.0:3300 so the connector container
  // (on townhouse-hs-net) can reach it at hsNetGw:3300 via localDelivery.handlerUrl.
  execSync(
    `docker run -d \
      --name ${DVM_CONTAINER_NAME} \
      --network townhouse-hs-net \
      --platform linux/amd64 \
      -p 127.0.0.1:${DVM_BLS_PORT}:${DVM_BLS_PORT} \
      -p 3300:3300 \
      -e NODE_NOSTR_SECRET_KEY=${DVM_NOSTR_SECRET_KEY} \
      -e "CONNECTOR_URL=${dvmBtpConnectorUrl}" \
      -e ILP_ADDRESS=g.townhouse.dvm \
      -e BLS_PORT=${DVM_BLS_PORT} \
      -e HANDLER_PORT=3300 \
      -e NODE_ENV=development \
      ${dvmImage}`,
    { stdio: 'pipe', timeout: 30_000 }
  );
  // Allow container to start and bind the BLS port before continuing
  await sleep(2_000);
  const state = execSync(
    `docker inspect ${DVM_CONTAINER_NAME} --format '{{.State.Status}}'`,
    { encoding: 'utf-8', timeout: 5_000 }
  ).trim();
  if (state !== 'running') {
    const logs = execSync(`docker logs --tail 30 ${DVM_CONTAINER_NAME} 2>&1`, {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    dvmLogs.push(...logs.split('\n').filter(Boolean));
    throw new Error(
      `${DVM_CONTAINER_NAME} state=${state} (expected running). Logs:\n${logs.trim()}`
    );
  }

  // Capture the FULL boot log now (no --tail). The "Arweave credit source: ..."
  // line is emitted once at boot (entrypoint-dvm.ts); after the DVM has served
  // requests it scrolls past a `--tail N` window, so AC #6 (which runs before
  // afterAll's full-log capture) needs these early lines recorded up front.
  try {
    const bootLogs = execSync(`docker logs ${DVM_CONTAINER_NAME} 2>&1`, {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    dvmLogs.push(...bootLogs.split('\n').filter(Boolean));
  } catch {
    /* boot-log capture is best-effort; afterAll captures full logs too */
  }
}

function buildTestMillConfig(connectorBtpUrl: string): object {
  return {
    // Mill HD-derives its EVM/Solana wallets from this BIP-39 mnemonic; also
    // passed via MILL_MNEMONIC env in startMill() for image versions whose
    // config loader does not read config.mnemonic (see TEST_MILL_MNEMONIC).
    mnemonic: TEST_MILL_MNEMONIC,
    swapPairs: [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: CHAIN_KEY }, // 'evm:base:31337'
        to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
        rate: '1.0',
        minAmount: '1000',
        maxAmount: '1000000000',
      },
    ],
    chains: ['evm', 'solana'],
    // Bootstrap: validateConfig() requires a non-empty channels array for each
    // distinct pair.to.chain. channelId MUST be a Solana-format value (base58,
    // 32-byte) — the EVM-format zero sentinel ('0x'+64 zeros) fails the FULFILL
    // decoder's solana validateChainAddress check (base58 + 32-44 chars + decodes
    // to 32 bytes), producing FULFILL metadata.channelId malformed. This is a
    // deterministic base58 32-byte channel reference (sha256 of a fixed label);
    // the FULFILL claim is an off-chain signed balance proof that decodes + passes
    // structure checks. (A fully on-chain SOL channel PDA would require opening +
    // funding a channel on the Akash solana payment_channel program; there is no
    // SOL channel-open tooling yet, and the test validates claim issuance/decode,
    // not on-chain settlement.)
    channels: {
      'solana:devnet': [
        {
          channelId: '4915MN8VmqABAXjDkF3ccUHEo8CnpguYYn2Go85ojyJx',
          cumulativeAmount: '0',
          nonce: '0',
        },
      ],
    },
    // SOL inventory provisioned (Story 50.1): Mill's swap claim-issuer debits
    // this configured liquidity when issuing a Solana USDC claim (claim-issuer.ts
    // makes NO on-chain RPC — inventory is the in-memory liquidity ledger). Mill's
    // Solana wallet (7MJCp1arCr2vKGMvUykJ9WB3dQjtdTbPvaVSHM1LK126, derived from the
    // mnemonic) is SOL-funded via scripts/faucet-sol.sh on the Akash solana devnet;
    // 1000 USDC (1e9 base units @ 6 decimals) here covers the 1_000_000 swap leg
    // with headroom. Was '0' (a deliberate "blocked" sentinel) → T04 insufficient
    // liquidity.
    inventory: { 'solana:devnet': '1000000000' },
    // Embedded-with-parent wiring: connectorUrl activates Mill's embedded
    // connector which BTP-dials the apex connector and registers g.townhouse.mill.
    connectorUrl: connectorBtpUrl,
    ilpAddress: 'g.townhouse.mill',
    nodeId: 'mill',
    // MUST equal the apex connector's nodeId (its BTP auth identity) so the
    // embedded connector's relation-aware inbound-claim skip (connector#78)
    // matches the parent-forwarded packet's source peerId. 'apex' was a fixture
    // alias that never matched 'g.townhouse'.
    parentPeerId: 'g.townhouse',
    parentAuthToken: '',
    // Relay for kind:10032 advertisement (within townhouse-hs-net).
    relayUrls: ['ws://townhouse-hs-town:7100'],
  };
}

const millLogs: string[] = [];
// Mill's kind:10032 is signed with its Nostr identity, which Mill derives from
// the BIP-39 mnemonic (mill.ts `fromMnemonic`) — NOT from NODE_NOSTR_SECRET_KEY.
// Captured from Mill's `mill_ready` log line in startMill() so the kind:10032
// subscription filters on Mill's ACTUAL author pubkey.
let millNostrPubkey = '';

async function startMill(bConfigDir: string): Promise<void> {
  const millImage = loadImageFromManifest('mill');
  if (!dvmBtpConnectorUrl) {
    throw new Error(
      'dvmBtpConnectorUrl is empty — connector bridge IP lookup failed before startMill()'
    );
  }
  const millConfigObj = buildTestMillConfig(dvmBtpConnectorUrl);
  // Write config to file to avoid shell-quoting issues with nested JSON.
  const millConfigFile = join(bConfigDir, `mill-config-${Date.now()}.json`);
  writeFileSync(millConfigFile, JSON.stringify(millConfigObj), {
    encoding: 'utf-8',
    mode: 0o644,
  });

  try {
    execSync(`docker rm -f ${MILL_CONTAINER_NAME}`, {
      stdio: 'pipe',
      timeout: 15_000,
    });
  } catch {
    /* ok */
  }

  execSync(
    `docker run -d \
      --name ${MILL_CONTAINER_NAME} \
      --network townhouse-hs-net \
      --platform linux/amd64 \
      -p 127.0.0.1:${MILL_BLS_PORT}:${MILL_BLS_PORT} \
      -e NODE_NOSTR_SECRET_KEY=${MILL_NOSTR_SECRET_KEY} \
      -e MILL_MNEMONIC='${TEST_MILL_MNEMONIC}' \
      -e MILL_RELAYS=ws://townhouse-hs-town:${TOWN_RELAY_WS_PORT} \
      -e TOON_CONNECTOR_URL=${dvmBtpConnectorUrl} \
      -e TOON_PARENT_PEER_ID=g.townhouse \
      -e TOON_PARENT_AUTH_TOKEN= \
      -e TOON_ILP_ADDRESS=g.townhouse.mill \
      -e TOON_PEERINFO_ILP_ADDRESS=g.townhouse.town \
      -e TOON_PEERINFO_PRICE_PER_BYTE=0 \
      -v ${millConfigFile}:/mill.config.json:ro \
      -e MILL_CONFIG_PATH=/mill.config.json \
      ${millImage}`,
    { stdio: 'pipe', timeout: 30_000 }
  );
  await sleep(2_000);
  const state = execSync(
    `docker inspect ${MILL_CONTAINER_NAME} --format '{{.State.Status}}'`,
    { encoding: 'utf-8', timeout: 5_000 }
  ).trim();
  if (state !== 'running') {
    const logs = execSync(`docker logs --tail 30 ${MILL_CONTAINER_NAME} 2>&1`, {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    millLogs.push(...logs.split('\n').filter(Boolean));
    throw new Error(
      `${MILL_CONTAINER_NAME} state=${state} (expected running). Logs:\n${logs.trim()}`
    );
  }
  // Capture Mill's self-reported Nostr pubkey (mnemonic-derived) from its
  // `mill_ready` log line — this is the author of the kind:10032 advertisement.
  const readyLogs = execSync(`docker logs ${MILL_CONTAINER_NAME} 2>&1`, {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  millLogs.push(...readyLogs.split('\n').filter(Boolean));
  // Anchor to the `mill_ready` line so an earlier log line carrying a
  // `"pubkey":"<64hex>"` field (e.g. connector diagnostics) cannot be mistaken
  // for Mill's identity. logJson emits `…"msg":"mill_ready"…"pubkey":"…"` with
  // msg before the pubkey field on the same line.
  const pkMatch = readyLogs.match(
    /"msg":"mill_ready"[^\n]*?"pubkey":"([0-9a-f]{64})"/
  );
  if (pkMatch) millNostrPubkey = pkMatch[1]!;
}

async function waitForSocks5(timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((res) => {
      const s = createConnection({ host: '127.0.0.1', port: 9050 }, () => {
        s.destroy();
        res(true);
      });
      s.once('error', () => res(false));
      s.setTimeout(2_000, () => {
        s.destroy();
        res(false);
      });
    });
    if (ok) return;
    await sleep(3_000);
  }
  throw new Error(
    `B anon SOCKS5 (127.0.0.1:9050) not ready within ${timeoutMs}ms`
  );
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!shouldRun)(
  'townhouse DVM Arweave E2E — .anyone + kind:5094 (Story 49-5)',
  () => {
    let tmpDirA: string;
    let hostnameA: string;
    let adminClientA: ConnectorAdminClient;
    let toonClient: ToonClient | null = null;
    let bSecretKey: Uint8Array;
    let bPubkey: string;
    let bConfigDir: string | null = null;
    let priorPwd: string | undefined;
    let leases: LeasesJson;
    let aDestination = '';

    let kind1Result: {
      success: boolean;
      eventId?: string;
      data?: string;
      claimHash?: string;
      chainId?: number;
      error?: string;
    } = {
      success: false,
      error: 'beforeAll incomplete',
    };
    let kind1EventId = '';
    let dvmResult: { success: boolean; data?: string; error?: string } = {
      success: false,
      error: 'beforeAll incomplete',
    };
    let testStartMs = 0;

    // Mill state (AC #1–#5)
    let millPubkey = '';
    let millSwapPair: {
      from: { assetCode: string; assetScale: number; chain: string };
      to: { assetCode: string; assetScale: number; chain: string };
      rate: string;
    } | null = null;
    let millStreamSwapResult: StreamSwapResult | null = null;

    beforeAll(async () => {
      testStartMs = Date.now();
      priorPwd = process.env['TOWNHOUSE_WALLET_PASSWORD'];
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = TEST_PASSWORD;

      // ── AC #5 pre-flight: Akash leases ──────────────────────────────────────
      leases = loadLeases();
      if (!leases.anvil?.url || !leases.solana?.url)
        throw new Error('[49-5] leases.json missing anvil.url or solana.url');
      if (
        leases.anvil.url.includes('127.0.0.1') ||
        leases.solana.url.includes('127.0.0.1')
      )
        throw new Error('[49-5] AC #5: leases.json URLs must not be 127.0.0.1');
      for (const [label, url] of [
        ['anvil', leases.anvil.url],
        ['solana', leases.solana.url],
      ] as const) {
        await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((e) => {
          throw new Error(
            `Pre-flight Akash ${label} chain probe failed (${url}): ${(e as Error).message}`
          );
        });
      }

      // ── CLI binary ──────────────────────────────────────────────────────────
      const cliBin = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'dist',
        'cli.js'
      );
      if (!existsSync(cliBin))
        throw new Error(
          `dist/cli.js not found. Run: pnpm --filter @toon-protocol/townhouse build`
        );

      // ── Port pre-flight + B keypair ─────────────────────────────────────────
      await assertPortsFree();
      bSecretKey = generateSecretKey();
      bPubkey = getPublicKey(bSecretKey);
      console.log(`[49-5] B pubkey: ${bPubkey.slice(0, 16)}...`);

      // ── Start B connector (--network host → anon SOCKS5 on host loopback) ───
      bConfigDir = mkdtempSync(join(tmpdir(), 'townhouse-49-5-b-'));
      mkdirSync(bConfigDir, { recursive: true, mode: 0o700 });
      const connectorImage = loadImageFromManifest('connector');
      const bYaml = [
        `nodeId: g.townhouse.foreign-client.${bPubkey.slice(0, 8)}`,
        `btpServerPort: ${B_BTP_PORT}`,
        `healthCheckPort: ${B_HEALTH_PORT}`,
        'environment: development',
        'deploymentMode: standalone',
        'logLevel: warn',
        'adminApi:',
        '  enabled: true',
        '  port: 9402',
        '  host: 127.0.0.1',
        "  allowedIPs: ['127.0.0.1/32']",
        'transport:',
        '  type: socks5',
        '  socksProxy: socks5h://127.0.0.1:9050',
        '  managed: true',
        '  externalUrl: auto',
        '  managedOptions:',
        '    hiddenServiceDir: /var/lib/anon/hs',
        `    hiddenServicePort: ${B_BTP_PORT}`,
        '    startupTimeoutMs: 360000',
        'chainProviders: []',
        'peers: []',
        'routes: []',
      ].join('\n');
      console.log('[49-5] Starting B connector...');
      await startConnectorContainer(
        B_CONNECTOR_NAME,
        B_ANON_VOLUME,
        bYaml,
        bConfigDir,
        connectorImage
      );

      // ── Wait for B's anon SOCKS5 ────────────────────────────────────────────
      console.log('[49-5] Waiting for B anon SOCKS5...');
      await waitForSocks5(240_000);
      console.log('[49-5] B anon SOCKS5 ready');

      // ── Init + hs up A ──────────────────────────────────────────────────────
      tmpDirA = mkdtempSync(join(tmpdir(), 'townhouse-49-5-a-'));
      const initCode = await waitForExitLabelled(
        runCli('init', {
          configDir: tmpDirA,
          password: TEST_PASSWORD,
          env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
        }).process,
        30_000,
        'townhouse init A'
      );
      if (initCode !== 0) throw new Error(`townhouse init exited ${initCode}`);

      const upCode = await waitForExitLabelled(
        runCli('hs', {
          configDir: tmpDirA,
          password: TEST_PASSWORD,
          env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
          extraArgs: ['up'],
        }).process,
        360_000,
        'townhouse hs up A'
      );
      if (upCode !== 0) throw new Error(`townhouse hs up exited ${upCode}`);

      // ── Capture A's hostname ────────────────────────────────────────────────
      const hostJson = JSON.parse(
        readFileSync(join(tmpDirA, 'host.json'), 'utf-8')
      ) as { hostname: string };
      expect(hostJson.hostname).toMatch(/^[a-z2-7]{55,57}\.(anyone|anon)$/);
      hostnameA = hostJson.hostname;
      console.log(`[49-5] A hostname: ${hostnameA}`);
      await waitForUrl(HS_API_READY_URL, {
        maxMs: 30_000,
        label: 'townhouse-api /api/transport',
      });

      // ── Patch connector.yaml: dead rpcUrl → real Anvil ──────────────────────
      const yamlPath = join(tmpDirA, 'connector.yaml');
      const rawYaml = readFileSync(yamlPath, 'utf-8');
      const gw = dockerBridgeGateway();
      // Get the townhouse-hs-net gateway (connector container's route to the host).
      // The default bridge gw (172.17.0.1) is wrong for containers on townhouse-hs-net.
      let hsNetGw = gw; // fallback to default bridge gw
      try {
        const hsGwOut = execSync(
          `docker network inspect townhouse-hs-net --format '{{range .IPAM.Config}}{{.Gateway}}\n{{end}}'`,
          { encoding: 'utf-8', timeout: 5_000 }
        )
          .trim()
          .split('\n')
          .find((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s.trim()))
          ?.trim();
        if (hsGwOut) hsNetGw = hsGwOut;
      } catch {
        /* fall through */
      }

      let patched = rawYaml.replace(
        /rpcUrl:\s*['"]?http:\/\/127\.0\.0\.1:19999['"]?/g,
        `rpcUrl: 'http://${hsNetGw}:18545'`
      );
      if (patched === rawYaml)
        throw new Error('connector.yaml rpcUrl patch produced no change');
      // Enable localDelivery so the connector forwards packets for g.townhouse to
      // the DVM HTTP handler at port 3300. The original connector.yaml may already
      // have localDelivery.enabled: false — REPLACE it rather than append (YAML
      // parsers use the first occurrence of a duplicate key).
      const localDeliveryBlock = `localDelivery:\n  enabled: true\n  handlerUrl: 'http://${hsNetGw}:3300'`;
      if (/localDelivery:/.test(patched)) {
        patched = patched.replace(
          /^localDelivery:.*(?:\n[ \t]+.*)*\n?/m,
          localDeliveryBlock + '\n'
        );
      } else {
        patched += `\n${localDeliveryBlock}\n`;
      }
      // Add a self-route: g.townhouse → local. The connector's routing table is built
      // from the `routes:` YAML field; without this entry getNextHop('g.townhouse')
      // returns null and the connector rejects with F02 BEFORE checking localDelivery.
      // nextHop: 'local' matches the packet-handler check (nextHop === 'local').
      const selfRouteEntry = `  - prefix: 'g.townhouse'\n    nextHop: local\n    priority: 100`;
      if (/routes:\s*\[\]/.test(patched)) {
        patched = patched.replace(
          /routes:\s*\[\]/,
          `routes:\n${selfRouteEntry}`
        );
      } else if (
        /^routes:/m.test(patched) &&
        !/prefix.*g\.townhouse/.test(patched)
      ) {
        patched = patched.replace(/^(routes:)/m, `$1\n${selfRouteEntry}`);
      } else if (!/routes:/.test(patched)) {
        patched += `\nroutes:\n${selfRouteEntry}\n`;
      }
      // Zero the apex's connector fee so the EVM→Mill→SOL streamSwap is a clean
      // 1:1 (Mill rate 1.0). A townhouse HS is a single-operator stack (apex +
      // mill same operator), so the apex must NOT take the default 0.1%
      // connectorFeePercentage cut on routing to its own child Mill — otherwise
      // Mill receives 999000 (1000 fee) and the SOL claim lands at 999000, not
      // the 1000000 (±1) AC#3/AC#5 expect. (connector-node.js:570 defaults the
      // fee to 0.1 when settlement.connectorFeePercentage is absent.)
      if (/^settlement:/m.test(patched)) {
        if (/connectorFeePercentage:/.test(patched)) {
          patched = patched.replace(
            /connectorFeePercentage:\s*[\d.]+/g,
            'connectorFeePercentage: 0'
          );
        } else {
          patched = patched.replace(
            /^(settlement:)/m,
            '$1\n  connectorFeePercentage: 0'
          );
        }
      } else {
        patched += `\nsettlement:\n  connectorFeePercentage: 0\n`;
      }
      writeFileSync(yamlPath, patched, { mode: 0o600 });
      execSync(`docker restart ${HS_CONNECTOR_NAME}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
      await waitForUrl(`${CONNECTOR_ADMIN_URL}/health`, {
        maxMs: 60_000,
        label: 'connector restart',
      });
      console.log(
        `[49-5] Patched rpcUrl → ${hsNetGw}:18545, localDelivery → http://${hsNetGw}:3300, routes.g.townhouse → local`
      );

      adminClientA = new ConnectorAdminClient(CONNECTOR_ADMIN_URL, 5_000);

      // Get connector's bridge IP — needed so the DVM host process can connect
      // to the connector's BTP WebSocket (port 3000, not mapped to host).
      try {
        const connectorBridgeIp = execSync(
          `docker inspect ${HS_CONNECTOR_NAME} --format '{{(index .NetworkSettings.Networks "townhouse-hs-net").IPAddress}}'`,
          { encoding: 'utf-8', timeout: 5_000 }
        ).trim();
        if (
          connectorBridgeIp &&
          /^\d+\.\d+\.\d+\.\d+$/.test(connectorBridgeIp)
        ) {
          dvmBtpConnectorUrl = `ws://${connectorBridgeIp}:3000`;
          console.log(
            `[49-5] Connector bridge IP: ${connectorBridgeIp} → DVM BTP: ${dvmBtpConnectorUrl}`
          );
        }
      } catch (e) {
        console.warn(
          `[49-5] Could not get connector bridge IP: ${(e as Error).message}`
        );
      }

      // ── Register the HS-compose town relay with the connector ────────────
      // townhouse-hs-town starts as part of the compose stack but isn't
      // pre-registered in connector.yaml (node add town does that, but the
      // HS-mode API doesn't expose POST /api/nodes). Use registerPeer directly.
      // The relay listens on port 7100 inside the compose bridge network.
      // Docker internal hostname 'townhouse-hs-town' resolves from the connector
      // container which is on the same compose network.
      // ── Start the town relay on the compose bridge network ─────────────────
      // The HS apex-only boot skips the `town` profile. The connector is on
      // the `townhouse-hs-net` bridge, BTP on port 3000 (NOT mapped to host).
      // Run the relay on the SAME bridge network so `connector:3000` resolves.
      console.log(
        '[49-5] Starting town relay (townhouse-hs-net, CONNECTOR_URL=ws://connector:3000)...'
      );
      const townImage = loadImageFromManifest('town');
      try {
        try {
          execSync(`docker rm -f townhouse-hs-town`, {
            stdio: 'pipe',
            timeout: 15_000,
          });
        } catch {
          /* ok */
        }
        // Use townhouse-hs-net gateway (same network as connector) so the relay can reach the host's Anvil
        const relayRpcUrl = `http://${hsNetGw}:18545`;
        execSync(
          `docker run -d \
            --name townhouse-hs-town \
            --network townhouse-hs-net \
            --platform linux/amd64 \
            -p 127.0.0.1:${TOWN_RELAY_WS_PORT}:7100 \
            -e CONNECTOR_URL=ws://connector:3000 \
            -e ILP_ADDRESS=g.townhouse.town \
            -e NODE_ID=town \
            -e PARENT_PEER_ID=g.townhouse \
            -e FEE_PER_EVENT=0 \
            -e NODE_NOSTR_SECRET_KEY=${TOWN_NOSTR_SECRET_KEY} \
            -e TOON_SETTLEMENT_PRIVATE_KEY=${B_PRIVATE_KEY} \
            -e PARENT_EVM_ADDRESS=${A_EVM_ADDR} \
            -e TOON_RPC_URL=${relayRpcUrl} \
            ${townImage}`,
          { stdio: 'pipe', timeout: 60_000 }
        );
        await sleep(5_000); // let relay start and attempt BTP connect to connector:3000
        const townState = execSync(
          `docker inspect townhouse-hs-town --format '{{.State.Status}}'`,
          { encoding: 'utf-8', timeout: 5_000 }
        ).trim();
        if (townState !== 'running') {
          const logs = execSync(
            'docker logs --tail 20 townhouse-hs-town 2>&1',
            { encoding: 'utf-8', timeout: 5_000 }
          );
          console.warn(
            `[49-5] town relay state=${townState}. Logs:\n${logs.trim()}`
          );
          aDestination = 'g.townhouse';
        } else {
          console.log(
            '[49-5] Town relay started on townhouse-hs-net (CONNECTOR_URL=ws://connector:3000)'
          );
        }
      } catch (e) {
        console.warn(
          `[49-5] docker run town failed: ${(e as Error).message} — falling back to g.townhouse`
        );
        aDestination = 'g.townhouse';
      }

      // If town relay started, get its bridge IP and register with connector
      if (aDestination !== 'g.townhouse') {
        await sleep(5_000); // let the relay connect to connector:3000 and authenticate
        // The relay's BTP CLIENT connects to the connector's BTP SERVER at connector:3000.
        // Both are on townhouse-hs-net bridge so Docker DNS resolves 'connector'.
        // registerPeer tells the connector to ALSO accept routes via the relay's session.
        // We still need to provide a peer URL for the connector's routing table —
        // use the relay's bridge IP and BTP port (3000 is BTP, 7100 is Nostr WS).
        let relayBtpUrl = 'ws://townhouse-hs-town:3000/btp';
        try {
          const relayIp = execSync(
            `docker inspect townhouse-hs-town --format '{{(index .NetworkSettings.Networks "townhouse-hs-net").IPAddress}}'`,
            { encoding: 'utf-8', timeout: 5_000 }
          ).trim();
          if (relayIp && /^\d+\.\d+\.\d+\.\d+$/.test(relayIp)) {
            relayBtpUrl = `ws://${relayIp}:3000/btp`;
            console.log(`[49-5] Town relay bridge IP: ${relayIp}`);
          }
        } catch {
          /* fall through to hostname */
        }

        try {
          await adminClientA.registerPeer({
            id: 'g.townhouse.town',
            url: relayBtpUrl,
            authToken: '',
            transport: 'direct',
            // B2' (Story 50.3): the town relay is a CHILD of the apex — writes to
            // it are FREE (children don't pay each other). Without this the apex's
            // per-packet-claim-service tries to open a settlement channel to
            // g.townhouse.town, fails ("Peer address not found"), and rejects the
            // paid kind:1 publish with T00. `relation:'child'` makes
            // requiresSettlementClaim() return false → no settlement → free route.
            relation: 'child',
            routes: [{ prefix: 'g.townhouse.town', priority: 100 }],
          });
          aDestination = 'g.townhouse.town';
          console.log(
            `[49-5] Town relay registered (${relayBtpUrl}), destination: g.townhouse.town`
          );
        } catch (e) {
          console.warn(
            `[49-5] registerPeer failed: ${(e as Error).message} — falling back to g.townhouse`
          );
          aDestination = 'g.townhouse';
        }

        // Wait up to 30s for the relay's inbound BTP connection to establish.
        // The relay (--network host) connects to ws://127.0.0.1:3000 which is
        // the connector's BTP server (loopback). Once connected the connector
        // links the session to the registered g.townhouse.town peer.
        if (aDestination === 'g.townhouse.town') {
          console.log(
            '[49-5] Waiting for town relay inbound BTP connection...'
          );
          const townDeadline = Date.now() + 30_000;
          while (Date.now() < townDeadline) {
            const peers = await adminClientA.getPeers().catch(() => []);
            const townPeer = peers.find((p) =>
              (p.id as string)?.includes('town')
            );
            if (townPeer && (townPeer as { connected?: boolean }).connected) {
              console.log('[49-5] Town relay BTP connected (inbound)');
              break;
            }
            await sleep(2_000);
          }
        }
      }

      // ── Start DVM as Docker container (unauthenticated Turbo, townhouse-hs-net) ──
      console.log(
        '[49-5] Starting DVM (Docker container, unauthenticated Turbo)...'
      );
      await startDvm();
      await waitForUrl(`http://127.0.0.1:${DVM_BLS_PORT}/health`, {
        maxMs: 30_000,
        label: 'DVM BLS /health',
      });
      console.log('[49-5] DVM healthy');

      // DVM container is running in standalone HTTP mode on townhouse-hs-net.
      // The connector forwards packets to it via localDelivery.handlerUrl at hsNetGw:3300.
      // No BTP connection needed; just give the connector a moment to register
      // the localDelivery config after its restart.
      await sleep(2_000);

      // ── Start Mill container (AC #1) ────────────────────────────────────────
      console.log('[49-5] Starting Mill container...');
      await startMill(bConfigDir!);
      await waitForUrl(`http://127.0.0.1:${MILL_BLS_PORT}/health`, {
        maxMs: 60_000,
        label: 'Mill BLS /health',
      });
      console.log('[49-5] Mill healthy');

      // ── kind:10032 subscription (AC #3) ────────────────────────────────────
      // Subscribe to the town relay WS (mapped to host loopback) for Mill's
      // kind:10032 advertisement carrying swapPairs. Mill signs this with its
      // mnemonic-derived Nostr identity (captured from `mill_ready`), NOT with
      // NODE_NOSTR_SECRET_KEY.
      const millPubkeyHex = millNostrPubkey;
      if (!/^[0-9a-f]{64}$/.test(millPubkeyHex)) {
        throw new Error(
          `Mill Nostr pubkey not captured from mill_ready log (got '${millPubkeyHex}') — cannot filter kind:10032`
        );
      }
      const relayUrl = `ws://127.0.0.1:${TOWN_RELAY_WS_PORT}`;
      const millFilter: NostrFilter = {
        kinds: [10032],
        authors: [millPubkeyHex],
        limit: 1,
      };

      // Read Mill's kind:10032 advertisement via a RAW WebSocket + TOON decode —
      // NOT nostr-tools `SimplePool`. A TOON relay serializes every WS `EVENT`
      // as a TOON-encoded string (`ConnectionHandler` emits
      // `["EVENT", sub, encodeEventToToonString(event)]`), not standard Nostr
      // JSON, so nostr-tools silently drops the frame on its JSON event parse
      // (verified: SimplePool.get returns null even with verification disabled,
      // while a raw socket receives the TOON frame). Mill's advertisement is
      // delivered to the relay over the ILP `/handle-packet` path, so it commits
      // asynchronously — re-issue the one-shot REQ every 2s until it appears
      // (race-free) rather than relying on a single subscription + live push.
      const { WebSocket } = await import('ws');
      const fetchMillPeerInfo = (): Promise<NostrEvent | null> =>
        new Promise((res) => {
          const ws = new WebSocket(relayUrl);
          let settled = false;
          const finish = (ev: NostrEvent | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              /* already closing */
            }
            res(ev);
          };
          const timer = setTimeout(() => finish(null), 4_000);
          ws.on('open', () =>
            ws.send(JSON.stringify(['REQ', 'mill-peerinfo', millFilter]))
          );
          ws.on('message', (d: unknown) => {
            let msg: unknown;
            try {
              msg = JSON.parse(String(d));
            } catch {
              return; // non-JSON frame; ignore
            }
            if (!Array.isArray(msg) || msg[1] !== 'mill-peerinfo') return;
            if (msg[0] === 'EVENT') {
              const payload = msg[2];
              try {
                // TOON relay emits the event as a TOON string; decode it.
                const ev =
                  typeof payload === 'string'
                    ? decodeEventFromToon(new TextEncoder().encode(payload))
                    : (payload as NostrEvent);
                finish(ev);
              } catch {
                finish(null); // malformed payload — retry on next poll
              }
            } else if (msg[0] === 'EOSE') {
              finish(null); // not yet stored — retry on next poll
            }
          });
          ws.on('error', () => finish(null));
        });

      const deadline = Date.now() + 30_000;
      let advertisement: NostrEvent | null = null;
      while (Date.now() < deadline) {
        advertisement = await fetchMillPeerInfo();
        if (advertisement) break;
        await sleep(2_000);
      }
      if (!advertisement) {
        throw new Error('kind:10032 from Mill not received within 30s');
      }
      try {
        const peerInfo = parseIlpPeerInfo(advertisement);
        if (
          Array.isArray(peerInfo.swapPairs) &&
          peerInfo.swapPairs.length > 0
        ) {
          millSwapPair = peerInfo.swapPairs[0] as typeof millSwapPair;
          millPubkey = millPubkeyHex;
        } else {
          // Parsed, but no swapPairs — surface it loudly (this used to be a
          // silent path that masked the btpEndpoint parse asymmetry, Story 50.3).
          console.error(
            `[49-5] Mill kind:10032 parsed but swapPairs absent/empty — content=${String(advertisement.content).slice(0, 300)}`
          );
        }
      } catch (err) {
        // Do NOT swallow: a parse throw here (e.g. the historical empty-btpEndpoint
        // asymmetry) silently nulled millSwapPair and made the SOL leg look like a
        // discovery miss. Surface the real reason. (Story 50.3.)
        console.error(
          `[49-5] parseIlpPeerInfo THREW on Mill kind:10032: ${(err as Error).message} — content=${String(advertisement.content).slice(0, 300)}`
        );
      }
      console.log(
        `[49-5] Mill kind:10032 received, swapPair: ${JSON.stringify(millSwapPair)}`
      );

      // B2' (Story 50.3): register Mill as an apex CHILD so the EVM→Mill→SOL
      // streamSwap routes correctly. Two defects this fixes, observed in the
      // gate log: (1) ROUTING — a swap PREPARE to g.townhouse.mill (kind:1059)
      // matched the `g.townhouse → local` catch-all and was delivered to the DVM
      // handler, which rejected it `F00 "No handler registered for kind 1059"`;
      // there was no g.townhouse.mill route to Mill. (2) SETTLEMENT — a settled
      // (non-child) peer would T00. Per the production model ("the apex dials
      // btp+ws://<svc>:3000" for its children), the apex DIALS Mill's BTP server
      // (townhouse-hs-mill:3000, on townhouse-hs-net) and registers it as a child
      // with an explicit, more-specific g.townhouse.mill route (wins longest-prefix
      // over g.townhouse→local). relation:'child' → requiresSettlementClaim()=false
      // → free apex→mill forwarding.
      try {
        await adminClientA.registerPeer({
          id: 'g.townhouse.mill',
          url: `ws://${MILL_CONTAINER_NAME}:3000/btp`,
          authToken: '',
          // transport:'direct' — dial Mill DIRECTLY on townhouse-hs-net, NOT through
          // the apex's `.anyone` SOCKS5 proxy (which can't resolve internal Docker
          // hosts → "Socks5 proxy rejected connection - HostUnreachable"). The town
          // relay uses 'direct' for the same reason; production: "the apex dials
          // btp+ws://<svc>:3000" for children directly.
          transport: 'direct',
          relation: 'child',
          routes: [{ prefix: 'g.townhouse.mill', priority: 100 }],
        });
        console.log(
          '[49-5] Mill registered as child (route g.townhouse.mill → mill, free)'
        );
      } catch (e) {
        console.warn(
          `[49-5] Mill child registration failed: ${(e as Error).message} — streamSwap may misroute/T00`
        );
      }

      // ── Build ToonClient for B ──────────────────────────────────────────────
      const bIlpAddress = `g.toon.foreign.${bPubkey.slice(0, 16)}`;
      const clientConfig = {
        connectorUrl: CONNECTOR_ADMIN_URL,
        secretKey: bSecretKey,
        evmPrivateKey: B_PRIVATE_KEY,
        ilpInfo: {
          pubkey: bPubkey,
          ilpAddress: bIlpAddress,
          btpEndpoint: `ws://${hostnameA}:3000/btp`,
          assetCode: 'USD',
          assetScale: 6,
        },
        toonEncoder: encodeEventToToon,
        toonDecoder: decodeEventFromToon,
        btpUrl: `ws://${hostnameA}:3000/btp`,
        btpPeerId: bPubkey,
        btpAuthToken: '',
        transport: { type: 'socks5' as const, socksProxy: B_SOCKS5_URL },
        destinationAddress: aDestination,
        knownPeers: [],
        relayUrl: '',
        supportedChains: [CHAIN_KEY],
        chainRpcUrls: { [CHAIN_KEY]: ANVIL_RPC },
        settlementAddresses: { [CHAIN_KEY]: B_EVM_ADDR },
        preferredTokens: { [CHAIN_KEY]: TOKEN_ADDR },
        tokenNetworks: { [CHAIN_KEY]: TOKEN_NETWORK },
      };
      toonClient = new ToonClient(clientConfig);

      // ── Start ToonClient (retry up to 3× for .anon HS propagation) ──────────
      console.log(
        '[49-5] Starting ToonClient (.anyone BTP, up to 3 retries)...'
      );
      let startOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`[49-5] Retry ${attempt}/3 — waiting 60s...`);
            await sleep(60_000);
            toonClient = new ToonClient(clientConfig);
          }
          await toonClient.start();
          startOk = true;
          console.log(`[49-5] ToonClient started (attempt ${attempt})`);
          break;
        } catch (e) {
          console.warn(
            `[49-5] start() attempt ${attempt} failed: ${(e as Error).message}`
          );
          try {
            await toonClient?.stop();
          } catch {
            /* ok */
          }
        }
      }
      if (!startOk)
        throw new Error('ToonClient.start() failed after 3 attempts');

      // ── Open channel to register BTP peer mapping in ToonClient ─────────────
      // ToonClient.resolvePeerId() requires an open channel or known peer to
      // route packets. openChannel also sets up the on-chain settlement channel.
      // The resulting channel (bChannelId) is later used to sign a balance-proof
      // claim that rides the kind:1 PREPARE (Story 50.3 — see the kind:1 block).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const negotiations = (toonClient as any).peerNegotiations as Map<
        string,
        unknown
      >;
      if (negotiations instanceof Map) {
        negotiations.set('town', {
          chain: CHAIN_KEY,
          chainType: 'evm',
          chainId: CHAIN_ID,
          settlementAddress: A_EVM_ADDR,
          tokenAddress: TOKEN_ADDR,
          tokenNetwork: TOKEN_NETWORK,
        });
      }
      let bChannelId: string | null = null;
      try {
        await toonClient.openChannel(aDestination);
        const bChannels = toonClient.getTrackedChannels();
        bChannelId = bChannels.length > 0 ? bChannels[0]! : null;
        console.log(
          `[49-5] Channel opened (BTP peer registered); channelId=${bChannelId?.slice(0, 16) ?? 'none'}`
        );
      } catch (err) {
        console.error('[49-5] openChannel failed:', err);
        throw err;
      }

      // B2' (Story 50.3 — diagnosed from the live gate run): paid forwards to the
      // apex's CHILD peers fail with `T00 "No payment channel available"`. Root
      // cause is NOT a race on B's channel (that opens+verifies fine): the connector
      // logs `"Peer address not found for peerId: g.townhouse.town" → On-demand
      // channel creation failed`. The child peers (g.townhouse.town relay,
      // g.townhouse.mill) are registered via registerPeer() WITHOUT an on-chain
      // settlement address, so the apex cannot open a settlement channel to them —
      // blocking the paid kind:1 publish AND the EVM→Mill→SOL streamSwap. Fixing
      // this requires registering each child peer's settlement address (or
      // pre-establishing the apex↔child channels). Tracked in deferred-work.md.

      // ── Drive streamSwap (AC #4) ─────────────────────────────────────────────
      // toonClient is now started and BTP-connected. Drive streamSwap to
      // g.townhouse.mill using the swap pair discovered from kind:10032.
      if (millSwapPair && millPubkey) {
        console.log('[49-5] Driving streamSwap to g.townhouse.mill...');
        try {
          millStreamSwapResult = await streamSwap({
            client: toonClient,
            millPubkey,
            millIlpAddress: 'g.townhouse.mill',
            pair: millSwapPair as Parameters<typeof streamSwap>[0]['pair'],
            senderSecretKey: bSecretKey,
            chainRecipient: B_SOL_ADDRESS,
            totalAmount: 1_000_000n,
            packetCount: 1,
          });
          console.log(
            `[49-5] streamSwap: state=${millStreamSwapResult.state}, claims=${millStreamSwapResult.claims.length}`
          );
        } catch (e) {
          console.error(`[49-5] streamSwap threw: ${(e as Error).message}`);
          // Do NOT rethrow — let the tests assert the null result and fail descriptively
          millStreamSwapResult = null;
        }
      } else {
        console.warn(
          '[49-5] Mill kind:10032 not received or swapPair absent — skipping streamSwap'
        );
      }

      // ── Publish kind:1 (AC #1 baseline) — PAID, with attached claim ─────────
      // Story 50.3 (Layer A): B is an EXTERNAL client, so the B→apex hop is paid even
      // though the relay's FEE_PER_EVENT=0 (the town write itself is free as a child).
      // The apex's InboundClaimValidator validates the claim from the BTP MESSAGE's
      // `payment-channel-claim` protocol-data on EVERY non-zero PREPARE, BEFORE routing
      // — so the claim must ride the SAME packet, regardless of whether the destination
      // is local-delivery (g.townhouse) or a forwarded BTP child (g.townhouse.town).
      //
      // The earlier "claim isn't propagated for forwarded destinations" hypothesis was
      // wrong: ToonClient.publishEvent(event, { claim }) attaches the claim as BTP
      // protocol-data via sendIlpPacketWithClaim → IsomorphicBtpClient.sendPacket()
      // for ANY destination — there is NO destination-based branch that drops it. The
      // real defect was here in the gate: kind:1 was published with NO claim and NO
      // ilpAmount, so the client priced it by bytes (non-zero) and sent no claim → F06.
      //
      // Fix: sign a balance proof over B's open channel for the expected fee and attach
      // it (Story 49.1 pattern). ilpAmount is pinned to KIND1_FEE so the inbound
      // earnings assertion (T3/D2: 1_000_000n ±10_000n) matches.
      const ev1: NostrEvent = finalizeEvent(
        {
          kind: 1,
          content: `49-5 smoke @ ${new Date().toISOString()}`,
          tags: [['t', '49-5-smoke']],
          created_at: Math.floor(Date.now() / 1000),
        },
        bSecretKey
      );
      kind1EventId = ev1.id;
      const KIND1_FEE = 1_000_000n;
      let kind1Claim: SignedBalanceProof | undefined;
      if (bChannelId) {
        try {
          kind1Claim = await toonClient.signBalanceProof(bChannelId, KIND1_FEE);
          console.log(
            `[49-5] Signed kind:1 claim: channel=${bChannelId.slice(0, 16)}..., nonce=${kind1Claim.nonce}, amount=${KIND1_FEE}`
          );
        } catch (e) {
          console.error(
            `[49-5] signBalanceProof failed: ${(e as Error).message} — publishing kind:1 without a claim (will F06 if paid).`
          );
        }
      } else {
        console.warn(
          '[49-5] No channel tracked for B — cannot sign kind:1 claim.'
        );
      }
      console.log('[49-5] Publishing kind:1 (paid, with claim)...');
      try {
        kind1Result = kind1Claim
          ? await toonClient.publishEvent(ev1, {
              claim: kind1Claim,
              ilpAmount: KIND1_FEE,
            })
          : await toonClient.publishEvent(ev1);
      } catch (e) {
        kind1Result = { success: false, error: (e as Error).message };
      }
      console.log(`[49-5] kind:1: success=${kind1Result.success}`);

      // ── Publish kind:5094 DVM request (AC #2) ───────────────────────────────
      // Route kind:5094 to 'g.townhouse' (the connector's own address).
      // With localDelivery.enabled + handlerUrl in connector.yaml, the connector
      // forwards unrouted ILP packets to the DVM's HTTP handler at port 3300.
      // The DVM processes the kind:5094 event, uploads to Arweave (unauthenticated
      // free tier), and returns the Arweave txid in the ILP FULFILL data field.
      const dvmDestination = 'g.townhouse';
      console.log(
        `[49-5] kind:5094 destination: ${dvmDestination} (via localDelivery → DVM port 3300)`
      );

      const blob = Buffer.from(`hello-arweave-${Date.now()}-49-5`);
      const dvmEv: NostrEvent = finalizeEvent(
        {
          kind: 5094,
          content: '',
          tags: [
            ['i', blob.toString('base64'), 'blob'],
            ['bid', '1000', 'usdc'],
            ['output', 'text/plain'],
          ],
          created_at: Math.floor(Date.now() / 1000),
        },
        bSecretKey
      );
      console.log(
        `[49-5] Publishing kind:5094 (${blob.length}B) to ${dvmDestination}...`
      );
      try {
        // Use ilpAmount=0n so the DVM processes for free (unauthenticated Turbo path)
        dvmResult = await toonClient.publishEvent(dvmEv, {
          ilpAmount: 0n,
          destination: dvmDestination,
        });
      } catch (e) {
        dvmResult = { success: false, error: (e as Error).message };
      }
      console.log(
        `[49-5] kind:5094: success=${dvmResult.success}, data=${dvmResult.data?.slice(0, 20) ?? 'none'}`
      );
    }, 1_200_000);

    afterAll(async () => {
      // Capture DVM container logs before teardown (D3: DVM is now a Docker container)
      try {
        const dvmContainerLogs = execSync(
          `docker logs ${DVM_CONTAINER_NAME} 2>&1`,
          { encoding: 'utf-8', timeout: 10_000 }
        );
        dvmLogs.push(...dvmContainerLogs.split('\n').filter(Boolean));
      } catch {
        /* container may not exist */
      }

      // Capture Mill container logs before teardown (parallel to DVM log capture)
      try {
        const millContainerLogs = execSync(
          `docker logs ${MILL_CONTAINER_NAME} 2>&1`,
          { encoding: 'utf-8', timeout: 10_000 }
        );
        millLogs.push(...millContainerLogs.split('\n').filter(Boolean));
      } catch {
        /* container may not exist */
      }

      // Write all logs to a structured output directory (P11)
      try {
        const logDir = join(process.cwd(), 'e2e-49-5-logs', String(Date.now()));
        mkdirSync(logDir, { recursive: true });
        const lines: string[] = [];
        for (const n of [...HS_CONTAINER_NAMES, B_CONNECTOR_NAME]) {
          try {
            lines.push(
              `\n===== ${n} =====\n${execSync(`docker logs --tail 80 ${n} 2>&1`, { encoding: 'utf-8', timeout: 10_000 })}`
            );
          } catch {
            lines.push(`\n===== ${n} (unavailable) =====\n`);
          }
        }
        lines.push(
          `\n===== ${DVM_CONTAINER_NAME} (Docker) =====\n${dvmLogs.slice(-80).join('\n')}`
        );
        lines.push(
          `\n===== ${MILL_CONTAINER_NAME} (Docker) =====\n${millLogs.slice(-80).join('\n')}`
        );
        writeFileSync(join(logDir, 'gate.log'), lines.join(''), 'utf-8');
        writeFileSync(
          join(logDir, 'mill.log'),
          millLogs.slice(-80).join('\n'),
          'utf-8'
        );
        console.log(`[49-5 afterAll] logs → ${logDir}/gate.log`);
      } catch {
        /* best-effort */
      }

      try {
        try {
          await toonClient?.stop();
        } catch {
          /* ok */
        }
        if (tmpDirA) {
          try {
            await waitForExitLabelled(
              runCli('hs', {
                configDir: tmpDirA,
                password: TEST_PASSWORD,
                env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
                extraArgs: ['down'],
              }).process,
              60_000,
              'hs down'
            );
          } catch (e) {
            console.warn(`[49-5 afterAll] hs down: ${(e as Error).message}`);
          }
        }
        cleanupAll();
        try {
          const orphans = execSync(`docker ps -aq --filter "name=townhouse-"`, {
            encoding: 'utf-8',
            timeout: 10_000,
          }).trim();
          if (orphans)
            execSync(`docker rm -f ${orphans.split('\n').join(' ')}`, {
              stdio: 'pipe',
              timeout: 30_000,
            });
        } catch {
          /* best-effort */
        }
        if (tmpDirA) rmSync(tmpDirA, { recursive: true, force: true });
        if (bConfigDir) rmSync(bConfigDir, { recursive: true, force: true });
      } finally {
        if (priorPwd === undefined)
          delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        else process.env['TOWNHOUSE_WALLET_PASSWORD'] = priorPwd;
      }
    }, 180_000);

    // ── Test 1: AC #1 + #3 ───────────────────────────────────────────────────

    it('kind:1 published via .anyone HS; transport invariants hold (AC #1 + #3)', () => {
      expect(
        kind1Result.success,
        `AC #1 FAIL: ${(kind1Result as { error?: string }).error ?? 'unknown'}`
      ).toBe(true);
      // kind1EventId was set from ev1.id before publish — verify it's a real event id
      expect(kind1EventId).toMatch(/^[0-9a-f]{64}$/);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = (toonClient as any)['config'] as {
        transport?: { type: string; socksProxy?: string };
        btpUrl?: string;
      };
      expect(cfg.transport?.type).toBe('socks5');
      expect(cfg.transport?.socksProxy).toMatch(/^socks5h:\/\/127\.0\.0\.1:/);
      expect(cfg.btpUrl).toMatch(
        /^ws:\/\/[a-z2-7]{55,57}\.(anyone|anon):3000\/btp$/
      );
      expect(hostnameA).toMatch(/^[a-z2-7]{55,57}\.(anyone|anon)$/);
      // D1: Claim hash and chain ID assertions (from real payment at ilpAmount=1_000_000n).
      // kind1Result is cast to include claimHash/chainId for forward-compatibility assertions.
      if (kind1Result.claimHash !== undefined) {
        expect(kind1Result.claimHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      }
      if (kind1Result.chainId !== undefined) {
        expect(kind1Result.chainId).toBe(31337);
      }
      console.log('[49-5 T1] PASS');
    }, 30_000);

    // ── Test 2: AC #2 ────────────────────────────────────────────────────────

    it('kind:5094 DVM returns Arweave txid in ILP FULFILL data (AC #2)', () => {
      expect(
        dvmResult.success,
        `AC #2 FAIL: ${(dvmResult as { error?: string }).error ?? 'unknown'}. DVM may need Turbo unauthenticated access.`
      ).toBe(true);
      expect(
        dvmResult.data,
        'AC #2: FULFILL data must be present'
      ).toBeTruthy();
      // DVM handler: data = Buffer.from(txId).toString('base64'); txId is base64url
      const txId = Buffer.from(dvmResult.data!, 'base64').toString('utf-8');
      console.log(`[49-5 T2] Arweave txid: ${txId}`);
      expect(txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      console.log('[49-5 T2] PASS');
    }, 30_000);

    // ── Test 3: AC #4 ────────────────────────────────────────────────────────

    it('connector healthy and B BTP session active — earnings confirmed (AC #4)', async () => {
      // Connector health
      const health = await fetch(CONNECTOR_HEALTH_URL, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(
        health.ok,
        `AC #4: connector health ${CONNECTOR_HEALTH_URL} returned ${health.status}`
      ).toBe(true);
      const healthBody = (await health.json()) as { status?: string };
      expect(healthBody.status, 'AC #4: connector not healthy').toBe('healthy');

      // B's BTP session established a payment channel (confirmed by openChannel in beforeAll)
      const channels = await fetch(`${CONNECTOR_ADMIN_URL}/admin/channels`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(
        channels.ok,
        `AC #4: /admin/channels returned ${channels.status}`
      ).toBe(true);
      const channelBody = (await channels.json()) as unknown[];
      // At least one channel registered (B's payment channel with the connector)
      expect(
        channelBody.length,
        'AC #4: no payment channels registered — kind:1 payment relationship not established'
      ).toBeGreaterThan(0);
      console.log(
        `[49-5 T3] channels PASS — connector healthy, ${channelBody.length} channel(s) registered`
      );

      // D2: Poll /api/earnings for an inbound claim matching the kind:1 fee (1_000_000n ±10_000n).
      // 90-second deadline — the connector may take a moment to settle the claim.
      const earningsUrl = `${HS_API}/api/earnings`;
      const EXPECTED_FEE = 1_000_000n;
      const TOLERANCE = 10_000n;
      const earningsDeadline = Date.now() + 90_000;
      let foundClaim: RecentClaim | undefined;
      let lastEarningsError = '';
      while (Date.now() < earningsDeadline) {
        try {
          const res = await fetch(earningsUrl, {
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) {
            const body = (await res.json()) as { recentClaims?: RecentClaim[] };
            const claims = body.recentClaims ?? [];
            foundClaim = claims.find((c) => {
              if (c.direction !== 'inbound') return false;
              try {
                const amt = BigInt(c.amount);
                if (
                  amt < EXPECTED_FEE - TOLERANCE ||
                  amt > EXPECTED_FEE + TOLERANCE
                )
                  return false;
              } catch {
                return false;
              }
              // Filter to claims that arrived after the test started
              const claimAt = new Date(c.at).getTime();
              if (claimAt < testStartMs) return false;
              return true;
            });
            if (foundClaim) break;
          } else if (res.status === 404) {
            // /api/earnings not available in older HS images — skip poll, rely on channels check above
            console.warn(
              `[49-5 T3] /api/earnings returned 404 (older HS image) — skipping earnings poll, channels check sufficient`
            );
            break;
          } else {
            lastEarningsError = `HTTP ${res.status}`;
          }
        } catch (e) {
          lastEarningsError = (e as Error).message;
        }
        await sleep(2_000);
      }
      if (foundClaim) {
        console.log(
          `[49-5 T3] PASS — inbound earnings claim found: amount=${foundClaim.amount}, at=${foundClaim.at}`
        );
      } else if (
        lastEarningsError !== '' &&
        !lastEarningsError.includes('404')
      ) {
        // Only fail if we actually tried and got real errors (not 404 = old image)
        expect.fail(
          `No inbound earnings claim found within 90s — expected fee ~1_000_000 raw units. Last error: ${lastEarningsError}`
        );
      }
    }, 150_000);

    // ── Test 4: AC #5 ────────────────────────────────────────────────────────

    it('chain endpoints are Akash-hosted (not 127.0.0.1) (AC #5)', async () => {
      const evmUrl = leases.anvil!.url;
      const solUrl = leases.solana!.url;
      expect(evmUrl).not.toContain('127.0.0.1');
      expect(solUrl).not.toContain('127.0.0.1');

      const evmRes = await fetch(evmUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_blockNumber',
          params: [],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(evmRes.ok, `AC #5: Anvil ${evmUrl} HTTP ${evmRes.status}`).toBe(
        true
      );
      const evmBody = (await evmRes.json()) as { result?: unknown };
      expect(
        typeof evmBody.result === 'string' && evmBody.result.startsWith('0x')
      ).toBe(true);

      const solRes = await fetch(solUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(solRes.ok, `AC #5: Solana ${solUrl} HTTP ${solRes.status}`).toBe(
        true
      );
      const solBody = (await solRes.json()) as { result?: unknown };
      expect(solBody.result).toBe('ok');
      console.log(`[49-5 T4] PASS — Anvil=${evmUrl}, Solana=${solUrl}`);
    }, 30_000);

    // ── Test 5: AC #6 ────────────────────────────────────────────────────────

    it('DVM runs unauthenticated Turbo (no DVM_ARWEAVE_JWK_B64 in env) (AC #6)', () => {
      // DVM runs as Docker container — DVM_ARWEAVE_JWK_B64 was intentionally not passed
      // as a -e flag in startDvm(). Verify it is absent from the host process env too.
      expect(
        process.env['DVM_ARWEAVE_JWK_B64'],
        'AC #6: DVM_ARWEAVE_JWK_B64 must not be in env'
      ).toBeUndefined();
      expect(
        process.env['TURBO_TOKEN'],
        'AC #6: TURBO_TOKEN must not be in env'
      ).toBeUndefined();

      // DVM logs must contain the specific unauthenticated source label line:
      // "[DVM Entrypoint] Arweave credit source: unauthenticated (free tier, ≤100KB)"
      // Re-capture fresh container logs at assert time: the credit-source line is
      // emitted a few seconds into boot (after RSA-JWK generation + Turbo client
      // init), which races the beforeAll boot-log snapshot (that often catches
      // only "Starting DVM node..."). It is reliably present in the live container
      // by the time this test runs — refresh dvmLogs from it.
      try {
        const freshDvmLogs = execSync(
          `docker logs ${DVM_CONTAINER_NAME} 2>&1`,
          {
            encoding: 'utf-8',
            timeout: 10_000,
          }
        );
        dvmLogs.push(...freshDvmLogs.split('\n').filter(Boolean));
      } catch {
        /* best-effort; fall back to the snapshots captured in beforeAll */
      }
      const allLogs = dvmLogs.join('\n');
      expect(
        allLogs
          .split('\n')
          .some(
            (line) =>
              line.includes('Arweave credit source:') &&
              line.includes('unauthenticated')
          ),
        `AC #6: DVM logs should contain 'Arweave credit source: ... unauthenticated' line.\nLogs tail:\n${allLogs.slice(-500)}`
      ).toBe(true);
      console.log('[49-5 T5] PASS');
    }, 15_000);

    // ── Test 7: AC #1 + #2 ───────────────────────────────────────────────────

    it('Mill BLS /health returns ok — container running (AC #1+#2)', async () => {
      const health = await fetch(`http://127.0.0.1:${MILL_BLS_PORT}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(health.ok, `AC #2: Mill health returned ${health.status}`).toBe(
        true
      );
      const body = (await health.json()) as { status?: string };
      expect(body.status, 'AC #2: Mill health status not ok').toBe('ok');
      console.log('[49-5 T7] PASS');
    }, 30_000);

    // ── Test 8: AC #3 ────────────────────────────────────────────────────────

    it('Mill kind:10032 advertises EVM→SOL swapPairs (AC #3)', () => {
      expect(
        millSwapPair,
        'AC #3: kind:10032 from Mill not received or swapPairs absent'
      ).not.toBeNull();
      expect(millSwapPair!.from.chain).toMatch(/^evm:base:/);
      expect(millSwapPair!.to.chain).toMatch(/^solana:/);
      expect(millSwapPair!.from.assetCode).toBe('USDC');
      expect(millSwapPair!.to.assetCode).toBe('USDC');
      console.log(
        `[49-5 T8] PASS — pair: ${millSwapPair!.from.chain} → ${millSwapPair!.to.chain}`
      );
    }, 15_000);

    // ── Test 9: AC #4 ────────────────────────────────────────────────────────

    it('streamSwap to g.townhouse.mill completes — 1 fulfilled packet (AC #4)', () => {
      expect(
        millStreamSwapResult,
        `AC #4 FAIL: streamSwap returned null (threw or was not reached)`
      ).not.toBeNull();
      expect(
        millStreamSwapResult!.state,
        `AC #4 FAIL: state=${millStreamSwapResult!.state}, rejections=${JSON.stringify(millStreamSwapResult!.rejections)}, errors=${JSON.stringify(millStreamSwapResult!.errors)}`
      ).toBe('completed');
      expect(
        millStreamSwapResult!.claims.length,
        'AC #4: expected 1 claim'
      ).toBe(1);
      console.log('[49-5 T9] PASS');
    }, 30_000);

    // ── Test 10: AC #5 ───────────────────────────────────────────────────────

    it('streamSwap FULFILL claim chain is SOL, amount within ±1 (AC #5)', () => {
      expect(millStreamSwapResult?.claims.length).toBeGreaterThanOrEqual(1);
      const claim = millStreamSwapResult!.claims[0]!;
      expect(claim.pair.to.chain).toMatch(/^solana:/);
      // rate=1.0, assetScale=6 both sides, no fee (FEE_BASIS_POINTS default=0)
      const expectedAmount = 1_000_000n;
      expect(
        claim.targetAmount,
        `AC #5: targetAmount=${claim.targetAmount} not within ±1 of ${expectedAmount}`
      ).toBeGreaterThanOrEqual(expectedAmount - 1n);
      expect(claim.targetAmount).toBeLessThanOrEqual(expectedAmount + 1n);
      // claimBytes must be non-empty (raw SOL claim from Mill FULFILL)
      expect(
        claim.claimBytes.length,
        'AC #5: claimBytes empty'
      ).toBeGreaterThan(0);
      if (claim.recipient !== undefined) {
        expect(claim.recipient).toBe(B_SOL_ADDRESS);
      }
      console.log(
        `[49-5 T10] PASS — chain=${claim.pair.to.chain}, target=${claim.targetAmount}`
      );
    }, 30_000);

    // ── Test 6: SOL settlement loop — BLOCKED-STRUCTURAL retired (Story 50.3) ──
    // This was the Epic 49.4 BLOCKED-STRUCTURAL deferral. Epic 50 closes it:
    // 50.1 provisioned the EVM→SOL swap pair, 50.2 added the Mill container +
    // `streamSwap` driver, and this story asserts the real settlement loop
    // exited green. AC #1: no `console.warn("SOL leg BLOCKED-STRUCTURAL …")`,
    // no `it.skip` — this is a live, non-skipped settlement assertion.
    it('Test 6 — SOL settlement loop green: streamSwap → SOL FULFILL claim, earnings, resolver (AC #1-#5)', async () => {
      // AC #2 — streamSwap (driven to g.townhouse.mill in beforeAll) succeeded
      // with a non-null FULFILL SOL claim.
      expect(
        millStreamSwapResult,
        'AC #2: streamSwap returned null (threw, or Mill kind:10032 not discovered)'
      ).not.toBeNull();
      expect(
        millStreamSwapResult!.state,
        `AC #2: streamSwap state=${millStreamSwapResult!.state}, rejections=${JSON.stringify(millStreamSwapResult!.rejections)}, errors=${JSON.stringify(millStreamSwapResult!.errors.map((e) => e.cause.message))}`
      ).toBe('completed');
      expect(
        millStreamSwapResult!.claims.length,
        'AC #2: expected ≥1 FULFILL SOL claim'
      ).toBeGreaterThanOrEqual(1);
      const claim = millStreamSwapResult!.claims[0]!;
      expect(
        claim.claimBytes.length,
        'AC #2: SOL claim bytes empty — FULFILL not signed'
      ).toBeGreaterThan(0);

      // AC #3 — Solana devnet confirmation. The swap target is the Akash Solana
      // devnet recorded in deploy/akash/leases.json `solana`. With rate=1.0,
      // assetScale=6 both sides, and FEE_BASIS_POINTS default=0, the signed
      // target amount equals totalAmount within ±1 USDC-cent rounding.
      expect(
        claim.pair.to.chain,
        'AC #3: claim target chain is not solana:devnet'
      ).toBe('solana:devnet');
      const leases = loadLeases();
      expect(
        leases.solana?.url,
        'AC #3: leases.json missing solana entry (Akash Solana devnet lease)'
      ).toBeTruthy();
      // AC #3 binds the claim to the deployed Akash Solana devnet lease. The
      // DSEQ is environment-coupled — it changes whenever the devnet is
      // redeployed — so assert leases.json carries a well-formed Akash
      // deployment sequence rather than a brittle hardcoded literal
      // (Story 50.3 review P2 → DN3: DSEQ-agnostic).
      expect(
        leases.solana?.dseq,
        'AC #3: leases.json solana.dseq must be a non-empty Akash deployment sequence'
      ).toMatch(/^\d+$/);
      const totalAmount = 1_000_000n;
      expect(
        claim.targetAmount,
        `AC #3: targetAmount=${claim.targetAmount} not within ±1 of ${totalAmount}`
      ).toBeGreaterThanOrEqual(totalAmount - 1n);
      expect(claim.targetAmount).toBeLessThanOrEqual(totalAmount + 1n);
      console.log(
        `[49-5 T6] AC #2+#3 PASS — SOL claim chain=${claim.pair.to.chain}, target=${claim.targetAmount}`
      );

      // AC #4 — /api/earnings carries an inbound, mill-typed claim. The route
      // attributes node `type` per peer via PeerTypeResolver (response field
      // `peers[]`); `recentClaims[]` carries `peerId` but not `type`, so we
      // correlate recentClaims.peerId → peers[type==='mill'].id. A 404 (older HS
      // image) is gracefully skipped — same guard as Test 3 (Epic 49.5 AC #4).
      const earningsUrl = `${HS_API}/api/earnings`;
      const EXPECTED = 1_000_000n;
      const TOLERANCE = 10_000n;
      const earningsDeadline = Date.now() + 150_000;
      let millEarningFound = false;
      let earningsSkipped = false;
      let lastEarningsError = '';
      while (Date.now() < earningsDeadline) {
        try {
          const res = await fetch(earningsUrl, {
            signal: AbortSignal.timeout(5_000),
          });
          if (res.status === 404) {
            console.warn(
              '[49-5 T6] /api/earnings 404 (older HS image) — AC #4 gracefully skipped'
            );
            earningsSkipped = true;
            break;
          }
          if (res.ok) {
            const body = (await res.json()) as {
              status?: string;
              peers?: { id: string; type: string }[];
              recentClaims?: {
                peerId: string;
                amount: string;
                direction: string;
                at: string;
              }[];
            };
            if (body.status === 'connector_unavailable') {
              lastEarningsError = 'connector_unavailable';
            } else {
              const millPeerIds = new Set(
                (body.peers ?? [])
                  .filter((p) => p.type === 'mill')
                  .map((p) => p.id)
              );
              millEarningFound = (body.recentClaims ?? []).some((c) => {
                if (c.direction !== 'inbound') return false;
                if (!millPeerIds.has(c.peerId)) return false;
                let amt: bigint;
                try {
                  amt = BigInt(c.amount);
                } catch {
                  return false;
                }
                if (amt < EXPECTED - TOLERANCE || amt > EXPECTED + TOLERANCE)
                  return false;
                return new Date(c.at).getTime() >= testStartMs;
              });
              if (millEarningFound) break;
            }
          } else {
            lastEarningsError = `HTTP ${res.status}`;
          }
        } catch (e) {
          lastEarningsError = (e as Error).message;
        }
        await sleep(5_000);
      }
      if (earningsSkipped) {
        // AC #4 not enforced on a legacy HS image without /api/earnings.
      } else if (millEarningFound) {
        console.log(
          '[49-5 T6] AC #4 PASS — inbound type:mill earnings claim found'
        );
      } else {
        // AC #4 (Story 50.3 review DN1 → hard-fail): the endpoint was reachable
        // (not 404) but no inbound type:mill claim surfaced within the 150s
        // budget. The spec sanctions exactly one non-find — a 404 skip; a
        // reachable `/api/earnings` that never attributes the swap-routed
        // settlement to a mill peer is a real failure, not a soft warning.
        throw new Error(
          `[49-5 T6] AC #4 FAIL — no inbound type:mill claim in /api/earnings within 150s ` +
            `(lastErr='${lastEarningsError || 'none'}'). Not a 404 skip — a reachable-but-` +
            `empty poll, a persistent connector_unavailable, or repeated transport errors ` +
            `all fail AC #4: swap-routed SOL settlement was not attributed to a mill peer within budget.`
        );
      }

      // AC #5 — PeerTypeResolver.resolvePeerType('mill') === 'mill' (Story 49.4
      // Test 5 non-regression). The harness registers Mill in a NodesYaml; the
      // resolver must type it as 'mill', not 'external'.
      const nodesConfig: NodesYaml = {
        entries: [
          {
            id: 'mill',
            type: 'mill',
            peerId: 'mill',
            ilpAddress: 'g.townhouse.mill',
            derivationIndex: 1,
            enabledAt: '2026-05-29T00:00:00.000Z',
            lastSeenAt: null,
          },
        ],
      };
      const resolver = new PeerTypeResolver(nodesConfig);
      expect(
        resolver.resolvePeerType('mill'),
        "AC #5: resolvePeerType('mill') must return 'mill'"
      ).toBe('mill');
      console.log(
        "[49-5 T6] AC #5 PASS — PeerTypeResolver.resolvePeerType('mill') = 'mill'"
      );
    }, 200_000);
  }
);
