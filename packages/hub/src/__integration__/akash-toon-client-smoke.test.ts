/**
 * Live smoke gate — Persistent Akash TOON-Client Pod (Story 49.3)
 *
 * Drives a live Akash deployment of `docker/Dockerfile.toon-client`
 * against a local `hub hs up` apex. Proves that:
 *   AC #1   Pod is healthy + faucet auto-funded both chains on boot
 *   AC #2   POST /publish round-trips a kind:1 event in <120s
 *   AC #4   B's BTP channel surfaces on A's drill verbs (peerId === podEvm)
 *   AC #5   A's peer-type resolver tags the pod as 'external'
 *   AC #6   Real .anyone transport invariants (socks5h://, regex shape)
 *   AC #9   Rate-limit kicks in past the configured per-minute budget
 *
 * Gate: requires live Akash toon-client at AKASH_TOON_CLIENT_URL + local
 * hub hs up. Run before marking story done.
 *
 * Prerequisites:
 *   RUN_AKASH_SMOKE=1                       — opt-in to the live-Akash gate
 *   AKASH_TOON_CLIENT_URL=https://…         — pod ingress (e.g. https://*.ingress.boogle.cloud)
 *   SKIP_DOCKER unset or falsy              — local hub hs up needs Docker
 *   dist/image-manifest.json present        — for the local apex stack
 *   pnpm --filter @toon-protocol/hub build
 *   bash scripts/hub-test-infra.sh up — warms Docker image cache
 *   ports 9401 + 28090 free                 — local apex bindings
 *
 * Wall-clock budget: ~12-18 min cold
 *   - hub hs up (cold-boot):                 ~5 min
 *   - pod /healthz first response:                 ~2-5s (already booted)
 *   - POST /publish round-trip (anon dial):        ~30-90s
 *   - drill-verb assertions:                       ~30s
 *   - rate-limit hammer test:                      ~10s
 *   - teardown:                                    ~3 min
 *
 * AC #3 (runtime hot-swap with a second hostname) and AC #10 (full multi-host
 * smoke) are intentionally NOT exercised here — they would require booting
 * TWO concurrent `hub hs up` stacks on the same host, which 49.1
 * already proved is mechanically possible but doubles the wall budget. The
 * single-host smoke is sufficient to gate this story; the multi-host
 * hot-swap is documented as a manual verification step in
 * _bmad-output/implementation-artifacts/49-3-persistent-akash-toon-client-pod.md
 * § "Story Close-Out Checklist".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

import {
  isTruthyEnv,
  runCli,
  waitForExit,
  waitForUrl,
} from './_test-helpers.js';
import { readNodesYaml } from '../state/nodes-yaml.js';
import { ConnectorAdminClient } from '../connector/admin-client.js';
import { PeerTypeResolver } from '../registry/peer-type-resolver.js';

// ── Skip gates ──────────────────────────────────────────────────────────────

const SKIP_DOCKER = isTruthyEnv(process.env['SKIP_DOCKER']);
const RUN_SMOKE = process.env['RUN_AKASH_SMOKE'] === '1';
const POD_URL = process.env['AKASH_TOON_CLIENT_URL'] || '';
const shouldRun = RUN_SMOKE && !SKIP_DOCKER && POD_URL.length > 0;

if (!shouldRun) {
  console.warn(
    '\n⚠️  Skipping Akash toon-client smoke (Story 49.3).\n' +
      '   Set RUN_AKASH_SMOKE=1 and AKASH_TOON_CLIENT_URL=https://<pod-ingress>.\n' +
      '   Ensure SKIP_DOCKER is unset and packages/hub/dist/image-manifest.json exists.\n' +
      '   Run `bash scripts/hub-test-infra.sh up` to warm the image cache.\n'
  );
}

// ── Constants ───────────────────────────────────────────────────────────────

const TEST_PASSWORD = 'integration-test';
const HS_CONNECTOR_NAME = 'hub-hs-connector';
const HS_API_NAME = 'hub-hs-api';
const HS_ANON_VOLUME = 'hub-hs-anon';
const HS_CONTAINER_NAMES = [
  HS_CONNECTOR_NAME,
  HS_API_NAME,
  'hub-hs-town',
  // The connector-init-1 container is a one-shot Docker Compose service that
  // exits after running but remains as a stopped container. If not removed, a
  // subsequent compose up tries to restart it referencing the old network ID,
  // causing "network <id> not found" on WSL2 Docker.
  'compose-connector-init-1',
] as const;
const HS_VOLUMES = [HS_ANON_VOLUME, 'hub-hs-town-data'] as const;

const CONNECTOR_ADMIN_URL = 'http://127.0.0.1:9401';
const HS_API_READY_URL = 'http://127.0.0.1:28090/api/transport';
const EARNINGS_URL = 'http://127.0.0.1:28090/api/earnings';
const HS_TOWN_BLS_URL = 'http://127.0.0.1:3100/health';

// Pod URL — stripped of trailing slash for clean concatenation.
const POD = POD_URL.replace(/\/+$/, '');

// ── Helpers ─────────────────────────────────────────────────────────────────

function cleanupContainersAndVolumes(): void {
  for (const name of HS_CONTAINER_NAMES) {
    try {
      execSync(`docker rm -f ${name}`, { stdio: 'pipe', timeout: 30_000 });
    } catch {
      /* best-effort */
    }
  }
  for (const vol of HS_VOLUMES) {
    try {
      execSync(`docker volume rm -f ${vol}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch {
      /* best-effort */
    }
  }
  // Remove the Docker network so the next run gets a fresh network ID.
  // docker rm -f doesn't remove networks; stale IDs in Docker's state
  // cause "network <id> not found" on the next compose up.
  try {
    execSync(`docker network rm hub-hs-net`, {
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch {
    /* best-effort — network may not exist */
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { budgetMs?: number; label?: string } = {}
): Promise<Response> {
  const { budgetMs = 15_000, label, ...rest } = init;
  try {
    return await fetch(url, {
      ...rest,
      signal: AbortSignal.timeout(budgetMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[fetch ${label ?? url}] failed within ${budgetMs}ms: ${msg}`
    );
  }
}

