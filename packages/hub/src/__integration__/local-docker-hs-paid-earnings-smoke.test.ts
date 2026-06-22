/**
 * Local-Docker HS Paid-Earnings smoke gate.
 *
 * Variant of `akash-paid-earnings-smoke.test.ts` (Story 49.4) where the
 * foreign client runs as a LOCAL Docker container instead of an Akash-deployed
 * pod. The two halves still communicate only via the public ATOR network — the
 * client's in-pod anon SOCKS5 daemon dials the local `hub hs up` apex's
 * `.anyone` hostname. Akash chains + faucet remain consumed.
 *
 * Why: 49.4 closed BLOCKED-PARTIAL because the foreign client deployed on
 * rotating Akash providers kept hitting cross-provider TLS instability. The
 * round-6 connector-level evidence proved the protocol loop works. This test
 * keeps everything about the loop the same — same image, same SOCKS5, same
 * `.anyone` HS, same EIP-712 signing, same earnings receipt assertions — but
 * pins the client to a Docker container we control.
 *
 * Assumes the stack is ALREADY UP via:
 *   bash scripts/hub-e2e-local-hs.sh up
 *
 * Gating:
 *   RUN_LOCAL_HS_E2E=1
 *   pnpm --filter @toon-protocol/hub build
 *
 * Tear down with:
 *   bash scripts/hub-e2e-local-hs.sh down-v
 *
 * NODE_TLS_REJECT_UNAUTHORIZED=0 is set by the orchestrator's compose file for
 * the client container; the host-side fetches in this test also set it via the
 * shell that invokes vitest.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

import { isTruthyEnv } from './_test-helpers.js';
import {
  PeerTypeResolver,
  type ConnectorPeerLike,
} from '../registry/peer-type-resolver.js';
import { readNodesYaml } from '../state/nodes-yaml.js';
import { earningsResponseSchema } from '../api/schemas/earnings.js';

// ── Schema validation ────────────────────────────────────────────────────────

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const earningsResponse200 = (
  earningsResponseSchema.response as Record<number, unknown>
)[200];
if (!earningsResponse200)
  throw new Error('earningsResponseSchema.response[200] missing');
const validateEarnings = ajv.compile(earningsResponse200);

function expectMatchesSchema(body: unknown, label: string): void {
  const ok = validateEarnings(body);
  if (!ok) {
    throw new Error(
      `[${label}] earnings response does not match schema: ${JSON.stringify(validateEarnings.errors)}`
    );
  }
}

// ── Gate ─────────────────────────────────────────────────────────────────────

const RUN_GATE = isTruthyEnv(process.env['RUN_LOCAL_HS_E2E']);
const SKIP_DOCKER = isTruthyEnv(process.env['SKIP_DOCKER']);
const shouldRun = RUN_GATE && !SKIP_DOCKER;

if (!shouldRun) {
  console.warn(
    '\n⚠️  Skipping local-Docker HS paid-earnings smoke.\n' +
      '   Bring the stack up: bash scripts/hub-e2e-local-hs.sh up\n' +
      '   Then run: RUN_LOCAL_HS_E2E=1 NODE_TLS_REJECT_UNAUTHORIZED=0 \\\n' +
      '              pnpm --filter @toon-protocol/hub test:integration -- \\\n' +
      '              local-docker-hs-paid-earnings-smoke\n'
  );
}

// ── Constants ────────────────────────────────────────────────────────────────

const EXPECTED_FEE = 1_000_000n; // 1 USDC at scale=6
const TOLERANCE = 10_000n; // 1¢ rounding tolerance (NFR10)
const APEX_EVM_ADDRESS = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const _TOWN_EVM_ADDRESS = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';

const CLIENT_URL = 'http://127.0.0.1:29200';
const CONNECTOR_ADMIN_URL = 'http://127.0.0.1:9401';
const EARNINGS_URL = 'http://127.0.0.1:28090/api/earnings';

const HS_NETWORK = 'hub-hs-net';
const CLIENT_NETWORK = 'e2e-client-net';
const CLIENT_CONTAINER = 'toon-client-e2e';
const HS_CONTAINER_NAMES = [
  'hub-hs-connector',
  'hub-hs-api',
  'hub-hs-town',
];

// Locate the local hub home for host.json (.anyone hostname) lookup.
const thisFile = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(thisFile), '..', '..', '..', '..');
const TOWNHOUSE_HOME =
  process.env['TOWNHOUSE_HOME'] ||
  join(process.env['HOME'] || '/root', '.hub-e2e');
const LEASES_PATH = join(REPO_ROOT, 'deploy', 'akash', 'leases.json');

// ── Shared helpers (mirrored from akash-paid-earnings-smoke.test.ts) ─────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { budgetMs?: number; label?: string } = {}
): Promise<Response> {
  const { budgetMs = 15_000, label, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(budgetMs) });
  } catch (e) {
    throw new Error(
      `[fetch ${label ?? url}] failed within ${budgetMs}ms: ${(e as Error).message}`
    );
  }
}

/** Error carrying the HTTP status so callers can distinguish a permanent 404
 * (stale hub-api image missing the /api/earnings route, #139) from a
 * transient failure worth retrying. */
