#!/usr/bin/env node

/**
 * CLI entrypoint for `@toon-protocol/townhouse` (Story 21.1).
 *
 * Subcommands: init, up, down, status, --help
 *
 * Usage:
 *   townhouse init [--force]
 *   townhouse up
 *   townhouse down
 *   townhouse status
 */

import { parseArgs } from 'node:util';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { stringify } from 'yaml';
import Docker from 'dockerode';

import { getDefaultConfig } from './config/defaults.js';
import { loadConfig } from './config/loader.js';
import type { TownhouseConfig } from './config/schema.js';
import { DockerOrchestrator } from './docker/index.js';
import type { NodeType } from './docker/types.js';
import {
  ConnectorAdminClient,
  TransportProbe,
  DEFAULT_ATOR_PROXY,
  writeHsConnectorConfig,
} from './connector/index.js';
import { materializeComposeTemplate } from './compose-loader.js';
import type { ComposeLoaderOptions } from './compose-loader.js';
import { BootReconciler } from './reconciler.js';
import { createApiServer } from './api/server.js';
import { createWizardApiServer } from './api/wizard-server.js';
import type { ApiServer } from './api/index.js';
import { RealBrowserOpener } from './cli/browser-opener.js';
import type { BrowserOpener } from './cli/browser-opener.js';
import { OnboardingRibbon } from './cli/onboarding-ribbon.js';
import { renderFailure } from './cli/failure-copy.js';
import { promptPassword } from './cli/password-prompt.js';
import {
  handleNodeAdd,
  handleNodeRemove,
  handleNodeList,
  NODE_HELP,
  NODE_ADD_HELP,
  NODE_REMOVE_HELP,
  NODE_LIST_HELP,
} from './cli/node-commands.js';
import { dispatchDrillCommand } from './cli/drill-commands.js';
import {
  renderEarningsSection,
  resolveSatsRate,
} from './cli/status-earnings.js';
import {
  aggregateEarnings,
  type AggregatedEarnings,
} from './earnings/aggregator.js';
import { readNodesYaml } from './state/nodes-yaml.js';
import { PeerTypeResolver } from './registry/peer-type-resolver.js';
import { createDeltaComputer } from './earnings/snapshot-reader.js';
import {
  WalletManager,
  encryptWallet,
  decryptWallet,
  saveWallet,
  loadWallet,
} from './wallet/index.js';
import { shouldRenderInk } from './tui/tty-detect.js';

/**
 * Error thrown when `main()` is invoked with `--help`. Callers (tests) can
 * distinguish this from genuine failures; the top-level entrypoint catches
 * it and exits 0.
 */
export class CliHelpRequested extends Error {
  constructor() {
    super(HELP_TEXT);
    this.name = 'CliHelpRequested';
  }
}

const HELP_TEXT = `townhouse — TOON node orchestrator

Usage:
  townhouse setup [--no-browser] [--port <n>] [--config-dir <dir>]  Run the first-run setup wizard
  townhouse init [--force] [--config-dir <dir>] [--password <pw>] [--preset <name>] [--yes]   Initialize config + wallet
  townhouse up [--town] [--mill] [--dvm] [-c <path>] [--password <pw>]  Start nodes
  townhouse down [-c <path>]                     Stop all nodes
  townhouse status [-c <path>]                   Show node status
  townhouse metrics [-c <path>]                  Show connector metrics
  townhouse wallet show [-c <path>] [--password <pw>]  Show derived addresses
  townhouse hs up [--password <pw>] [-c <path>]                Boot apex (connector + .anyone HS) (launches dashboard TUI in TTY mode)
  townhouse hs down [--rotate-keys] [-c <path>]               Stop apex (--rotate-keys deletes .anyone keypair)
  townhouse node add [<type>] [--json] [-c <path>]    Provision a child node (default: town)
  townhouse node remove <id> [--yes] [--json] [-c <path>]   Deprovision a child node
  townhouse node list [--json] [-c <path>]            List provisioned nodes
  townhouse channels [--json]                    Show open payment channels
  townhouse logs <node-id> [-f|--follow] [--lines N] [--json]   Tail logs for a node (Ctrl-C to stop)
  townhouse peer <id> [--json]                   Show per-peer detail card
  townhouse health [--json]                      Probe apex/api/nodes/.anyone health
  townhouse --help                               Show this help

Flags:
  --town         Start Town (Nostr relay) node
  --mill         Start Mill (swap) node
  --dvm          Start DVM (compute) node
  --password     Wallet password (non-interactive mode)
  --rotate-keys  Delete the .anyone keypair volume on hs down (produces a new address on next hs up)
  --no-browser   Skip opening the browser automatically (setup command)
  --port         Override the API port (setup command, default 9400)
  --preset       Init from a named preset (init only). Supported: demo
  --yes          Non-interactive (init only); with --preset=demo uses demo password if --password absent
  --json         Machine-readable JSON output (node commands; NDJSON for \`logs\`)
  --lines        Number of historical log lines to fetch on attach (logs command, default 50)
  -f|--follow    Accepted for \`tail -f\` muscle memory on \`logs\` (no-op — follow is default)
  If no flags given, starts all enabled nodes from config.`;

/**
 * Dependency-injection overrides for the `hs up` / `hs down` CLI path.
 * Used by unit tests to stub out Docker, file I/O, and admin client.
 */
export interface CliHsOverrides {
  /** Override materializeComposeTemplate (avoids disk writes in tests). */
  materializeComposeTemplate?: (
    profile: string,
    opts?: ComposeLoaderOptions
  ) => { composePath: string; manifestPath: string };
  /** Override the DockerOrchestrator constructor (avoids real Docker in tests). */
  createOrchestrator?: (
    docker: Docker,
    config: TownhouseConfig,
    walletManager: WalletManager | undefined,
    options: { profile: 'hs'; composePath: string }
  ) => {
    up: (profiles: NodeType[]) => Promise<void>;
    down: () => Promise<void>;
    on: (event: string, handler: (...args: unknown[]) => void) => unknown;
  };
  /** Override ConnectorAdminClient construction (avoids real HTTP in tests). */
  createAdminClient?: (
    baseUrl: string,
    timeoutMs: number
  ) => {
    getHsHostname: () => Promise<{
      hostname: string | null;
      publishedAt: string | null;
    }>;
  };
  /** Override `docker compose down -v` spawn for --rotate-keys (avoids real Docker). */
  runComposeDown?: (composePath: string, withVolumes: boolean) => Promise<void>;
  /**
   * Override BootReconciler construction (Story 46.1). Tests inject a stub
   * with a spied-on `reconcile()` to assert wiring without touching disk
   * or the connector. When omitted, the default constructs a real
   * `BootReconciler` against `~/.townhouse/{nodes.yaml,reconciler.log}`.
   */
  createReconciler?: (
    nodesYamlPath: string,
    reconcilerLogPath: string
  ) => { reconcile: () => Promise<void> };
}