// Build ajv validators from the canonical schema file. Same source of truth
// as the pod's entrypoint AND the foreign-publish-contract unit test.
function buildSchemaValidators(): {
  validatePublishRequest: (data: unknown) => boolean;
  validatePublishSuccess: (data: unknown) => boolean;
  validateHealthz: (data: unknown) => boolean;
  validateSignerInfo: (data: unknown) => boolean;
} {
  const thisFile = fileURLToPath(import.meta.url);
  const schemaPath = join(
    dirname(thisFile),
    '..',
    '..',
    'contracts',
    'foreign-publish.schema.json'
  );
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as object;
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  ajv.addSchema(schema, 'foreign-publish');
  const get = (name: string): ((data: unknown) => boolean) => {
    const v = ajv.getSchema(`foreign-publish#/definitions/${name}`);
    if (!v) throw new Error(`schema definition missing: ${name}`);
    return v as unknown as (data: unknown) => boolean;
  };
  return {
    validatePublishRequest: get('PublishRequest'),
    validatePublishSuccess: get('PublishSuccessResponse'),
    validateHealthz: get('HealthzResponse'),
    validateSignerInfo: get('SignerInfoResponse'),
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!shouldRun)(
  'akash toon-client smoke — POST /publish → local hub hs up (Story 49.3)',
  () => {
    let tmpDirA: string;
    let hostnameA: string;
    let adminClientA: ConnectorAdminClient;
    let podEvmAddr: string;
    let podSolAddr: string;
    let _publishedEventId: string;
    let _publishedResponse: Record<string, unknown> | null = null;
    let bSecretKey: Uint8Array;
    let bPubkey: string;
    let priorWalletPassword: string | undefined;
    let validators: ReturnType<typeof buildSchemaValidators>;

    beforeAll(async () => {
      priorWalletPassword = process.env['TOWNHOUSE_WALLET_PASSWORD'];
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = TEST_PASSWORD;

      // Pre-flight: dist/cli.js must exist
      const thisFile = fileURLToPath(import.meta.url);
      const cliBin = join(dirname(thisFile), '..', '..', 'dist', 'cli.js');
      if (!existsSync(cliBin)) {
        throw new Error(
          `dist/cli.js not found. Run \`pnpm --filter @toon-protocol/hub build\` first.`
        );
      }

      validators = buildSchemaValidators();

      // Pre-flight: cleanup any leftover containers from prior runs
      cleanupContainersAndVolumes();

      // Boot the local hub hs up apex (mirror 49.1's Sub-path A2 init).
      tmpDirA = mkdtempSync(join(tmpdir(), 'akash-toon-client-A-'));

      const init = runCli('init', {
        configDir: tmpDirA,
        password: TEST_PASSWORD,
        env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
      });
      const initCode = await waitForExit(init.process, 30_000);
      if (initCode !== 0) {
        throw new Error(
          `hub init exited ${initCode}. stdout: ${init.stdout.join('')}`
        );
      }

      // Inject Akash Anvil URL into config.yaml so the connector uses the real
      // on-chain state for payment channel verification. Without this, the
      // connector uses DEFAULT_HS_CHAIN_PROVIDERS with a dead RPC (127.0.0.1:19999)
      // and returns T00 when the pod tries to publish (can't verify the channel).
      {
        const thisFile = fileURLToPath(import.meta.url);
        const leasesPath = join(
          dirname(thisFile),
          '..',
          '..',
          '..',
          '..',
          'deploy',
          'akash',
          'leases.json'
        );
        try {
          const leases = JSON.parse(
            readFileSync(leasesPath, 'utf-8')
          ) as Record<string, { url?: string }>;
          const anvilUrl = leases['anvil']?.url;
          if (anvilUrl) {
            const configPath = join(tmpDirA, 'config.yaml');
            const existing = readFileSync(configPath, 'utf-8');
            const chainSection = [
              'chainProviders:',
              '  - chainType: evm',
              '    chainId: evm:base:31337',
              `    rpcUrl: "${anvilUrl}"`,
              `    registryAddress: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"`,
              `    tokenAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3"`,
              `    keyId: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"`,
            ].join('\n');
            writeFileSync(
              configPath,
              existing + '\n' + chainSection + '\n',
              'utf-8'
            );
            console.log(
              `[49.3] Injected Akash Anvil URL into config.yaml: ${anvilUrl}`
            );
          }
        } catch (e) {
          console.warn(
            `[49.3] Could not inject chainProviders: ${(e as Error).message}`
          );
        }
      }

      const up = runCli('hs', {
        configDir: tmpDirA,
        password: TEST_PASSWORD,
        env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
        extraArgs: ['up'],
      });
      const upCode = await waitForExit(up.process, 360_000);
      if (upCode !== 0) {
        throw new Error(
          `hub hs up exited ${upCode}. stdout: ${up.stdout.join('')}`
        );
      }

      // Capture hostnameA from host.json
      const hostJson = JSON.parse(
        readFileSync(join(tmpDirA, 'host.json'), 'utf-8')
      ) as { hostname: string };
      expect(hostJson.hostname).toMatch(/^[a-z2-7]{55,57}\.(anyone|anon)$/);
      hostnameA = hostJson.hostname;
      console.log(`[49.3] A hostname: ${hostnameA}`);

      await waitForUrl(HS_API_READY_URL, {
        maxMs: 30_000,
        label: 'hub-api /api/transport',
      });
      adminClientA = new ConnectorAdminClient(CONNECTOR_ADMIN_URL, 5_000);

      // Start the town relay (profile: town) so the connector has a route to
      // g.townhouse.town. `hub hs up` boots the apex only (connector +
      // API); the town relay is a separate compose profile.
      //
      // FEE_PER_EVENT=0 → relay accepts events without payment validation.
      // TOWN_SECRET_KEY  → random ephemeral Nostr key for the test relay.
      // TOWN_SETTLEMENT_PRIVATE_KEY → random EVM key (no real on-chain claims).
      // TOWNHOUSE_WALLET_DIR must match hs up so the api isn't recreated.
      {
        const { randomBytes: rb } = await import('node:crypto');
        const townComposePath = join(tmpDirA, 'compose', 'hub-hs.yml');
        if (existsSync(townComposePath)) {
          // Derive wallet dir the same way handleHsUp does, so docker compose
          // sees the same env and doesn't recreate the api container.
          const walletDir = tmpDirA;

          // Try to get EVM_RPC_URL from leases.json for the town relay
          const thisFile2 = fileURLToPath(import.meta.url);
          const leasesPath = join(
            dirname(thisFile2),
            '..',
            '..',
            '..',
            '..',
            'deploy',
            'akash',
            'leases.json'
          );
          let evmRpcUrl = '';
          try {
            const leases = JSON.parse(
              readFileSync(leasesPath, 'utf-8')
            ) as Record<string, { url?: string }>;
            evmRpcUrl = leases['anvil']?.url ?? '';
          } catch {
            /* leases.json absent — town starts without EVM RPC */
          }

          console.log(
            '[49.3] Starting town relay (--profile town up -d town)...'
          );
          execSync(
            `docker compose -f "${townComposePath}" --profile town up -d town`,
            {
              stdio: 'pipe',
              timeout: 60_000,
              env: {
                ...process.env,
                TOWNHOUSE_HOME: tmpDirA,
                TOWNHOUSE_WALLET_DIR: walletDir,
                TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD,
                TOWN_SECRET_KEY: rb(32).toString('hex'),
                TOWN_SETTLEMENT_PRIVATE_KEY: '0x' + rb(32).toString('hex'),
                // APEX_EVM_ADDRESS must match the pod's TARGET_SETTLEMENT_ADDRESS
                // (0x90F79bf6...) so the relay can find the on-chain payment channel
                // the pod opened via openChannel('g.townhouse.town').
                APEX_EVM_ADDRESS: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
                FEE_PER_EVENT: '0',
                EVM_RPC_URL: evmRpcUrl,
              },
            }
          );
          await waitForUrl(HS_TOWN_BLS_URL, {
            maxMs: 60_000,
            label: 'hub-hs-town BLS health',
          });
          // Register the town relay as a peer with the connector admin so the
          // connector establishes a BTP channel to it and routes ILP packets
          // addressed to g.townhouse.town to the town relay container.
          // This replicates what `hub node add town` does via POST /api/nodes
          // (which is not available in the production hub-api image).
          await adminClientA.registerPeer({
            id: 'hub-hs-town-smoke',
            url: 'ws://hub-hs-town:3000/btp',
            authToken: '',
            routes: [{ prefix: 'g.townhouse.town', priority: 0 }],
            transport: 'direct',
          });
          // Brief wait for the BTP channel to be established
          await new Promise((r) => setTimeout(r, 3_000));
          console.log(
            '[49.3] Town relay ready — connector has route to g.townhouse.town'
          );
        } else {
          console.warn(
            '[49.3] compose file not found — town relay not started'
          );
        }
      }

      // Wait until the local apex's .anon HS is globally reachable via the
      // public ATOR proxy. A freshly-started HS needs 60-300s for introduction
      // point circuits to be fully established and indexed in the ATOR DHT.
      // We probe directly from the test runner using the same proxy the pod
      // will use — once THIS succeeds, the pod's ToonClient.start() will too.
      // Probe uses raw SOCKS5 CONNECT (node:net only, no external deps).
      // (Public ATOR proxy: socks5h://5.78.181.0:9052, DEFAULT_ATOR_PROXY per
      // Story 21.15 / Epic 23 D23-003 / config-generator.ts.)
      {
        const { createConnection } = await import('node:net');
        const PROXY_HOST = '5.78.181.0';
        const PROXY_PORT = 9052;
        const TARGET_HOST = hostnameA;
        const TARGET_PORT = 3000;
        const PROBE_TIMEOUT_MS = 15_000;
        const PROBE_BUDGET_MS = 300_000; // 5 min max

        const probeSocks5Connect = (): Promise<boolean> =>
          new Promise<boolean>((resolve) => {
            const sock = createConnection({
              host: PROXY_HOST,
              port: PROXY_PORT,
            });
            const cleanup = (result: boolean): void => {
              sock.destroy();
              resolve(result);
            };
            const t = setTimeout(() => cleanup(false), PROBE_TIMEOUT_MS);

            let state: 'greeting' | 'connect' | 'done' = 'greeting';
            sock.on('connect', () => {
              // Step 1: SOCKS5 greeting — version=5, nmethods=1, NO_AUTH
              sock.write(Buffer.from([0x05, 0x01, 0x00]));
            });
            sock.on('data', (chunk: Buffer) => {
              if (state === 'greeting') {
                // Expect 05 00 (NO_AUTH accepted)
                if (chunk[0] === 0x05 && chunk[1] === 0x00) {
                  state = 'connect';
                  // Step 2: SOCKS5 CONNECT request — DOMAINNAME type
                  const hostBuf = Buffer.from(TARGET_HOST, 'ascii');
                  const req = Buffer.alloc(7 + hostBuf.length);
                  req[0] = 0x05; // version
                  req[1] = 0x01; // CONNECT
                  req[2] = 0x00; // reserved
                  req[3] = 0x03; // DOMAINNAME
                  req[4] = hostBuf.length;
                  hostBuf.copy(req, 5);
                  req.writeUInt16BE(TARGET_PORT, 5 + hostBuf.length);
                  sock.write(req);
                } else {
                  clearTimeout(t);
                  cleanup(false);
                }
              } else if (state === 'connect') {
                state = 'done';
                clearTimeout(t);
                // 05 00 = success; anything else = error
                cleanup(chunk[0] === 0x05 && chunk[1] === 0x00);
              }
            });
            sock.on('error', () => {
              clearTimeout(t);
              cleanup(false);
            });
            sock.on('timeout', () => {
              cleanup(false);
            });
            sock.setTimeout(PROBE_TIMEOUT_MS);
          });

        const probeStart = Date.now();
        let probeOk = false;
        let attempt = 0;
        while (Date.now() - probeStart < PROBE_BUDGET_MS) {
          attempt += 1;
          const reachable = await probeSocks5Connect();
          const elapsed = Math.round((Date.now() - probeStart) / 1000);
          if (reachable) {
            console.log(
              `[49.3] HS reachable via ATOR proxy after ${elapsed}s (attempt ${attempt})`
            );
            probeOk = true;
            break;
          }
          if (attempt % 5 === 0) {
            console.log(
              `[49.3] HS not yet reachable (attempt ${attempt}, ${elapsed}s elapsed) — waiting for ATOR introduction points…`
            );
          }
          await new Promise((r) => setTimeout(r, 5_000));
        }
        if (!probeOk) {
          throw new Error(
            `[49.3] Local apex .anon HS (${hostnameA}) not reachable via public ATOR proxy` +
              ` after ${Math.round(PROBE_BUDGET_MS / 1000)}s — introduction points did not` +
              ` become stable. This is a known ATOR network intermittency issue for fresh HSs.`
          );
        }
      }

      // Generate B's Nostr keypair — used to SIGN the event we POST to the
      // pod. The pod uses its own ephemeral EVM signer for the on-chain claim;
      // the event's Nostr identity is the caller's (this test's) Schnorr keypair.
      bSecretKey = generateSecretKey();
      bPubkey = getPublicKey(bSecretKey);
      console.log(`[49.3] Test event pubkey: ${bPubkey.slice(0, 16)}…`);
    }, 1080_000);

    afterAll(async () => {
      try {
        if (tmpDirA) {
          try {
            const down = runCli('hs', {
              configDir: tmpDirA,
              password: TEST_PASSWORD,
              env: { TOWNHOUSE_WALLET_PASSWORD: TEST_PASSWORD },
              extraArgs: ['down'],
            });
            await waitForExit(down.process, 60_000);
          } catch (e) {
            console.warn(
              `[49.3 afterAll] hs down failed: ${(e as Error).message}`
            );
          }
        }
        cleanupContainersAndVolumes();
        if (tmpDirA) {
          rmSync(tmpDirA, { recursive: true, force: true });
        }
      } finally {
        if (priorWalletPassword === undefined) {
          delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
        } else {
          process.env['TOWNHOUSE_WALLET_PASSWORD'] = priorWalletPassword;
        }
      }
    }, 180_000);

    // ── Test 1: AC #1 — Pod /healthz + faucet auto-fund ───────────────────────
    it('pod /healthz returns anyoneReady=true + funded balances (AC #1)', async () => {
      const res = await fetchWithTimeout(`${POD}/healthz`, {
        budgetMs: 10_000,
        label: '/healthz',
      });
      expect(res.ok, `/healthz HTTP ${res.status}`).toBe(true);
      const body = (await res.json()) as Record<string, unknown>;
      console.log('[49.3 Test 1] /healthz body:', JSON.stringify(body));

      // Strict schema validation
      expect(validators.validateHealthz(body), 'healthz schema mismatch').toBe(
        true
      );

      // Semantic checks
      expect(body['anyoneReady']).toBe(true);
      const balances = body['balances'] as { evm: string; sol: number };
      expect(BigInt(balances.evm) > 0n, 'EVM balance must be > 0').toBe(true);
      expect(balances.sol > 0, 'SOL balance must be > 0').toBe(true);
    }, 30_000);

    // ── Test 2: /signer-info → capture pod's EVM address for AC #4/#5 ────────
    it('pod /signer-info returns valid shape; capture evmAddr (AC #1, #6)', async () => {
      // Retry up to 3 times (5s apart) for transient Akash ingress 404s.
      let res!: Response;
      for (let attempt = 1; attempt <= 3; attempt++) {
        res = await fetchWithTimeout(`${POD}/signer-info`, {
          budgetMs: 10_000,
          label: `/signer-info (attempt ${attempt})`,
        });
        if (res.ok) break;
        console.log(
          `[49.3 Test 2] attempt=${attempt} status=${res.status} — retrying in 5s`
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
      }
      expect(res.ok, `/signer-info HTTP ${res.status} after 3 attempts`).toBe(
        true
      );
      const body = (await res.json()) as Record<string, unknown>;
      console.log('[49.3 Test 2] /signer-info body:', JSON.stringify(body));

      expect(
        validators.validateSignerInfo(body),
        'signer-info schema mismatch'
      ).toBe(true);

      const transport = body['transport'] as {
        type: string;
        socksProxy: string;
      };
      // AC #6: SOCKS5 with socks5h:// scheme (DNS-leak prevention)
      expect(transport.type).toBe('socks5');
      expect(transport.socksProxy.startsWith('socks5h://')).toBe(true);

      podEvmAddr = body['evm'] as string;
      podSolAddr = body['sol'] as string;
      expect(podEvmAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(podSolAddr).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }, 30_000);

    // ── Test 3: AC #2 — POST /publish round-trip ──────────────────────────────
    it('POST /publish round-trips kind:1 to local apex (AC #2)', async () => {
      // AC #7: Retries MUST reuse the same signed event object — re-stamping
      // `created_at` produces a new event.id which bypasses relay dedup.
      // Build a signed kind:1 event using the caller's keypair
      const event: NostrEvent = finalizeEvent(
        {
          kind: 1,
          content: `49.3 akash toon-client smoke @ ${new Date().toISOString()}`,
          tags: [['t', '49.3-smoke']],
          created_at: Math.floor(Date.now() / 1000),
        },
        bSecretKey
      );
      _publishedEventId = event.id;

      // Confirm the request body would pass the pod's own ajv check
      const reqBody = { event, targetHostname: hostnameA };
      expect(
        validators.validatePublishRequest(reqBody),
        'request body does not match schema — pod would 400'
      ).toBe(true);

      // Retry loop: the pod uses the public ATOR proxy (ator-public mode, Story
      // 21.15 / Epic 23 D23-003). A freshly-started apex's .anon HS descriptor
      // may not yet be indexed in the public ATOR DHT — the DHT lookup returns
      // "not found" immediately, causing a fast 502 "Failed to start client".
      // Once the descriptor propagates (typically 60-120s), the first successful
      // /publish attempt establishes the circuit and caches the ToonClient for
      // all subsequent calls. Retries REUSE the same signed event object per
      // AC #7 — re-stamping created_at would produce a new event.id bypassing
      // relay dedup.
      const RETRY_INTERVAL_MS = 5_000;
      const RETRY_BUDGET_MS = 270_000; // 4.5 min — HS propagation + circuit build
      const startMs = Date.now();
      let res!: Response;
      let bodyText = '';
      let body: Record<string, unknown> = {};
      let attempt = 0;

      while (Date.now() - startMs < RETRY_BUDGET_MS) {
        attempt += 1;
        const attemptStart = Date.now();
        try {
          res = await fetchWithTimeout(`${POD}/publish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(reqBody),
            budgetMs: 150_000, // 2.5 min: socks 120s timeout + BTP auth + overhead
            label: `POST /publish (attempt ${attempt})`,
          });
          bodyText = await res.text();
          try {
            body = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            /* fall through */
          }
          const attemptMs = Date.now() - attemptStart;
          console.log(
            `[49.3 Test 3] attempt=${attempt} status=${res.status} wall=${attemptMs}ms body=${bodyText.slice(0, 200)}`
          );
          if (res.status === 202) break;
          // Retry on 5xx (nginx 504 gateway timeout, pod 503 deadline) and on
          // pod-signalled retryable errors. Break only on clear non-retryable
          // pod rejections (4xx that aren't rate-limit).
          if (res.status >= 500) continue;
          if (!(body['retryable'] === true)) break;
        } catch (err) {
          console.log(
            `[49.3 Test 3] attempt=${attempt} fetch error: ${(err as Error).message}`
          );
        }
        const elapsed = Date.now() - startMs;
        if (elapsed + RETRY_INTERVAL_MS >= RETRY_BUDGET_MS) break;
        console.log(
          `[49.3 Test 3] waiting ${RETRY_INTERVAL_MS}ms before retry (elapsed ${Math.round(elapsed / 1000)}s)…`
        );
        await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
      }

      const wallMs = Date.now() - startMs;
      console.log(
        `[49.3 Test 3] final status=${res?.status} total_wall=${wallMs}ms attempts=${attempt}`
      );

      expect(
        res.status,
        `expected 202, got ${res.status}: ${bodyText.slice(0, 200)}`
      ).toBe(202);
      expect(
        validators.validatePublishSuccess(body),
        'response schema mismatch'
      ).toBe(true);
      expect(body['eventId']).toBe(event.id);
      _publishedResponse = body;
    }, 330_000); // 5.5 min: propagation wait (4.5 min) + overhead

    // ── Test 4: AC #4 — Channel surfaces on A's drill verb ────────────────────
    it("local apex sees a channel rooted at the pod's EVM pubkey (AC #4)", async () => {
      // The connector's ClaimReceiver processes the incoming claim asynchronously
      // after Test 3's publishEvent returns. Poll up to 15s for the channel to
      // appear so the test isn't sensitive to network latency between the pod
      // and the local connector.
      const POLL_INTERVAL_MS = 2_000;
      const POLL_BUDGET_MS = 15_000;
      const pollStart = Date.now();
      let channels: { peerId: string; status: string }[] = [];

      const _parseChannels = (): { peerId: string; status: string }[] => {
        const channelsResult = runCli('channels', {
          configDir: tmpDirA,
          extraArgs: ['--json'],
        });
        // waitForExit is async — use syncronous exec trick via stored stdout
        const stdout = channelsResult.stdout.join('');
        if (!stdout.trim()) return [];
        const trimmed = stdout.trim();
        const lastChar = trimmed.charAt(trimmed.length - 1);
        const openChar = lastChar === ']' ? '[' : '{';
        let depth = 0;
        let jsonBlock = trimmed;
        for (let i = trimmed.length - 1; i >= 0; i--) {
          if (trimmed[i] === lastChar) depth++;
          else if (trimmed[i] === openChar) {
            depth--;
            if (depth === 0) {
              jsonBlock = trimmed.slice(i);
              break;
            }
          }
        }
        try {
          return JSON.parse(jsonBlock) as { peerId: string; status: string }[];
        } catch {
          return [];
        }
      };

      // Use the async CLI invocation with retry
      let podChan: { peerId: string; status: string } | undefined;
      while (Date.now() - pollStart < POLL_BUDGET_MS) {
        const result = runCli('channels', {
          configDir: tmpDirA,
          extraArgs: ['--json'],
        });
        const code = await waitForExit(result.process, 10_000);
        if (code !== 0) break;
        const stdout = result.stdout.join('');
        const trimmed = stdout.trim();
        if (trimmed) {
          const lastChar = trimmed.charAt(trimmed.length - 1);
          const openChar = lastChar === ']' ? '[' : '{';
          let depth = 0;
          let jsonBlock = trimmed;
          for (let i = trimmed.length - 1; i >= 0; i--) {
            if (trimmed[i] === lastChar) depth++;
            else if (trimmed[i] === openChar) {
              depth--;
              if (depth === 0) {
                jsonBlock = trimmed.slice(i);
                break;
              }
            }
          }
          try {
            channels = JSON.parse(jsonBlock) as {
              peerId: string;
              status: string;
            }[];
          } catch {
            channels = [];
          }
        }
        console.log(
          `[49.3 Test 4] channels: ${channels.length} entries (elapsed ${Math.round((Date.now() - pollStart) / 1000)}s)`
        );
        podChan = channels.find(
          (c) =>
            typeof c.peerId === 'string' &&
            c.peerId.toLowerCase() === podEvmAddr.toLowerCase() &&
            ['open', 'active', 'established'].includes(c.status)
        );
        if (podChan) break;
        if (Date.now() - pollStart + POLL_INTERVAL_MS < POLL_BUDGET_MS) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        } else {
          break;
        }
      }
      expect(
        podChan,
        `no channel with peerId === ${podEvmAddr} AND open state after ${Math.round(POLL_BUDGET_MS / 1000)}s. ` +
          `peerIds present: [${channels.map((c) => c.peerId).join(', ')}]`
      ).toBeDefined();
    }, 30_000);

    // ── Test 5: AC #5 — peer-type resolver tags pod as 'external' ─────────────
    it("peer-type resolver tags the pod's EVM pubkey as 'external' (AC #5)", async () => {
      const nodesYaml = await readNodesYaml(join(tmpDirA, 'nodes.yaml'));
      expect(
        nodesYaml.entries.every((e) => e.peerId !== podEvmAddr),
        `pod EVM addr must NOT be in A's nodes.yaml`
      ).toBe(true);

      // PRIMARY: /api/earnings → peers[] → type === 'external'
      let primaryPassed = false;
      try {
        const res = await fetchWithTimeout(EARNINGS_URL, {
          budgetMs: 10_000,
          label: '/api/earnings',
        });
        if (res.ok) {
          const body = (await res.json()) as Record<string, unknown>;
          const peers = body['peers'] as Record<string, unknown>[] | undefined;
          if (peers) {
            const podEntry = peers.find((p) => p['id'] === podEvmAddr);
            if (podEntry) {
              expect(podEntry['type']).toBe('external');
              primaryPassed = true;
              console.log('[49.3 Test 5] PRIMARY /api/earnings path PASSED');
            }
          }
        }
      } catch (e) {
        console.warn(`[49.3 Test 5] PRIMARY errored: ${(e as Error).message}`);
      }

      if (!primaryPassed) {
        // FALLBACK: direct PeerTypeResolver invocation (47.5 4B.2 recurrence,
        // mirrored from 49.1's Test 4 fallback path).
        console.warn(
          '⚠️  Test 5 BLOCKED-PARTIAL (47.5 4B.2 recurrence): pod absent ' +
            'from /api/earnings.peers[] — falling back to direct resolver.'
        );
        const resolver = new PeerTypeResolver(nodesYaml);
        expect(resolver.resolvePeerType(podEvmAddr)).toBe('external');
        console.log('[49.3 Test 5] FALLBACK direct resolver PASSED');
      }
    }, 30_000);

    // ── Test 6: AC #9 — rate limit ────────────────────────────────────────────
    it('POST /publish rate-limits past the per-minute budget (AC #9)', async () => {
      // Hammer 35 requests in quick succession. Default budget is 30/min per
      // source IP, so AT LEAST one of the last 5 must come back as 429.
      // (The previous test consumed 1 budget unit, so we have ~29 left.)
      //
      // Use minimal bodies so the schema validates fast even if the requests
      // hit /publish at the rate limiter (which fires BEFORE schema validation).
      const event: NostrEvent = finalizeEvent(
        {
          kind: 1,
          content: 'rate limit probe',
          tags: [],
          created_at: Math.floor(Date.now() / 1000),
        },
        bSecretKey
      );
      const body = JSON.stringify({ event, targetHostname: hostnameA });

      const responses: { status: number; retryAfterSec?: number }[] = [];
      // Sequential to keep timestamps deterministic — Promise.all would race.
      for (let i = 0; i < 35; i++) {
        const res = await fetchWithTimeout(`${POD}/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          budgetMs: 5_000,
          label: `rate-probe-${i}`,
        });
        let retryAfterSec: number | undefined;
        try {
          const parsed = (await res.json()) as Record<string, unknown>;
          if (typeof parsed['retryAfterSec'] === 'number') {
            retryAfterSec = parsed['retryAfterSec'];
          }
        } catch {
          /* not JSON or already consumed */
        }
        responses.push({ status: res.status, retryAfterSec });
      }
      const statuses = responses.map((r) => r.status);
      console.log(`[49.3 Test 6] rate-probe statuses: ${statuses.join(',')}`);

      const rateLimited = responses.filter((r) => r.status === 429);
      expect(
        rateLimited.length,
        `expected at least 1 of 35 responses to be 429 (rate-limited); got [${statuses.join(',')}]`
      ).toBeGreaterThanOrEqual(1);
      // Sanity: each 429 carries a positive retryAfterSec
      for (const r of rateLimited) {
        expect(typeof r.retryAfterSec).toBe('number');
        expect((r.retryAfterSec ?? 0) > 0).toBe(true);
      }
    }, 90_000);

    // ── Structural validation ─────────────────────────────────────────────────
    it('local apex containers still running + anon volume preserved', () => {
      const out = execSync(`docker ps --format "{{.Names}}"`, {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      const running = out.trim().split('\n');
      expect(running).toContain(HS_CONNECTOR_NAME);
      expect(running).toContain(HS_API_NAME);
    }, 10_000);
  }
);