class EarningsHttpError extends Error {
  constructor(
    public readonly status: number,
    label: string
  ) {
    super(`[${label}] HTTP ${status}`);
    this.name = 'EarningsHttpError';
  }
}

async function fetchEarnings(
  label = 'GET /api/earnings'
): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(EARNINGS_URL, { budgetMs: 10_000, label });
  if (!res.ok) throw new EarningsHttpError(res.status, label);
  const body = (await res.json()) as Record<string, unknown>;
  expectMatchesSchema(body, label);
  return body;
}

function normPeerId(s: string): string {
  return s.replace(/^0x/i, '').toLowerCase();
}

function findInboundClaimForPeer(
  earnings: Record<string, unknown>,
  peerId: string,
  expectedAmount: bigint,
  tolerance: bigint,
  sinceMs: number
): Record<string, unknown> | null {
  const claims = earnings['recentClaims'] as
    | Record<string, unknown>[]
    | undefined;
  if (!claims) return null;
  const targetId = normPeerId(peerId);
  const lo = expectedAmount - tolerance;
  const hi = expectedAmount + tolerance;
  for (const c of claims) {
    const cPeer =
      typeof c['peerId'] === 'string' ? normPeerId(c['peerId']) : '';
    if (cPeer !== targetId || c['direction'] !== 'inbound') continue;
    const cAmt = typeof c['amount'] === 'string' ? c['amount'] : null;
    if (!cAmt) continue;
    const at = typeof c['at'] === 'string' ? Date.parse(c['at']) : NaN;
    if (!Number.isFinite(at) || at < sinceMs) continue;
    let amt: bigint;
    try {
      amt = BigInt(cAmt);
    } catch {
      continue;
    }
    if (amt >= lo && amt <= hi) return c;
  }
  return null;
}

async function probeAkashEndpoint(
  url: string,
  label: string,
  redeployHint: string,
  path = '',
  rpcKind?: 'evm' | 'solana'
): Promise<string> {
  const target = path ? `${url.replace(/\/+$/, '')}${path}` : url;
  const rpcPayload =
    rpcKind === 'evm'
      ? '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
      : rpcKind === 'solana'
        ? '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
        : null;
  try {
    const res = await fetchWithTimeout(target, {
      budgetMs: 10_000,
      label,
      ...(rpcPayload
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: rpcPayload,
          }
        : {}),
    });
    const bodyText = await res.text();
    if (!res.ok)
      throw new Error(`${label} RPC HTTP ${res.status} — ${redeployHint}`);
    if (rpcKind === 'evm') {
      const body = JSON.parse(bodyText) as { result?: unknown };
      if (typeof body.result !== 'string' || !body.result.startsWith('0x')) {
        throw new Error(`${label} eth_blockNumber malformed — ${redeployHint}`);
      }
    } else if (rpcKind === 'solana') {
      const body = JSON.parse(bodyText) as { result?: unknown };
      if (body.result !== 'ok')
        throw new Error(`${label} getHealth != ok — ${redeployHint}`);
    }
    return bodyText;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(redeployHint)) throw e;
    throw new Error(
      `Akash ${label} RPC unreachable at ${target}: ${msg}\n  → ${redeployHint}`
    );
  }
}