/**
 * Dependency-injection overrides for the `node add` / `node remove` / `node list` CLI path.
 * Used by unit tests to stub `fetch` and the interactive confirmation prompt.
 */
export interface CliNodeCommandOverrides {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  confirm?: (question: string) => Promise<boolean>;
  apiUrl?: string;
}

const DEFAULT_CONFIG_DIR = join(homedir(), '.townhouse');
const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.yaml');

async function handleInit(
  force: boolean,
  configDir?: string,
  password?: string,
  preset?: 'demo',
  yes?: boolean
): Promise<void> {
  const dir = resolve(configDir ?? DEFAULT_CONFIG_DIR);
  const configPath = join(dir, 'config.yaml');

  if (existsSync(configPath) && !force) {
    console.error(
      `Config already exists at ${configPath}. Use --force to overwrite.`
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // D2 — preset path takes precedence over default config for non-interactive
  // demo init. Preset writes the same TownhouseConfig shape, so the rest of
  // the init flow (wallet generation, etc.) is unaffected.
  let configToWrite;
  if (preset === 'demo') {
    const { buildDemoConfig, DEMO_DETERMINISTIC_PASSWORD } =
      await import('./presets/demo.js');
    configToWrite = buildDemoConfig({ walletPath: join(dir, 'wallet.enc') });
    // AC-D2-6: --yes without --password under --preset=demo gets the
    // deterministic demo password. Documented as DEMO ONLY.
    if (yes && !password) {
      password = DEMO_DETERMINISTIC_PASSWORD;
      console.log(
        '[demo preset] Using deterministic demo password (insecure — demo only).'
      );
    }
  } else {
    configToWrite = getDefaultConfig();
    // Override wallet path to use the config dir, not the default home-dir path.
    // getDefaultConfig() hardcodes ~/.townhouse/wallet.enc; tests and non-default
    // config dirs need the wallet collocated with config.yaml.
    configToWrite.wallet.encrypted_path = join(dir, 'wallet.enc');
  }
  const yamlContent = stringify(configToWrite);
  writeFileSync(configPath, yamlContent, {
    encoding: 'utf-8',
    mode: 0o600,
  });

  console.log(`Config created at ${configPath}`);

  // Generate wallet — use config dir for wallet path (overrides default home dir path)
  const walletPath = join(dir, 'wallet.enc');
  if (existsSync(walletPath) && !force) {
    console.log(
      `Wallet already exists at ${walletPath}. Skipping wallet generation.`
    );
    return;
  }

  const walletPassword = password ?? process.env['TOWNHOUSE_WALLET_PASSWORD'];
  if (!walletPassword) {
    console.error(
      'Wallet password required. Use --password flag or TOWNHOUSE_WALLET_PASSWORD env var.'
    );
    process.exitCode = 1;
    return;
  }

  const walletManager = new WalletManager({ encryptedPath: walletPath });
  const { mnemonic } = await walletManager.generate();

  // Display mnemonic ONCE for backup — this is the only place it ever appears
  console.log('');
  console.log('=== IMPORTANT: Back up your seed phrase ===');
  console.log('');
  console.log(`  ${mnemonic}`);
  console.log('');
  console.log('This is the ONLY time your seed phrase will be shown.');
  console.log('Store it safely. You will need it to recover your node keys.');
  console.log('============================================');
  console.log('');

  // Encrypt and save — mnemonic reference is not stored beyond this block
  const encrypted = encryptWallet(mnemonic, walletPassword);
  await saveWallet(walletPath, encrypted);
  console.log(`Wallet saved to ${walletPath}`);

  // Display derived addresses
  console.log('');
  console.log('Derived Node Addresses:');
  console.log('-----------------------');
  const allKeys = walletManager.getAllKeys();
  for (const info of allKeys) {
    console.log(`  ${info.nodeType.padEnd(6)} Nostr: ${info.nostrPubkey}`);
    console.log(`  ${''.padEnd(6)} EVM:   ${info.evmAddress}`);
  }

  // Zero key material
  walletManager.lock();
}

async function handleSetup(
  configDir: string | undefined,
  port: number,
  noBrowser: boolean,
  dockerInstance?: Docker,
  browserOpener?: BrowserOpener
): Promise<void> {
  const dir = resolve(configDir ?? DEFAULT_CONFIG_DIR);
  const configPath = join(dir, 'config.yaml');
  const walletPath = join(dir, 'wallet.enc');

  // Short-circuit only when BOTH the config and the wallet exist — a config
  // without a wallet would land the operator in a circular dead-end (setup
  // says "already initialized → run `townhouse up`", up then errors that the
  // wallet is missing). Guide them to clean up and re-run setup instead.
  if (existsSync(configPath) && existsSync(walletPath)) {
    console.log('Already initialized — run `townhouse up` to start your nodes');
    return;
  }
  if (existsSync(configPath) && !existsSync(walletPath)) {
    console.error(
      `Found ${configPath} but no wallet at ${walletPath}.\n` +
        `Delete the orphan config and re-run \`townhouse setup\`, or restore the wallet from backup.`
    );
    process.exitCode = 1;
    return;
  }

  const docker = dockerInstance ?? new Docker();
  const opener = browserOpener ?? new RealBrowserOpener();

  const wizardServer = await createWizardApiServer({
    configDir: dir,
    configPath,
    walletPath,
    port,
    docker,
  });

  const url = `http://127.0.0.1:${port}/wizard`;

  try {
    await wizardServer.app.listen({ host: '127.0.0.1', port });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      console.error(
        `Port ${port} is already in use. Pass \`--port <n>\` to choose a different port.`
      );
      process.exitCode = 1;
      try {
        await wizardServer.close();
      } catch {
        /* best-effort */
      }
      return;
    }
    throw err;
  }
  console.log(`Wizard ready at ${url}`);

  if (!noBrowser) {
    await opener.open(url);
  }

  // Wire signal handlers via process.once so they self-remove after firing
  // — prevents listener leaks when tests call main(['setup', ...]) repeatedly.
  // The Fastify server keeps the process alive after handleSetup returns;
  // signals trigger graceful close.
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${sig}, shutting down...`);
    try {
      await wizardServer.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

async function handleWalletShow(
  config: TownhouseConfig,
  password?: string
): Promise<void> {
  const walletPath = config.wallet.encrypted_path;
  const result = await loadWallet(walletPath);

  if (!result) {
    console.error('No wallet found. Run `townhouse init` first.');
    process.exitCode = 1;
    return;
  }

  if (result.permissionsWarning) {
    console.error(result.permissionsWarning);
  }

  const walletPassword = password ?? process.env['TOWNHOUSE_WALLET_PASSWORD'];
  if (!walletPassword) {
    console.error(
      'Wallet password required. Use --password flag or TOWNHOUSE_WALLET_PASSWORD env var.'
    );
    process.exitCode = 1;
    return;
  }

  const walletManager = new WalletManager({ encryptedPath: walletPath });
  try {
    // Decrypt mnemonic in minimal scope — fromMnemonic derives keys then
    // the mnemonic string becomes unreachable (eligible for GC)
    await walletManager.fromMnemonic(
      decryptWallet(result.wallet, walletPassword)
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to decrypt wallet: ${msg}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    'Node Type  | Nostr Pubkey                                                     | EVM Address                                | Derivation Path'
  );
  console.log(
    '-----------|------------------------------------------------------------------|--------------------------------------------|--------------------------'
  );
  const allKeys = walletManager.getAllKeys();
  for (const info of allKeys) {
    console.log(
      `${info.nodeType.padEnd(10)} | ${info.nostrPubkey} | ${info.evmAddress} | ${info.nostrDerivationPath}`
    );
  }

  // Zero key material immediately after display
  walletManager.lock();
}

async function resolveEarnings(
  adminUrl: string,
  configPath: string
): Promise<AggregatedEarnings> {
  const base = dirname(configPath);
  try {
    const yaml = await readNodesYaml(join(base, 'nodes.yaml'));
    return await aggregateEarnings({
      connectorAdmin: new ConnectorAdminClient(adminUrl),
      peerTypeResolver: new PeerTypeResolver(yaml),
      deltaComputer: createDeltaComputer({
        snapshotPath: join(base, 'earnings-snapshots.jsonl'),
      }),
    });
  } catch (err) {
    // Distinguish local config/snapshot errors from connector outage:
    // aggregateEarnings handles connector failures internally, so anything
    // surfaced here is a nodes.yaml / snapshot-file / resolver problem.
    console.error(`Earnings unavailable: ${formatLocalEarningsError(err)}`);
    return {
      status: 'connector_unavailable',
      apex: { routingFees: {} },
      peers: [],
      recentClaims: [],
      eventsRelayed: 0,
      uptimeSeconds: 0,
    };
  }
}

// Render a one-line breadcrumb from a thrown error, collapsing Zod issue
// lists (multi-line JSON) into `path: message` segments joined by `; `.
function formatLocalEarningsError(err: unknown): string {
  if (
    err !== null &&
    typeof err === 'object' &&
    'issues' in err &&
    Array.isArray((err as { issues: unknown }).issues)
  ) {
    const issues = (err as { issues: { path?: unknown; message?: unknown }[] })
      .issues;
    const parts = issues
      .map((i) => {
        const path =
          Array.isArray(i.path) && i.path.length > 0
            ? i.path.join('.')
            : '<root>';
        const msg = typeof i.message === 'string' ? i.message : 'invalid';
        return `${path}: ${msg}`;
      })
      .join('; ');
    if (parts) return parts;
  }
  return err instanceof Error ? err.message : String(err);
}

async function handleStatus(
  docker: Docker,
  config: TownhouseConfig,
  opts: { units: 'usdc' | 'sats'; satsPerUsdc?: number; configPath: string } = {
    units: 'usdc',
    configPath: DEFAULT_CONFIG_PATH,
  }
): Promise<void> {
  const orchestrator = new DockerOrchestrator(docker, config, undefined, {
    profile: 'dev',
  });
  const statuses = await orchestrator.status();

  console.log('Node Status:');
  console.log('------------');
  for (const s of statuses) {
    const health = s.health ? ` (${s.health})` : '';
    console.log(`  ${s.name.padEnd(12)} ${s.state}${health}`);
  }

  const connectorHs = config.transport.hiddenService;
  const relayHs = config.transport.relayHiddenService;
  if (
    config.transport.mode === 'ator' ||
    connectorHs?.externalUrl ||
    relayHs?.externalUrl ||
    config.transport.externalUrl
  ) {
    console.log('');
    console.log('Hidden Services:');
    console.log('----------------');
    const connectorUrl =
      connectorHs?.externalUrl ?? config.transport.externalUrl;
    if (connectorUrl) {
      console.log(`  Connector (BTP):  ${connectorUrl}`);
    }
    if (relayHs?.externalUrl) {
      console.log(`  Relay (Nostr):    ${relayHs.externalUrl}`);
    }
    if (!connectorUrl && !relayHs?.externalUrl) {
      console.log('  (ator mode set but no externalUrl configured)');
    }
  }

  // Try to include connector metrics (graceful degradation)
  try {
    const adminClient = new ConnectorAdminClient(
      `http://127.0.0.1:${config.connector.adminPort}`
    );
    const metrics = await adminClient.getMetrics();
    const peers = await adminClient.getPeers();
    const activePeers = peers.filter((p) => p.connected).length;

    console.log('');
    console.log('Connector Metrics:');
    console.log('------------------');
    console.log(`  Packets forwarded: ${metrics.aggregate.packetsForwarded}`);
    console.log(`  Active peers:      ${activePeers}/${peers.length}`);
  } catch {
    console.log('');
    console.log('Connector Metrics: unavailable');
  }

  if (opts.units === 'sats' && opts.satsPerUsdc === undefined) return;
  const earnings = await resolveEarnings(
    `http://127.0.0.1:${config.connector.adminPort}`,
    opts.configPath
  );
  for (const line of renderEarningsSection({
    earnings,
    units: opts.units,
    satsPerUsdc: opts.satsPerUsdc,
  }))
    console.log(line);
}