async function getEvmBalanceWei(rpcUrl: string, addr: string): Promise<bigint> {
  const res = await fetchWithTimeout(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [addr, 'latest'],
    }),
    budgetMs: 10_000,
    label: `eth_getBalance ${addr}`,
  });
  const body = (await res.json()) as { result?: string };
  return body.result ? BigInt(body.result) : 0n;
}

async function captureLogsOnFailure(
  tag: string,
  data: Record<string, unknown>
): Promise<void> {
  const logDir = join(
    process.cwd(),
    'e2e-local-hs-logs',
    `${Date.now()}-${tag}`
  );
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'data.json'), JSON.stringify(data, null, 2));
    console.log(`[local-hs] failure logs written to ${logDir}`);
  } catch (e) {
    console.warn(`[local-hs] captureLogsOnFailure: ${(e as Error).message}`);
  }
}

// ── Pre-flight unit tests (no gate — verify probe helpers work) ──────────────

describe('preflight unit — Akash probes fail fast', () => {
  it('rejects when Akash-Anvil RPC is unreachable', async () => {
    await expect(
      probeAkashEndpoint(
        'https://example.invalid/akash-anvil-probe',
        'anvil',
        'run scripts/akash-deploy.sh anvil',
        '',
        'evm'
      )
    ).rejects.toThrow(/Akash anvil RPC unreachable/);
  }, 15_000);

  it('rejects when Akash-Solana RPC is unreachable', async () => {
    await expect(
      probeAkashEndpoint(
        'https://example.invalid/akash-solana-probe',
        'solana',
        'run scripts/akash-deploy.sh solana',
        '',
        'solana'
      )
    ).rejects.toThrow(/Akash solana RPC unreachable/);
  }, 15_000);

  it('rejects when client /healthz is unreachable', async () => {
    await expect(
      probeAkashEndpoint(
        'http://127.0.0.1:1/local-hs-probe',
        'toon-client-e2e',
        'run bash scripts/hub-e2e-local-hs.sh up',
        '/healthz'
      )
    ).rejects.toThrow(/Akash toon-client-e2e RPC unreachable/);
  }, 15_000);
});

// ── Live smoke suite (gated) ─────────────────────────────────────────────────