// handleMetrics moved to cli/drill-commands.ts (Story 48.5)

/**
 * Determine which node profiles to start based on CLI flags and config.
 * If explicit flags (--town, --mill, --dvm) are provided, use those.
 * Otherwise fall back to all enabled nodes from config.
 */
function resolveProfiles(
  values: Record<string, unknown>,
  config: TownhouseConfig
): NodeType[] {
  const explicitFlags: NodeType[] = [];
  if (values['town']) explicitFlags.push('town');
  if (values['mill']) explicitFlags.push('mill');
  if (values['dvm']) explicitFlags.push('dvm');

  if (explicitFlags.length > 0) {
    return explicitFlags;
  }

  // No explicit flags — start all enabled nodes from config
  const enabled: NodeType[] = [];
  if (config.nodes.town.enabled) enabled.push('town');
  if (config.nodes.mill.enabled) enabled.push('mill');
  if (config.nodes.dvm.enabled) enabled.push('dvm');
  return enabled;
}

async function handleUp(
  configPath: string,
  config: TownhouseConfig,
  profiles: NodeType[],
  docker: Docker,
  password?: string,
  dryRun = false
): Promise<void> {
  if (profiles.length === 0) {
    console.log(
      'No nodes enabled in config. Enable nodes in config.yaml first.'
    );
    return;
  }

  // Initialize wallet (Round-2 Decision D1:c).
  // The API's GET /wallet depends on an unlocked wallet. If a wallet file
  // exists on disk it MUST be unlockable (fail-fast on bad password). If no
  // wallet file exists, we log a warning and skip API startup entirely so
  // orchestration-only callers (CI, tooling, smoke tests) still work.
  const walletPath = config.wallet.encrypted_path;
  let walletManager: WalletManager | undefined;
  if (!existsSync(walletPath)) {
    console.error(
      `Wallet not found at ${walletPath}. Run \`townhouse setup\` first (or restore your wallet backup).`
    );
    process.exitCode = 1;
    return;
  } else {
    const walletPassword = password ?? process.env['TOWNHOUSE_WALLET_PASSWORD'];
    if (!walletPassword) {
      throw new Error(
        'Wallet password required to start the API. Use --password flag or TOWNHOUSE_WALLET_PASSWORD env var.'
      );
    }
    const loaded = await loadWallet(walletPath);
    if (!loaded) {
      throw new Error(`Wallet at ${walletPath} could not be read.`);
    }
    if (loaded.permissionsWarning) {
      console.error(loaded.permissionsWarning);
    }
    walletManager = new WalletManager({ encryptedPath: walletPath });
    try {
      await walletManager.fromMnemonic(
        decryptWallet(loaded.wallet, walletPassword)
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to decrypt wallet: ${msg}`);
    }
  }

  const orchestrator = new DockerOrchestrator(docker, config, walletManager, {
    profile: 'dev',
  });

  // Wire up progress reporting
  orchestrator.on(
    'containerState',
    (event: { name: string; state: string }) => {
      console.log(`  ${event.name}: ${event.state}`);
    }
  );
  orchestrator.on(
    'pullProgress',
    (event: { image: string; status: string; progress?: string }) => {
      const progress = event.progress ? ` ${event.progress}` : '';
      console.log(`  [pull] ${event.image}: ${event.status}${progress}`);
    }
  );

  // API server reference for graceful shutdown
  let apiServer: ApiServer | undefined;

  // Register SIGINT handler for graceful shutdown
  const sigintHandler = async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');

    // Close API server first
    if (apiServer) {
      try {
        await apiServer.close();
      } catch {
        // Best-effort
      }
    }

    // Then stop containers
    try {
      await orchestrator.down();
    } catch {
      // Best-effort cleanup
    }
    process.exit(0);
  };
  process.on('SIGINT', sigintHandler);

  // For SIGTERM
  const sigtermHandler = async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');

    if (apiServer) {
      try {
        await apiServer.close();
      } catch {
        // Best-effort
      }
    }

    try {
      await orchestrator.down();
    } catch {
      // Best-effort cleanup
    }
    process.exit(0);
  };
  process.on('SIGTERM', sigtermHandler);

  // Track if the server started successfully (handlers stay registered if true)
  let serverStarted = false;

  if (
    profiles.includes('dvm') &&
    config.nodes.dvm.enabled &&
    !process.env['TURBO_TOKEN']
  ) {
    console.warn(
      '[townhouse] WARN: TURBO_TOKEN is not set — Arweave DVM (kind:5094) uploads will fail at first job.'
    );
    console.warn(
      '[townhouse] Export TURBO_TOKEN=<arweave-jwk-json> before `townhouse up` to enable uploads.'
    );
  }

  try {
    console.log(`Starting nodes: ${profiles.join(', ')}...`);
    if (!dryRun) {
      await orchestrator.up(profiles);
      console.log('All nodes started successfully.');
    } else {
      console.log('[dry-run] Skipped orchestrator.up()');
    }

    // Start API server after nodes are up
    if (walletManager) {
      const connectorAdmin = new ConnectorAdminClient(
        `http://127.0.0.1:${config.connector.adminPort}`
      );

      const transportProbe = new TransportProbe({
        proxyUrl:
          config.transport.mode === 'ator'
            ? (config.transport.socksProxy ?? DEFAULT_ATOR_PROXY)
            : '',
      });
      if (config.transport.mode === 'ator') {
        transportProbe.start();
      }

      const apiDeps = {
        configPath,
        config,
        orchestrator,
        wallet: walletManager,
        connectorAdmin,
        transportProbe,
      };

      apiServer = await createApiServer(apiDeps);

      const { host, port } = config.api;
      if (!dryRun) {
        await apiServer.app.listen({
          host: host ?? '127.0.0.1',
          port: port ?? 9400,
        });
        serverStarted = true;

        console.log(
          `\n[Townhouse API] listening on http://${host ?? '127.0.0.1'}:${port ?? 9400}`
        );
        console.log(
          '  GET /nodes, GET /nodes/:type, PATCH /nodes/:type/config, GET /wallet, WS /metrics'
        );
      } else {
        // Log a structured summary for the dry-run smoke test (Task 8.3).
        console.log(
          `[dry-run] API factory invoked: configPath=${configPath} host=${host ?? '127.0.0.1'} port=${port ?? 9400} connectorAdmin=http://127.0.0.1:${config.connector.adminPort} wallet=WalletManager`
        );
        await apiServer.close();
        apiServer = undefined;
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes('Docker is not running') ||
      msg.includes('ENOENT') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('socket')
    ) {
      throw new Error(
        `Docker is not available. Please ensure Docker is running and try again. (${msg})`
      );
    }
    throw error;
  } finally {
    // Only remove signal handlers if server never started
    // If server is running, handlers enable graceful shutdown on SIGTERM/SIGINT
    if (!serverStarted) {
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
    }
  }
}

async function handleDown(
  config: TownhouseConfig,
  docker: Docker
): Promise<void> {
  const orchestrator = new DockerOrchestrator(docker, config, undefined, {
    profile: 'dev',
  });

  orchestrator.on(
    'containerState',
    (event: { name: string; state: string }) => {
      console.log(`  ${event.name}: ${event.state}`);
    }
  );

  console.log('Stopping nodes...');
  await orchestrator.down();
  console.log('All nodes stopped.');
}

/** Connector admin URL for HS mode. */
const HS_CONNECTOR_ADMIN_URL = 'http://127.0.0.1:9401';
/** Townhouse API URL for HS mode (inside the townhouse-api container). */
const HS_TOWNHOUSE_API_URL = 'http://127.0.0.1:28090';

/**
 * Run `reconciler.reconcile()` with a brief retry budget for cold-boot
 * transients. The connector container may not have bound its admin port
 * by the time `orchestrator.up()` resolves; treat ECONNREFUSED / timeout
 * on early attempts as "still warming" and retry. Persistent failures
 * surface to the caller and end up in the non-fatal stderr log.
 */
async function reconcileWithBriefRetry(
  reconciler: { reconcile: () => Promise<unknown> },
  budgetMs: number
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      await reconciler.reconcile();
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        msg.includes('ECONNREFUSED') ||
        msg.includes('connection refused') ||
        msg.includes('request timeout');
      if (!transient || Date.now() >= deadline) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Boot the apex (connector + townhouse-api) via `townhouse hs up`.
 * Idempotent: if the apex is already running, re-prints the hostname and exits 0.
 * After the apex is live, writes `~/.townhouse/host.json` and prints the final line.
 */
async function handleHsUp(
  _configPath: string,
  configDir: string,
  config: TownhouseConfig,
  docker: Docker,
  options: {
    password?: string;
    force?: boolean;
    hsOverrides?: CliHsOverrides;
  }
): Promise<void> {
  const { password, force, hsOverrides } = options;

  // Resolve wallet password (AC #10): --password → env var → interactive prompt → reject
  const walletPath = config.wallet.encrypted_path;
  if (!existsSync(walletPath)) {
    console.error(
      `Wallet not found at ${walletPath}. Run \`townhouse init\` first.`
    );
    process.exitCode = 1;
    return;
  }

  const walletPassword = password ?? process.env['TOWNHOUSE_WALLET_PASSWORD'];

  let resolvedPassword: string;
  if (walletPassword) {
    resolvedPassword = walletPassword;
  } else if (process.stdin.isTTY) {
    resolvedPassword = await promptPassword('Wallet password: ');
  } else {
    console.error(
      'Wallet password required. Use --password flag or TOWNHOUSE_WALLET_PASSWORD env var.'
    );
    process.exitCode = 1;
    return;
  }

  const loaded = await loadWallet(walletPath);
  if (!loaded) {
    console.error(`Wallet at ${walletPath} could not be read.`);
    process.exitCode = 1;
    return;
  }

  let walletManager: WalletManager | undefined;
  try {
    walletManager = new WalletManager({ encryptedPath: walletPath });
    await walletManager.fromMnemonic(
      decryptWallet(loaded.wallet, resolvedPassword)
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to decrypt wallet: ${msg}`);
    process.exitCode = 1;
    return;
  }

  const ribbon = new OnboardingRibbon();

  try {
    // Idempotency probe (AC #7): check if apex is already running.
    if (!force) {
      const adminClientFactory =
        hsOverrides?.createAdminClient ??
        ((url: string, t: number) => new ConnectorAdminClient(url, t));
      const probe = adminClientFactory(HS_CONNECTOR_ADMIN_URL, 3_000);
      try {
        const existing = await probe.getHsHostname();
        if (existing.hostname !== null) {
          // Apex is already running — re-print hostname and refresh host.json.
          // hostname from the connector already includes the .anyone suffix.
          console.log(`Apex live at ${existing.hostname}`);
          _writeHostJson(configDir, {
            hostname: existing.hostname,
            publishedAt: existing.publishedAt ?? new Date().toISOString(),
            writtenAt: new Date().toISOString(),
          });
          return;
        }
        // hostname is null → apex started but HS not ready → treat as cold-start.
      } catch (probeErr: unknown) {
        const msg =
          probeErr instanceof Error ? probeErr.message : String(probeErr);
        if (msg.includes('anon-disabled')) {
          // Apex running but anon is disabled — render failure copy and exit.
          const { exitCode } = renderFailure(probeErr);
          process.exitCode = exitCode;
          return;
        }
        // ECONNREFUSED or timeout → not running → proceed to cold-boot.
      }
    }

    // Cold-boot path.

    // Step 1: write connector.yaml with anon.enabled: true (AC #3).
    writeHsConnectorConfig(configDir, config, { force });

    // Step 2: materialize compose template.
    const materialize =
      hsOverrides?.materializeComposeTemplate ?? materializeComposeTemplate;
    const { composePath } = materialize('hs', { townhouseHome: configDir });

    // Step 3: start the ribbon (phase 1 — pulling).
    ribbon.start('pull');

    // Step 4: construct orchestrator and wire ribbon events.
    const orchestratorFactory =
      hsOverrides?.createOrchestrator ??
      ((
        d: Docker,
        cfg: TownhouseConfig,
        wm: WalletManager | undefined,
        opts: { profile: 'hs'; composePath: string }
      ) => new DockerOrchestrator(d, cfg, wm, opts));

    const orch = orchestratorFactory(docker, config, walletManager, {
      profile: 'hs',
      composePath,
    });

    // Transition ribbon to bootstrap phase when a container starts creating.
    let bootstrapStarted = false;
    orch.on('containerState', (event: unknown) => {
      const ev = event as { name?: string; state?: string; detail?: string };
      if (
        !bootstrapStarted &&
        (ev.state === 'creating' || ev.state === 'starting')
      ) {
        bootstrapStarted = true;
        ribbon.start('bootstrap');
      }
    });

    // Step 5: up (always-on services only — empty profile array).
    // Inject env vars that Docker Compose interpolates in townhouse-hs.yml:
    //   TOWNHOUSE_HOME — operator's config dir; replaces hardcoded `~/.townhouse`
    //     bind-mount sources so a custom --config-dir (or test tmpDir) actually
    //     reaches the containers. Docker does NOT expand `~` in bind-mount
    //     sources, so the template must use an explicit interpolation variable.
    //   TOWNHOUSE_WALLET_PASSWORD — required by townhouse-api service
    //   TOWNHOUSE_UID — run townhouse-api as the host user so bind-mounted
    //     ~/.townhouse files (rw------- 600) are readable inside the container
    //   TOWNHOUSE_DOCKER_GID — host docker socket group (typically root:docker
    //     mode 660 on Linux); added as supplementary group so the non-root
    //     container user can read/write /var/run/docker.sock for the
    //     `pull-image` step of POST /api/nodes. Without this, dockerode calls
    //     from townhouse-api fail with `connect EACCES /var/run/docker.sock`.
    let dockerSockGid = 0;
    try {
      dockerSockGid = statSync('/var/run/docker.sock').gid;
    } catch {
      // Socket missing — operator will see a clearer error at compose-up time.
      // Fallback 0 keeps Compose interpolation valid; the container just won't
      // gain extra group access (matches pre-fix behaviour for that case).
    }
    const prevTownhouseHome = process.env['TOWNHOUSE_HOME'];
    const prevWalletPassword = process.env['TOWNHOUSE_WALLET_PASSWORD'];
    const prevTownhouseUid = process.env['TOWNHOUSE_UID'];
    const prevWalletDir = process.env['TOWNHOUSE_WALLET_DIR'];
    const prevDockerGid = process.env['TOWNHOUSE_DOCKER_GID'];
    process.env['TOWNHOUSE_HOME'] = configDir;
    process.env['TOWNHOUSE_WALLET_PASSWORD'] = resolvedPassword;
    process.env['TOWNHOUSE_UID'] = String(process.getuid?.() ?? 1000);
    // Inject the wallet dir as an absolute host path so the townhouse-api
    // container can find the wallet at the same path as config.wallet.encrypted_path.
    process.env['TOWNHOUSE_WALLET_DIR'] = dirname(
      resolve(config.wallet.encrypted_path)
    );
    process.env['TOWNHOUSE_DOCKER_GID'] = String(dockerSockGid);
    try {
      await orch.up([]);
    } finally {
      if (prevTownhouseHome === undefined) {
        delete process.env['TOWNHOUSE_HOME'];
      } else {
        process.env['TOWNHOUSE_HOME'] = prevTownhouseHome;
      }
      if (prevWalletPassword === undefined) {
        delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
      } else {
        process.env['TOWNHOUSE_WALLET_PASSWORD'] = prevWalletPassword;
      }
      if (prevTownhouseUid === undefined) {
        delete process.env['TOWNHOUSE_UID'];
      } else {
        process.env['TOWNHOUSE_UID'] = prevTownhouseUid;
      }
      if (prevWalletDir === undefined) {
        delete process.env['TOWNHOUSE_WALLET_DIR'];
      } else {
        process.env['TOWNHOUSE_WALLET_DIR'] = prevWalletDir;
      }
      if (prevDockerGid === undefined) {
        delete process.env['TOWNHOUSE_DOCKER_GID'];
      } else {
        process.env['TOWNHOUSE_DOCKER_GID'] = prevDockerGid;
      }
    }

    // Step 5b: reconcile connector peer state to nodes.yaml (Story 46.1).
    // Runs after orchestrator.up([]) but BEFORE host.json is written and the
    // hostname is printed. Reconciler divergences are non-fatal — the
    // failure is logged to stderr but does not block apex boot.
    const nodesYamlPath = join(configDir, 'nodes.yaml');
    const reconcilerLogPath = join(configDir, 'reconciler.log');
    const reconcilerFactory =
      hsOverrides?.createReconciler ??
      ((nodesPath: string, logPath: string) => {
        const reconcilerAdminClient = new ConnectorAdminClient(
          HS_CONNECTOR_ADMIN_URL,
          5_000
        );
        return new BootReconciler(reconcilerAdminClient, nodesPath, logPath);
      });
    const reconciler = reconcilerFactory(nodesYamlPath, reconcilerLogPath);
    // Brief retry on cold-boot transient errors — orchestrator.up() returns
    // once Docker accepts the create call, not when the connector inside
    // the container has bound its admin port. A short retry budget keeps
    // cold-boot stderr quiet on the common "connector still warming" case
    // while still surfacing genuine connector-down failures via the final
    // non-fatal log below.
    try {
      await reconcileWithBriefRetry(reconciler, 5_000);
    } catch (reconcilerErr: unknown) {
      const detail =
        reconcilerErr instanceof Error
          ? (reconcilerErr.stack ?? reconcilerErr.message)
          : String(reconcilerErr);
      console.error(
        `[townhouse hs up] reconciler error (non-fatal): ${detail}`
      );
    }

    // Step 6: fetch published hostname and publishedAt for host.json (AC #6).
    const adminClientFactory2 =
      hsOverrides?.createAdminClient ??
      ((url: string, t: number) => new ConnectorAdminClient(url, t));
    const adminClient = adminClientFactory2(HS_CONNECTOR_ADMIN_URL, 5_000);
    const hsInfo = await adminClient.getHsHostname();

    const hostname = hsInfo.hostname ?? '';
    const publishedAt = hsInfo.publishedAt ?? new Date().toISOString();

    // Step 7: write host.json atomically (AC #6).
    _writeHostJson(configDir, {
      hostname,
      publishedAt,
      writtenAt: new Date().toISOString(),
    });

    // Step 8: ribbon phase 3 + final stdout line (AC #5).
    // hostname from the connector already includes the .anyone suffix.
    // ribbon.start('live', hostname) prints: "Apex live at <hostname>" as the FINAL stdout line.
    ribbon.start('live', hostname);

    // Story 48.1: foreground Ink TUI when stdout is a TTY.
    // Dynamic import keeps Ink + React out of non-TTY startup path (faster --help).
    // On non-TTY the process exits naturally after this block (Story 45.4 AC #11).
    if (shouldRenderInk()) {
      const { mountTui } = await import('./tui/index.js');
      // P27 (D1): thread HS_TOWNHOUSE_API_URL env override into the TUI so
      // operators on a non-default Fastify port don't see eternal fetch_failed.
      const apiUrlOverride = process.env['HS_TOWNHOUSE_API_URL'];
      const mountOpts =
        apiUrlOverride !== undefined ? { apiUrl: apiUrlOverride } : {};
      const instance = mountTui(mountOpts);
      await instance.waitUntilExit();
    }
  } catch (err: unknown) {
    const { exitCode } = renderFailure(err);
    process.exitCode = exitCode;
  } finally {
    ribbon.stop();
    if (walletManager) {
      walletManager.lock();
    }
  }
}

/** Atomically write ~/.townhouse/host.json (AC #6). */
function _writeHostJson(
  configDir: string,
  data: { hostname: string; publishedAt: string; writtenAt: string }
): void {
  const hostJsonPath = join(configDir, 'host.json');
  const tmpPath = `${hostJsonPath}.tmp`;
  // hostname from the connector already includes the .anyone suffix (e.g. "abc123.anyone").
  const content = JSON.stringify(
    {
      hostname: data.hostname,
      publishedAt: data.publishedAt,
      connectorAdminUrl: HS_CONNECTOR_ADMIN_URL,
      townhouseApiUrl: HS_TOWNHOUSE_API_URL,
      writtenAt: data.writtenAt,
    },
    null,
    2
  );
  writeFileSync(tmpPath, content, { mode: 0o600, encoding: 'utf-8' });
  renameSync(tmpPath, hostJsonPath);
}

/**
 * Stop the apex via `townhouse hs down`.
 * Default: preserves the townhouse-hs-anon volume (stable .anyone address).
 * --rotate-keys: removes the volume (new address on next hs up).
 */
async function handleHsDown(
  configDir: string,
  config: TownhouseConfig,
  docker: Docker,
  options: {
    rotateKeys?: boolean;
    hsOverrides?: CliHsOverrides;
  }
): Promise<void> {
  const { rotateKeys, hsOverrides } = options;

  // Materialize compose template to get the composePath (idempotent re-write).
  const materialize =
    hsOverrides?.materializeComposeTemplate ?? materializeComposeTemplate;
  const { composePath } = materialize('hs', { townhouseHome: configDir });

  // Export every env var the compose template interpolates, so `docker compose
  // down` parses the same YAML that `up` parsed. Compose's `${VAR:-default}`
  // fallbacks for the wallet dir use a literal `~/.townhouse` which Docker
  // doesn't expand — they only work when handleHsDown explicitly sets the
  // var. TOWNHOUSE_WALLET_PASSWORD has a `${...:?...}` mandatory-error
  // fallback (Finding J — fixed in the same PR by switching to `:-`), so set
  // an empty string here to bypass it if Compose still requires it. Mirrors
  // the env-export pattern in handleHsUp. Discovered by Story 46.4 live gate
  // run (Finding I, 2026-05-11; supersedes PR #51's TOWNHOUSE_HOME-only fix).
  const prevTownhouseHome = process.env['TOWNHOUSE_HOME'];
  const prevTownhouseUid = process.env['TOWNHOUSE_UID'];
  const prevWalletDir = process.env['TOWNHOUSE_WALLET_DIR'];
  const prevDockerGid = process.env['TOWNHOUSE_DOCKER_GID'];
  const prevWalletPassword = process.env['TOWNHOUSE_WALLET_PASSWORD'];
  process.env['TOWNHOUSE_HOME'] = configDir;
  process.env['TOWNHOUSE_UID'] = String(process.getuid?.() ?? 1000);
  process.env['TOWNHOUSE_WALLET_DIR'] = dirname(
    resolve(config.wallet.encrypted_path)
  );
  let dockerSockGid = 0;
  try {
    dockerSockGid = statSync('/var/run/docker.sock').gid;
  } catch {
    /* Docker socket missing — fall back to 0; compose down won't actually use it */
  }
  process.env['TOWNHOUSE_DOCKER_GID'] = String(dockerSockGid);
  // Empty string keeps Compose interpolation valid even if the template still
  // has a mandatory-error fallback. The container side checks the password
  // itself; compose-down doesn't actually need it.
  if (prevWalletPassword === undefined) {
    process.env['TOWNHOUSE_WALLET_PASSWORD'] = '';
  }
  const restoreTownhouseHome = (): void => {
    if (prevTownhouseHome === undefined) {
      delete process.env['TOWNHOUSE_HOME'];
    } else {
      process.env['TOWNHOUSE_HOME'] = prevTownhouseHome;
    }
    if (prevTownhouseUid === undefined) {
      delete process.env['TOWNHOUSE_UID'];
    } else {
      process.env['TOWNHOUSE_UID'] = prevTownhouseUid;
    }
    if (prevWalletDir === undefined) {
      delete process.env['TOWNHOUSE_WALLET_DIR'];
    } else {
      process.env['TOWNHOUSE_WALLET_DIR'] = prevWalletDir;
    }
    if (prevDockerGid === undefined) {
      delete process.env['TOWNHOUSE_DOCKER_GID'];
    } else {
      process.env['TOWNHOUSE_DOCKER_GID'] = prevDockerGid;
    }
    if (prevWalletPassword === undefined) {
      delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
    }
  };

  if (rotateKeys) {
    // Confirmation prompt when TTY is available.
    if (process.stdin.isTTY) {
      // Read the existing hostname from host.json for the warning message.
      let existingHostname = '(unknown)';
      const hostJsonPath = join(configDir, 'host.json');
      if (existsSync(hostJsonPath)) {
        try {
          const { readFileSync } = await import('node:fs');
          const json = JSON.parse(readFileSync(hostJsonPath, 'utf-8')) as {
            hostname?: string;
          };
          existingHostname = json.hostname ?? existingHostname;
        } catch {
          // best-effort
        }
      }
      // Use readline for the yes/no confirmation prompt.
      const { createInterface } = await import('node:readline');
      const answer = await new Promise<string>((resolve) => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(
          `WARNING: --rotate-keys will permanently delete your current .anyone address (${existingHostname}). The next 'hs up' will publish a new address. Continue? [y/N] `,
          (ans) => {
            rl.close();
            resolve(ans);
          }
        );
      });
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        console.log('Cancelled.');
        return;
      }
    }

    // Run `docker compose down -v` to remove volumes (including townhouse-hs-anon).
    const runDown = hsOverrides?.runComposeDown ?? _runDockerComposeDown;
    try {
      await runDown(composePath, true);
    } catch (err: unknown) {
      const { exitCode } = renderFailure(err);
      process.exitCode = exitCode;
      restoreTownhouseHome();
      return;
    }

    // Delete host.json so the stale hostname doesn't outlive the keypair (AC #9).
    rmSync(join(configDir, 'host.json'), { force: true });

    console.log(
      "Apex stopped. Volumes deleted — your next 'hs up' will publish a NEW .anyone address."
    );
    restoreTownhouseHome();
    return;
  }

  // Default: preserve volumes (townhouse-hs-anon survives → same hostname next hs up).
  const orchestratorFactory =
    hsOverrides?.createOrchestrator ??
    ((
      d: Docker,
      cfg: TownhouseConfig,
      wm: WalletManager | undefined,
      opts: { profile: 'hs'; composePath: string }
    ) => new DockerOrchestrator(d, cfg, wm, opts));

  const orch = orchestratorFactory(docker, config, undefined, {
    profile: 'hs',
    composePath,
  });

  try {
    await orch.down();
  } catch (err: unknown) {
    const { exitCode } = renderFailure(err);
    process.exitCode = exitCode;
    restoreTownhouseHome();
    return;
  }
  restoreTownhouseHome();

  console.log(
    'Apex stopped. Volumes preserved — your .anyone address is stable.'
  );
}

/**
 * Run `docker compose -f <composePath> down [-v]` as a subprocess.
 * Used by handleHsDown's --rotate-keys path (AC #9).
 */
function _runDockerComposeDown(
  composePath: string,
  withVolumes: boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['compose', '-f', composePath, 'down'];
    if (withVolumes) args.push('-v');
    const child = spawn('docker', args, {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker compose down exited with code ${code}`));
      }
    });
  });
}

/**
 * Main CLI entry — exported for testability (same pattern as Mill CLI).
 * Accepts optional dockerode instance for dependency injection in tests.
 * The optional `hsOverrides` bag is used by unit tests to stub out Docker,
 * file I/O, and admin-client calls in the `hs up` / `hs down` path.
 */
export async function main(
  argv: string[],
  dockerInstance?: Docker,
  browserOpener?: BrowserOpener,
  hsOverrides?: CliHsOverrides,
  nodeCommandOverrides?: CliNodeCommandOverrides
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean' },
      force: { type: 'boolean' },
      config: { type: 'string', short: 'c' },
      'config-dir': { type: 'string' },
      town: { type: 'boolean' },
      mill: { type: 'boolean' },
      dvm: { type: 'boolean' },
      password: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-browser': { type: 'boolean' },
      port: { type: 'string' },
      preset: { type: 'string' },
      yes: { type: 'boolean' },
      'rotate-keys': { type: 'boolean' },
      json: { type: 'boolean' },
      'json-compact': { type: 'boolean' },
      lines: { type: 'string' },
      follow: { type: 'boolean', short: 'f' },
      units: { type: 'string' },
      rate: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  });

  const command = positionals[0];

  // Handle `townhouse node <verb> --help` before the global --help check so
  // node sub-help takes priority over the global HELP_TEXT.
  if (command === 'node' && values.help) {
    const action = positionals[1];
    const subHelp =
      action === 'add'
        ? NODE_ADD_HELP
        : action === 'remove'
          ? NODE_REMOVE_HELP
          : action === 'list'
            ? NODE_LIST_HELP
            : NODE_HELP;
    console.log(subHelp);
    throw new CliHelpRequested();
  }

  if (values.help) {
    console.log(HELP_TEXT);
    throw new CliHelpRequested();
  }

  if (!command) {
    console.log(HELP_TEXT);
    throw new CliHelpRequested();
  }

  switch (command) {
    case 'setup': {
      const portStr = values['port'] as string | undefined;
      // Reject trailing junk like "9400foo" (parseInt would silently accept).
      const port = portStr ? Number(portStr) : 9400;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error('--port must be an integer between 1 and 65535');
        process.exitCode = 1;
        break;
      }
      await handleSetup(
        values['config-dir'] as string | undefined,
        port,
        values['no-browser'] === true,
        dockerInstance,
        browserOpener
      );
      break;
    }
    case 'init': {
      const presetVal = values.preset as string | undefined;
      if (presetVal !== undefined && presetVal !== 'demo') {
        console.error(`Unknown preset: ${presetVal}. Supported: demo`);
        process.exitCode = 1;
        break;
      }
      await handleInit(
        values.force === true,
        values['config-dir'] as string | undefined,
        values.password as string | undefined,
        presetVal,
        values.yes === true
      );
      break;
    }
    case 'wallet': {
      const subCommand = positionals[1];
      if (subCommand === 'show') {
        const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
        const config = loadConfig(configPath);
        await handleWalletShow(config, values.password as string | undefined);
      } else {
        console.error(
          'Usage: townhouse wallet show [-c <path>] [--password <pw>]'
        );
        process.exitCode = 1;
      }
      break;
    }
    case 'status': {
      const configPath = (values['config'] as string) ?? DEFAULT_CONFIG_PATH;
      const rawUnits = (values['units'] as string | undefined) ?? 'usdc';
      if (rawUnits !== 'usdc' && rawUnits !== 'sats') {
        console.error(`--units must be 'usdc' or 'sats'`);
        process.exitCode = 1;
        break;
      }
      let satsPerUsdc: number | undefined;
      if (rawUnits === 'sats') {
        const r = resolveSatsRate(
          values as Record<string, unknown>,
          process.env
        );
        if ('error' in r) {
          console.error(r.error);
          process.exitCode = 1;
        } else {
          satsPerUsdc = r.rate;
        }
      }
      const units = rawUnits as 'usdc' | 'sats';
      await handleStatus(
        dockerInstance ?? new Docker(),
        loadConfig(configPath),
        { units, satsPerUsdc, configPath }
      );
      break;
    }
    case 'up': {
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      const docker = dockerInstance ?? new Docker();
      const profiles = resolveProfiles(values, config);
      await handleUp(
        configPath,
        config,
        profiles,
        docker,
        values.password as string | undefined,
        values['dry-run'] === true
      );
      break;
    }
    case 'down': {
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      const docker = dockerInstance ?? new Docker();
      await handleDown(config, docker);
      break;
    }
    case 'channels':
    case 'metrics':
    case 'logs':
    case 'peer':
    case 'health': {
      await dispatchDrillCommand(command, {
        adminUrl: HS_CONNECTOR_ADMIN_URL,
        apiUrl: HS_TOWNHOUSE_API_URL,
        values: values as Record<string, unknown>,
        positionals,
        docker: dockerInstance,
      });
      break;
    }
    case 'hs': {
      const action = positionals[1];
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      const docker = dockerInstance ?? new Docker();
      const configDir = dirname(configPath);
      if (action === 'up') {
        await handleHsUp(configPath, configDir, config, docker, {
          password: values.password as string | undefined,
          force: values.force === true,
          hsOverrides,
        });
      } else if (action === 'down') {
        await handleHsDown(configDir, config, docker, {
          rotateKeys: values['rotate-keys'] === true,
          hsOverrides,
        });
      } else {
        console.error(
          'Usage: townhouse hs <up|down> [--rotate-keys] [--password <pw>] [-c <path>]'
        );
        process.exitCode = 1;
      }
      break;
    }
    case 'node': {
      const action = positionals[1];
      const jsonMode = values.json === true;
      const yesMode = values.yes === true;
      const nodeApiUrl = nodeCommandOverrides?.apiUrl ?? HS_TOWNHOUSE_API_URL;

      if (!action) {
        console.log(NODE_HELP);
        throw new CliHelpRequested();
      }

      switch (action) {
        case 'add': {
          const typeArg = positionals[2] ?? 'town';
          await handleNodeAdd(typeArg, {
            json: jsonMode,
            apiUrl: nodeApiUrl,
            fetch: nodeCommandOverrides?.fetch,
            confirm: nodeCommandOverrides?.confirm,
          });
          break;
        }
        case 'remove': {
          const idArg = positionals[2] ?? '';
          await handleNodeRemove(idArg, {
            yes: yesMode,
            json: jsonMode,
            apiUrl: nodeApiUrl,
            fetch: nodeCommandOverrides?.fetch,
            confirm: nodeCommandOverrides?.confirm,
          });
          break;
        }
        case 'list': {
          await handleNodeList({
            json: jsonMode,
            apiUrl: nodeApiUrl,
            fetch: nodeCommandOverrides?.fetch,
          });
          break;
        }
        default: {
          // Sanitize to prevent log injection
          // eslint-disable-next-line no-control-regex
          const safeAction = action.replace(/[\x00-\x1f\x7f]/g, '');
          console.error(`Unknown node subcommand: ${safeAction}`);
          console.log(NODE_HELP);
          process.exitCode = 1;
        }
      }
      break;
    }
    default: {
      // Sanitize user input to prevent log injection (CWE-117)
      // eslint-disable-next-line no-control-regex
      const sanitized = command.replace(/[\x00-\x1f\x7f]/g, '');
      console.error(`Unknown command: ${sanitized}`);
      console.log(HELP_TEXT);
      process.exitCode = 1;
    }
  }
}

// Self-invoke when run as entrypoint.
const invokedFile = process.argv[1];
const invokedDirectly =
  typeof invokedFile === 'string' &&
  import.meta.url === pathToFileURL(invokedFile).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof CliHelpRequested) {
      process.exit(0);
    }
    console.error('[Townhouse] Error:', error);
    process.exit(1);
  });
}