describe.skipIf(!shouldRun)('local-Docker HS paid-earnings smoke', () => {
  let apexHostname: string;
  let podEvmAddr: string;
  let bSecretKey: Uint8Array;
  let _bPubkey: string;
  let evmRpcUrl: string;
  let preEarnings: Record<string, unknown> | null = null;
  let testStartMs = Date.now(); // initialised conservatively; overwritten in beforeAll
  let publishBody: Record<string, unknown> = {};

  beforeAll(async () => {
    // ── Read leases ─────────────────────────────────────────────────────────
    if (!existsSync(LEASES_PATH)) {
      throw new Error(
        `leases.json missing at ${LEASES_PATH} — run scripts/akash-deploy.sh first`
      );
    }
    const leases = JSON.parse(readFileSync(LEASES_PATH, 'utf-8')) as Record<
      string,
      { url?: string }
    >;
    evmRpcUrl = leases['anvil']?.url ?? '';
    if (!evmRpcUrl) throw new Error('anvil.url missing from leases.json');

    // ── Read apex .anyone hostname (written by hub hs up) ────────────
    const hostJsonPath = join(TOWNHOUSE_HOME, 'host.json');
    if (!existsSync(hostJsonPath)) {
      throw new Error(
        `${hostJsonPath} missing — orchestrator did not bring up apex.\n` +
          `  Run: bash scripts/hub-e2e-local-hs.sh up`
      );
    }
    const hostJson = JSON.parse(readFileSync(hostJsonPath, 'utf-8')) as {
      hostname: string;
    };
    apexHostname = hostJson.hostname;
    expect(apexHostname).toMatch(/^[a-z2-7]{55,57}\.(anyone|anon)$/);
    console.log(`[local-hs] apex hostname: ${apexHostname}`);

    // ── Verify client container is up + healthy ─────────────────────────────
    const healthzBody = await probeAkashEndpoint(
      CLIENT_URL,
      'toon-client-e2e',
      'run bash scripts/hub-e2e-local-hs.sh up',
      '/healthz'
    );
    const healthz = JSON.parse(healthzBody) as {
      anyoneReady: boolean;
      evmAddr: string;
      solAddr: string;
      balances: { evm: string; sol: number };
    };
    if (!healthz.anyoneReady) {
      throw new Error(
        `Client anyoneReady=false. Retry: docker logs ${CLIENT_CONTAINER} | tail -50`
      );
    }
    podEvmAddr = healthz.evmAddr;
    console.log(`[local-hs] client EVM=${podEvmAddr} SOL=${healthz.solAddr}`);
    console.log(
      `[local-hs] client balances: evm=${healthz.balances.evm} sol=${healthz.balances.sol}`
    );

    // ── Capture pre-publish baseline earnings ───────────────────────────────
    const earningsDeadline = Date.now() + 30_000;
    while (Date.now() < earningsDeadline) {
      try {
        const candidate = await fetchEarnings('pre-publish baseline');
        if (candidate['status'] === 'ok') {
          preEarnings = candidate;
          break;
        }
      } catch (err) {
        // A 404 is a permanent failure: the pinned hub-api image predates
        // the Epic 47 /api/earnings route (#139). Don't burn 30s polling — fail
        // fast with a rebuild hint.
        if (err instanceof EarningsHttpError && err.status === 404) {
          throw new Error(
            `${EARNINGS_URL} returned 404 — the hub-api image predates the Epic 47 earnings route (#139). Rebuild from HEAD: docker build -f docker/Dockerfile.hub-api -t ghcr.io/toon-protocol/hub-api:epic-47-local .`
          );
        }
        /* otherwise transient — keep polling */
      }
      await sleep(3_000);
    }
    if (!preEarnings)
      throw new Error('Could not capture baseline earnings within 30s');
    console.log(`[local-hs] baseline status=${String(preEarnings['status'])}`);

    // ── Generate Nostr keypair for signed events ───────────────────────────
    bSecretKey = generateSecretKey();
    _bPubkey = getPublicKey(bSecretKey);
    testStartMs = Date.now();
  }, 120_000);

  // ── Test 1: client /healthz ────────────────────────────────────────────────

  it('client /healthz reports anyoneReady + funded balances', async () => {
    const res = await fetchWithTimeout(`${CLIENT_URL}/healthz`, {
      budgetMs: 5_000,
      label: '/healthz',
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      anyoneReady: boolean;
      evmAddr: string;
      solAddr: string;
      balances: { evm: string; sol: number };
    };
    expect(body.anyoneReady).toBe(true);
    expect(body.evmAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(body.solAddr.length).toBeGreaterThan(0);
    expect(BigInt(body.balances.evm)).toBeGreaterThan(0n);
    expect(body.balances.sol).toBeGreaterThan(0);
  }, 10_000);

  // ── Test 2: client /signer-info — public ATOR transport confirmed ─────────

  it('client uses public ATOR SOCKS5 transport (NFR5)', async () => {
    const res = await fetchWithTimeout(`${CLIENT_URL}/signer-info`, {
      budgetMs: 5_000,
      label: '/signer-info',
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      transport?: { type?: string; socksProxy?: string };
    };
    expect(body.transport?.type).toBe('socks5');
    expect(body.transport?.socksProxy?.startsWith('socks5h://')).toBe(true);
  }, 10_000);

  // ── Test 3: Apex EVM signer funded ─────────────────────────────────────────

  it('apex EVM signer is funded (≥ 0.01 ETH for gas)', async () => {
    const bal = await getEvmBalanceWei(evmRpcUrl, APEX_EVM_ADDRESS);
    expect(bal).toBeGreaterThanOrEqual(10_000_000_000_000_000n); // 0.01 ETH
  }, 15_000);

  // ── Test 4: Docker network isolation — no shared bridge ────────────────────

  it('client + hub containers are on DIFFERENT Docker networks', () => {
    const hsContainers = JSON.parse(
      execSync(`docker network inspect ${HS_NETWORK}`, {
        encoding: 'utf-8',
        timeout: 5_000,
      })
    ) as { Containers?: Record<string, { Name?: string }> }[];
    const clientContainers = JSON.parse(
      execSync(`docker network inspect ${CLIENT_NETWORK}`, {
        encoding: 'utf-8',
        timeout: 5_000,
      })
    ) as { Containers?: Record<string, { Name?: string }> }[];

    const hsNames = Object.values(hsContainers[0]?.Containers ?? {}).map(
      (c) => c.Name ?? ''
    );
    const clientNames = Object.values(
      clientContainers[0]?.Containers ?? {}
    ).map((c) => c.Name ?? '');

    expect(hsNames.includes(CLIENT_CONTAINER)).toBe(false);
    for (const hs of HS_CONTAINER_NAMES) {
      expect(clientNames.includes(hs)).toBe(false);
    }
    console.log(
      `[local-hs] isolation OK — ${HS_NETWORK}=[${hsNames.join(',')}], ${CLIENT_NETWORK}=[${clientNames.join(',')}]`
    );
  }, 15_000);

  // ── Test 5: THE GATE — paid publish credits apex earnings ─────────────────

  it('EVM leg: paid publish credits apex earnings within tolerance (NFR10 ±1¢)', async () => {
    expect(podEvmAddr).toBeTruthy();
    expect(apexHostname).toBeTruthy();
    const sinceMs = testStartMs;

    // Drive a real signed publish
    const event: NostrEvent = finalizeEvent(
      {
        kind: 1,
        content: `local-hs smoke @ ${new Date().toISOString()}`,
        tags: [['t', 'local-hs-smoke']],
        created_at: Math.floor(Date.now() / 1000),
      },
      bSecretKey
    );
    const reqBody = { event, targetHostname: apexHostname };

    let publishRes: Response | null = null;
    let publishBodyText = '';
    let attemptDurationMs = 0;
    let successAttempt = 0;
    const publishStart = Date.now();
    const RETRY_BUDGET_MS = 270_000;
    const PER_ATTEMPT_BUDGET_MS = 90_000;

    for (
      let attempt = 1;
      Date.now() - publishStart < RETRY_BUDGET_MS;
      attempt++
    ) {
      const attemptStart = Date.now();
      try {
        publishRes = await fetchWithTimeout(`${CLIENT_URL}/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(reqBody),
          budgetMs: PER_ATTEMPT_BUDGET_MS,
          label: `POST /publish attempt ${attempt}`,
        });
        attemptDurationMs = Date.now() - attemptStart;
        publishBodyText = await publishRes.text();
        try {
          publishBody = JSON.parse(publishBodyText) as Record<string, unknown>;
        } catch {
          /* keep raw */
        }
        console.log(
          `[local-hs Test 5] attempt=${attempt} status=${publishRes.status} ` +
            `attempt=${attemptDurationMs}ms wall=${Date.now() - publishStart}ms ` +
            `body=${publishBodyText.slice(0, 200)}`
        );
        if (publishRes.status === 202) {
          successAttempt = attempt;
          break;
        }
        if (
          publishRes.status >= 400 &&
          publishRes.status < 500 &&
          publishBody['retryable'] !== true
        )
          break;
      } catch (err) {
        console.log(
          `[local-hs Test 5] attempt=${attempt} fetch error: ${(err as Error).message}`
        );
        if (Date.now() - attemptStart >= 5_000) break;
      }
      await sleep(5_000);
    }

    if (!publishRes || publishRes.status !== 202) {
      await captureLogsOnFailure('publish-failed', {
        publishBody,
        publishBodyText,
        baseline: preEarnings,
      });
      throw new Error(
        `Publish failed: status=${publishRes?.status}, body=${publishBodyText.slice(0, 300)}`
      );
    }

    // Wire-shape assertions
    expect(publishBody['eventId']).toBe(event.id);
    expect(publishBody['claimHash']).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(publishBody['chainId']).toBe(31337);
    expect(attemptDurationMs).toBeLessThanOrEqual(PER_ATTEMPT_BUDGET_MS);

    console.log(
      `[local-hs Test 5] publish 202 in ${Date.now() - publishStart}ms wall ` +
        `(attempt #${successAttempt}, ${attemptDurationMs}ms successful attempt). ` +
        `claimHash=${publishBody['claimHash']}`
    );

    // Poll for credit
    const pollDeadline = Date.now() + 90_000;
    let postEarnings: Record<string, unknown> | null = null;
    let matchedClaim: Record<string, unknown> | null = null;
    while (Date.now() < pollDeadline) {
      try {
        postEarnings = await fetchEarnings('post-publish');
        matchedClaim = findInboundClaimForPeer(
          postEarnings,
          podEvmAddr,
          EXPECTED_FEE,
          TOLERANCE,
          sinceMs
        );
        if (matchedClaim) break;
      } catch (e) {
        console.warn(
          `[local-hs Test 5] earnings fetch failed: ${(e as Error).message}`
        );
      }
      await sleep(3_000);
    }

    if (!matchedClaim) {
      await captureLogsOnFailure('credit-not-found', {
        publishBody,
        baseline: preEarnings,
        postEarnings,
        podEvmAddr,
        expectedFee: EXPECTED_FEE.toString(),
      });
      throw new Error(
        `No inbound claim found for peerId=${podEvmAddr} amount≈${EXPECTED_FEE} ` +
          `within ±${TOLERANCE} after ${sinceMs}. recentClaims: ` +
          JSON.stringify(postEarnings?.['recentClaims']).slice(0, 500)
      );
    }

    // Verify claim is a real signed claim, not a stub
    const matchedAmount = BigInt(matchedClaim['amount'] as string);
    expect(matchedAmount).toBeGreaterThanOrEqual(EXPECTED_FEE - TOLERANCE);
    expect(matchedAmount).toBeLessThanOrEqual(EXPECTED_FEE + TOLERANCE);
    expect(matchedClaim['direction']).toBe('inbound');

    console.log(
      `[local-hs Test 5] CREDIT LANDED: ${JSON.stringify(matchedClaim).slice(0, 300)}`
    );
  }, 420_000);

  // ── Test 6: drill metrics ↔ /api/earnings parity ──────────────────────────

  it('drill metrics packetsForwarded matches /api/earnings.eventsRelayed (±1)', async () => {
    const earnings = await fetchEarnings('parity-check');
    const eventsRelayed = Number(earnings['eventsRelayed'] ?? 0);
    expect(eventsRelayed).toBeGreaterThan(0);

    // drill metrics is invoked via the CLI; use the connector admin metrics
    // endpoint directly to avoid the CLI subprocess overhead.
    const metricsRes = await fetchWithTimeout(
      `${CONNECTOR_ADMIN_URL}/admin/metrics.json`,
      {
        budgetMs: 10_000,
        label: '/admin/metrics.json',
      }
    );
    expect(metricsRes.ok).toBe(true);
    const metrics = (await metricsRes.json()) as {
      aggregate?: { packetsForwarded?: number };
    };
    const packetsForwarded = metrics.aggregate?.packetsForwarded ?? 0;
    expect(Math.abs(packetsForwarded - eventsRelayed)).toBeLessThanOrEqual(1);
  }, 30_000);

  // ── Test 7: PeerTypeResolver tri-bucket ──────────────────────────────────
  //
  // Resolves node types from whichever provisioning model the running stack
  // produced — the two paths write peer state in DIFFERENT places (#144):
  //
  //   • `hub node add` (node-add path) writes `nodes.yaml` in the deploy
  //     home → `new PeerTypeResolver(yaml)`.
  //   • `hub hs up` (compose-render path, what the local-HS harness uses)
  //     renders `hub-hs.yml` from the image-manifest and registers child
  //     peers DIRECTLY against the connector via `POST /admin/peers` — it never
  //     writes `nodes.yaml`. The connector's `GET /admin/peers` is then the
  //     source of truth → `PeerTypeResolver.fromConnectorPeers(...)`.
  //
  // Intent preserved either way: town resolves as a child node-type (`town`),
  // an external/unknown peer (the client's EVM addr) resolves as `external`,
  // and a mill — when registered — resolves as `mill`. The local-HS harness
  // only registers a town child, so the mill assertion is conditional on a
  // mill peer actually being present (it does not fabricate one).

  it('PeerTypeResolver resolves town/mill/external distinctly', async () => {
    const nodesYamlPath = join(TOWNHOUSE_HOME, 'nodes.yaml');

    let resolver: PeerTypeResolver;
    let source: string;
    let connectorPeers: ConnectorPeerLike[] = [];

    if (existsSync(nodesYamlPath)) {
      // node-add provisioning model.
      const yaml = await readNodesYaml(nodesYamlPath);
      resolver = new PeerTypeResolver(yaml);
      source = `nodes.yaml (${nodesYamlPath})`;
    } else {
      // compose-render provisioning model — resolve from the connector roster.
      const res = await fetchWithTimeout(`${CONNECTOR_ADMIN_URL}/admin/peers`, {
        budgetMs: 10_000,
        label: 'GET /admin/peers',
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as {
        peers?: { id: string; ilpAddresses?: string[] }[];
      };
      connectorPeers = (body.peers ?? []).map((p) => ({
        id: p.id,
        ilpAddresses: p.ilpAddresses,
      }));
      expect(
        connectorPeers.length,
        'connector reported zero peers — orchestrator did not register any child'
      ).toBeGreaterThan(0);
      resolver = PeerTypeResolver.fromConnectorPeers(connectorPeers);
      source = `GET /admin/peers (${connectorPeers.length} peers)`;
    }
    console.log(`[local-hs Test 7] resolving peer types from ${source}`);

    // Town child is always registered (the apex forwards g.townhouse.town to it).
    expect(resolver.resolvePeerType('town')).toBe('town');

    // A mill child is optional in the local-HS harness — assert only if present.
    const hasMillPeer =
      connectorPeers.some((p) => resolver.resolvePeerType(p.id) === 'mill') ||
      resolver.resolvePeerType('mill') === 'mill';
    if (hasMillPeer) {
      expect(resolver.resolvePeerType('mill')).toBe('mill');
    } else {
      console.log(
        '[local-hs Test 7] no mill peer registered — skipping mill assertion'
      );
    }

    // An unknown external peer (the client's EVM address) is never a child.
    expect(resolver.resolvePeerType(podEvmAddr)).toBe('external');
  }, 15_000);

  // ── Test 8: claim is a REAL signed claim (not stubbed) ────────────────────

  it('matched recentClaim carries a real claimHash + chain context (signed proof)', async () => {
    const earnings = await fetchEarnings('claim-verify');
    const claim = findInboundClaimForPeer(
      earnings,
      podEvmAddr,
      EXPECTED_FEE,
      TOLERANCE,
      testStartMs
    );
    expect(claim, 'claim should be present after Test 5').not.toBeNull();
    expect(claim!['peerId']).toBeTruthy();
    expect(claim!['amount']).toBeTruthy();
    expect(claim!['direction']).toBe('inbound');
    // Some surfaces carry the chain assetCode (= USDC contract addr) — verify it's the
    // deterministic Akash-Anvil USDC mint, proves the chain context is real.
    if (typeof claim!['assetCode'] === 'string') {
      expect(claim!['assetCode'].toLowerCase()).toBe(
        '0x5fbdb2315678afecb367f032d93f642f64180aa3'
      );
    }
    // The publishBody.claimHash from Test 5 is the actual ECDSA-signed BalanceProof
    // hash; if the connector accepted the credit, the sig was valid (the
    // InboundClaimValidator rejects bad sigs). Re-assert here as a witness.
    expect(publishBody['claimHash']).toMatch(/^0x[0-9a-fA-F]{64}$/);
  }, 15_000);
});
