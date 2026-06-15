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
  readFileSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { stringify } from 'yaml';
import Docker from 'dockerode';
import { nip19 } from 'nostr-tools';

import { getDefaultConfig } from './config/defaults.js';
import type { NetworkMode } from './config/schema.js';
import { loadConfig, saveConfig } from './config/loader.js';
import type { TownhouseConfig, ChainProviderEntry } from './config/schema.js';
import { DockerOrchestrator, OrchestratorError } from './docker/index.js';
import type { NodeType } from './docker/types.js';
import {
  ConnectorAdminClient,
  TransportProbe,
  DEFAULT_ATOR_PROXY,
  writeHsConnectorConfig,
  writeDirectConnectorConfig,
  detectExistingHsConfig,
  writeHsNodeEnvFile,
} from './connector/index.js';
import { materializeComposeTemplate } from './compose-loader.js';
import type { ComposeLoaderOptions } from './compose-loader.js';
import { BootReconciler } from './reconciler.js';
import {
  rebindChildContainers,
  type RebindDeps,
  type RebindSummary,
} from './rebind.js';
import { resolvePublicBtpUrl } from './state/node-env.js';
import { listSupportedSettlementAssets } from './config/supported-tokens.js';
import { createApiServer } from './api/server.js';
import { createWizardApiServer } from './api/wizard-server.js';
import type { ApiServer } from './api/index.js';
import { RealBrowserOpener } from './cli/browser-opener.js';
import type { BrowserOpener } from './cli/browser-opener.js';
import { OnboardingRibbon } from './cli/onboarding-ribbon.js';
import { renderFailure } from './cli/failure-copy.js';
import { promptPassword } from './cli/password-prompt.js';
import {
  checkHsPortCollisions,
  checkDirectPortCollisions,
  formatCollisionMessage,
  type PortCollision,
} from './cli/preflight-ports.js';
import { PullNarrator } from './cli/pull-narrator.js';
import {
  readImageManifest,
  isSyntheticDigest,
} from './state/image-manifest.js';
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
import type { NodeKeyInfo } from './wallet/index.js';
import type { TurboTokenId } from './wallet/turbo-signer.js';
import { buyCredits } from './credits/buy.js';
import { getCreditBalance } from './credits/balance.js';
import { formatTokenAmount, formatWincAsBytes } from './credits/units.js';
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

/**
 * This package's version, read from its own package.json at runtime. Used by
 * `townhouse --version` so tooling that shells out (e.g. @toon-protocol/
 * townhouse-mcp's version-skew probe) has a real version to compare against.
 * Resolves `../package.json` relative to the module — package root from
 * `dist/cli.js`, and `packages/townhouse/package.json` under vitest/src.
 */
export function readCliVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const HELP_TEXT = `townhouse — TOON node orchestrator

Usage:
  townhouse --version [--json]                    Print the package version (--json: { "version" })
  townhouse setup [--no-browser] [--port <n>] [--config-dir <dir>]  Run the first-run setup wizard
  townhouse init [--force] [--config-dir <dir>] [--password <pw>] [--preset <name>] [--network <mode>] [--yes] [--json]   Initialize config + wallet (set TOWNHOUSE_MNEMONIC + no password = config-only, no encrypted wallet)
  townhouse up [--transport direct|hs] [--dev] [--town] [--mill] [--dvm] [-c <path>] [--password <pw>]
                                                 Boot a direct-BTP apex + children (default; clients dial ws://host:3000/btp). --transport hs = HS path; --dev = contributor children-only dev stack
  townhouse down [-c <path>] [--json]            Stop all nodes
  townhouse status [-c <path>] [--json]          Show node status
  townhouse metrics [-c <path>]                  Show connector metrics
  townhouse wallet show [--json] [--hex] [--paths] [-c <path>] [--password <pw>]  Show derived addresses
  townhouse wallet seed --confirm [-c <path>] [--password <pw>] [--json]    Print the BIP-39 seed phrase (password-gated, requires --confirm)
  townhouse credits buy --token <id> --amount <decimal> [--fee-multiplier <n>] [--quote-only] [--yes] [-c <path>] [--password <pw>]
                                                 Buy Arweave upload credits (token: eth|sol|pol|base-eth|base-usdc|usdc-eth|usdc-pol)
  townhouse credits balance --token <id> [-c <path>] [--password <pw>]  Show Turbo credit balance for the funding address
  townhouse hs up [--password <pw>] [--skip-preflight] [-c <path>]  Boot/enable hidden-service mode (opt-in, anonymous .anon apex) (launches dashboard TUI in TTY mode)
  townhouse hs enable [--password <pw>] [-c <path>] [--json]   Switch a running direct apex to hidden-service mode (down direct → up HS; --json emits NDJSON boot steps)
  townhouse hs down [--rotate-keys] [-c <path>]               Stop apex (--rotate-keys deletes .anyone keypair)
  townhouse node add [<type>] [--json] [-c <path>]    Provision a child node (default: town)
  townhouse node remove <id> [--yes] [--json] [-c <path>]   Deprovision a child node
  townhouse node list [--json] [-c <path>]            List provisioned nodes
  townhouse chains list [--json] [-c <path>]          List configured settlement chains (EVM/Solana/Mina)
  townhouse chains add --chain-type <evm|solana|mina> --chain-id <id> [fields] [-c <path>]   Add/update a settlement chain
  townhouse chains remove <chainId> [-c <path>]       Remove a settlement chain
  townhouse channels [--json]                    Show open payment channels
  townhouse logs <node-id> [-f|--follow] [--lines N] [--json]   Tail logs for a node (Ctrl-C to stop)
  townhouse peer <id> [--json]                   Show per-peer detail card
  townhouse health [--json]                      Probe apex/api/nodes/.anyone health
  townhouse --help                               Show this help

Flags:
  --transport    up transport: direct (default; plain ws://host:3000/btp apex) | hs (hidden-service apex, == \`hs up\`)
  --dev          up: boot the contributor children-only dev stack (profile:'dev') instead of the direct apex
  --town         Start Town (Nostr relay) node
  --mill         Start Mill (swap) node
  --dvm          Start DVM (compute) node
  --password     Wallet password (non-interactive mode)
  --rotate-keys  Delete the .anyone keypair volume on hs down (produces a new address on next hs up)
  --skip-preflight  Skip the port-collision preflight check on hs up (escape hatch)
  --no-browser   Skip opening the browser automatically (setup command)
  --port         Override the API port (setup command, default 9400)
  --preset       Init from a named preset (init only). Supported: demo
  --network      Chain network for apex + nodes (init only): mainnet (default), testnet, devnet, custom
  --evm-url / --sol-url   RPC URLs for --network custom (the project's dev chains; or EVM_URL/SOL_URL env)
  --yes          Non-interactive (init only); with --preset=demo uses demo password if --password absent
  --json         Machine-readable JSON output (node commands; NDJSON for \`logs\`)
  --lines        Number of historical log lines to fetch on attach (logs command, default 50)
  -f|--follow    Accepted for \`tail -f\` muscle memory on \`logs\` (no-op — follow is default)
  With no flags, \`up\` boots a direct-BTP apex + the enabled children from config.`;

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
    options: { profile: 'hs' | 'direct'; composePath: string }
  ) => {
    up: (profiles: NodeType[]) => Promise<void>;
    down: () => Promise<void>;
    on: (event: string, handler: (...args: unknown[]) => void) => unknown;
    /**
     * Pre-pull a single image ref (Epic 49 Followup D).
     * Optional on the stub interface — when omitted on a real orchestrator,
     * the cold-pull narration phase is skipped (silent degrade).
     */
    pullImage?: (image: string) => Promise<void>;
    /**
     * Start/recreate a child node container with the given env overlay. Used by
     * the boot rebinder; optional on the stub so existing tests that don't
     * provision children need not implement it.
     */
    startNodeViaCompose?: (
      type: NodeType,
      env: Record<string, string>
    ) => Promise<void>;
  };
  /**
   * Override the boot rebinder (auto-rebind of child containers on `hs up`).
   * Tests inject a spy to assert wiring without touching Docker/the wallet.
   * When omitted, the default calls the real `rebindChildContainers`.
   */
  rebindChildren?: (deps: RebindDeps) => Promise<RebindSummary>;
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
  /**
   * Override the port-collision preflight check (Epic 49 Followup B).
   * Default invokes `checkHsPortCollisions(docker)` from
   * `./cli/preflight-ports.js`. Tests inject a stub that returns either
   * `[]` (happy path) or a fabricated PortCollision[] (collision path) so
   * the production socket-bind + Docker enrichment is not exercised in
   * unit tests.
   */
  checkPortCollisions?: (docker: Docker) => Promise<PortCollision[]>;
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

/**
 * Print the "what now" call-to-action after init. The journey from `init` to a
 * running node is the moment a first-timer is most likely to stall, so init must
 * hand them the exact next command. When a non-default config dir is used, the
 * next command needs an explicit `-c <path>`.
 */
function printInitNextStep(dir: string): void {
  const isDefaultDir = dir === resolve(DEFAULT_CONFIG_DIR);
  const cmd = isDefaultDir
    ? 'npx @toon-protocol/townhouse hs up'
    : `npx @toon-protocol/townhouse hs up -c ${join(dir, 'config.yaml')}`;
  console.log('');
  console.log('Next — start your node:');
  console.log(`  ${cmd}`);
  console.log('');
  console.log(
    'First run pulls container images and bootstraps a hidden service.'
  );
  console.log('It can take a few minutes; progress is shown throughout.');
}

async function handleInit(
  force: boolean,
  configDir?: string,
  password?: string,
  preset?: 'demo',
  yes?: boolean,
  network?: NetworkMode,
  endpoints?: { evmUrl?: string; solUrl?: string },
  json = false
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
      if (!json) {
        console.log(
          '[demo preset] Using deterministic demo password (insecure — demo only).'
        );
      }
    }
  } else {
    configToWrite = getDefaultConfig();
    // Override wallet path to use the config dir, not the default home-dir path.
    // getDefaultConfig() hardcodes ~/.townhouse/wallet.enc; tests and non-default
    // config dirs need the wallet collocated with config.yaml.
    configToWrite.wallet.encrypted_path = join(dir, 'wallet.enc');
  }
  // Persist the network mode (mainnet/testnet/devnet/custom). Drives chain/RPC
  // config for the apex connector and every node container
  // (resolveNetworkProfile). `custom` + `endpoints` carries operator-supplied
  // RPC URLs pointing at the project's dev chains (e.g. the Akash anvil/solana).
  if (network !== undefined) {
    configToWrite.network = network;
  }
  if (endpoints && (endpoints.evmUrl || endpoints.solUrl)) {
    configToWrite.endpoints = endpoints;
  }
  const yamlContent = stringify(configToWrite);
  writeFileSync(configPath, yamlContent, {
    encoding: 'utf-8',
    mode: 0o600,
  });

  if (!json) console.log(`Config created at ${configPath}`);

  // Generate wallet — use config dir for wallet path (overrides default home dir path)
  const walletPath = join(dir, 'wallet.enc');

  // Mnemonic mode (design §3): when TOWNHOUSE_MNEMONIC is set and no wallet
  // password is supplied, scaffold config ONLY — derive + report addresses from
  // the env seed without writing an encrypted wallet. The stack loads the seed
  // directly at `up` time (P1: tryEnvMnemonicWallet), so no wallet.enc /
  // password is needed. Lets an agent operator init non-interactively.
  const envMnemonic = process.env['TOWNHOUSE_MNEMONIC']?.trim();
  const suppliedPassword = password ?? process.env['TOWNHOUSE_WALLET_PASSWORD'];
  if (envMnemonic && !suppliedPassword) {
    const walletManager = new WalletManager({ encryptedPath: walletPath });
    await walletManager.fromMnemonic(envMnemonic);
    const addresses = walletManager.getAllKeys().map((info) => ({
      nodeType: info.nodeType,
      nostrPubkey: info.nostrPubkey,
      evmAddress: info.evmAddress,
    }));
    walletManager.lock();

    if (json) {
      // No `mnemonic` (the agent already holds it via the env) and no
      // `walletPath` (none written) — a distinct shape from the encrypted path.
      console.log(
        JSON.stringify({
          created: true,
          configPath,
          walletMode: 'mnemonic',
          addresses,
        })
      );
      return;
    }

    console.log('');
    console.log(
      'Mnemonic mode — using TOWNHOUSE_MNEMONIC (no encrypted wallet written).'
    );
    console.log('');
    console.log('Derived Node Addresses:');
    console.log('-----------------------');
    for (const info of addresses) {
      console.log(`  ${info.nodeType.padEnd(6)} Nostr: ${info.nostrPubkey}`);
      console.log(`  ${''.padEnd(6)} EVM:   ${info.evmAddress}`);
    }
    printInitNextStep(dir);
    return;
  }

  if (existsSync(walletPath) && !force) {
    if (json) {
      console.log(JSON.stringify({ created: false, configPath, walletPath }));
      return;
    }
    console.log('');
    console.log(
      `Wallet already exists at ${walletPath} — keeping your existing keys.`
    );
    console.log(
      'Your seed phrase from the first run is still valid; nothing changed.'
    );
    console.log(
      '(Re-run with --force to regenerate, which REPLACES your keys.)'
    );
    printInitNextStep(dir);
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

  if (!json) {
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
  }

  // Encrypt and save — mnemonic reference is not stored beyond this block
  const encrypted = encryptWallet(mnemonic, walletPassword);
  await saveWallet(walletPath, encrypted);
  if (!json) console.log(`Wallet saved to ${walletPath}`);

  const allKeys = walletManager.getAllKeys();
  const addresses = allKeys.map((info) => ({
    nodeType: info.nodeType,
    nostrPubkey: info.nostrPubkey,
    evmAddress: info.evmAddress,
  }));

  if (json) {
    // The agent is the custodian — return the mnemonic for cold-start backup
    // (docs/townhouse-mcp-design.md §3). Zero key material afterwards.
    console.log(
      JSON.stringify({
        created: true,
        configPath,
        walletPath,
        mnemonic,
        addresses,
      })
    );
    walletManager.lock();
    return;
  }

  // Display derived addresses
  console.log('');
  console.log('Derived Node Addresses:');
  console.log('-----------------------');
  for (const info of addresses) {
    console.log(`  ${info.nodeType.padEnd(6)} Nostr: ${info.nostrPubkey}`);
    console.log(`  ${''.padEnd(6)} EVM:   ${info.evmAddress}`);
  }

  // Zero key material
  walletManager.lock();

  printInitNextStep(dir);
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

/**
 * Per-node role description shown above the address rows in the cards layout.
 * Mirrors Sally's round-4 wallet-show sketch.
 */
const NODE_ROLE_DESCRIPTIONS: Record<NodeType, string> = {
  town: 'Nostr relay — earns ILP fees per event relayed.',
  mill: 'Multi-chain swap peer — settles cross-chain swaps for fees.',
  dvm: 'Compute / DVM worker — collects job payments, signs Arweave uploads.',
};

/** Per-address purpose labels (one per key type per node). */
interface AddressRow {
  label: string; // e.g. "Nostr", "EVM", "SOL", "Mina", "AR"
  value: string; // e.g. npub1..., 0x..., base58..., AR address, or "—"
  purpose: string; // short trailing parenthetical
  hex?: string | undefined; // raw hex pubkey shown under npub when --hex
  path?: string | undefined; // derivation path shown when --paths
}

/**
 * Build the per-row address records for one node's card. Returns rows in
 * fixed presentation order (Nostr → EVM → chain rows). Optional rows render
 * as `—` when the underlying key is absent (e.g. Town has no SOL).
 */
function buildNodeRows(
  info: NodeKeyInfo,
  options: { hex: boolean; paths: boolean }
): AddressRow[] {
  const rows: AddressRow[] = [];

  // Nostr — always present. Encode as NIP-19 npub for the primary display.
  const npub = nip19.npubEncode(info.nostrPubkey);
  const nostrPurposeByNode: Record<NodeType, string> = {
    town: 'share this to be found',
    mill: 'announces swap quotes',
    dvm: 'offers DVM services',
  };
  rows.push({
    label: 'Nostr',
    value: npub,
    purpose: nostrPurposeByNode[info.nodeType],
    hex: options.hex ? info.nostrPubkey : undefined,
    path: options.paths ? info.nostrDerivationPath : undefined,
  });

  // EVM — always present.
  const evmPurposeByNode: Record<NodeType, string> = {
    town: 'receives ILP earnings',
    mill: 'settles EVM swaps',
    dvm: 'collects job payments',
  };
  rows.push({
    label: 'EVM',
    value: info.evmAddress,
    purpose: evmPurposeByNode[info.nodeType],
    path: options.paths ? info.evmDerivationPath : undefined,
  });

  // SOL — present for every node after Phase 1 (graceful fallback if absent).
  const solPurposeByNode: Record<NodeType, string> = {
    town: 'receives swap fills',
    mill: 'settles SOL swaps',
    dvm: 'spends Arweave credits',
  };
  rows.push({
    label: 'SOL',
    value: info.solanaAddress ?? '—',
    purpose: solPurposeByNode[info.nodeType],
    path: options.paths ? info.solanaDerivationPath : undefined,
  });

  // Mill-only: Mina row after SOL.
  if (info.nodeType === 'mill') {
    rows.push({
      label: 'Mina',
      value: info.minaAddress ?? '—',
      purpose: 'settles Mina swaps',
      // Mina derivation path is not currently surfaced through NodeKeyInfo.
    });
  }

  // DVM-only: Arweave row appended after SOL.
  if (info.nodeType === 'dvm') {
    rows.push({
      label: 'AR',
      value: info.arweaveAddress ?? '—',
      purpose: 'signs Arweave uploads',
      path: options.paths ? info.arweaveDerivationPath : undefined,
    });
  }

  return rows;
}

/**
 * Render one node card to stdout using box-drawing characters consistent
 * with the existing CLI aesthetic (see HELP_TEXT, status output).
 *
 *   ┌─ TOWN ──── Nostr relay — earns ILP fees ────────┐
 *   │ Nostr   npub1abc...                              │
 *   │   (share this to be found)                       │
 *   │ EVM     0xAbC...                                 │
 *   │   (receives ILP earnings)                        │
 *   └──────────────────────────────────────────────────┘
 *
 * Width is calculated from the widest row; the border auto-fits.
 */
function renderNodeCard(info: NodeKeyInfo, rows: AddressRow[]): string {
  // Compose inner content lines (no border yet, no leading "│ ").
  const role = NODE_ROLE_DESCRIPTIONS[info.nodeType];
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const headerLine = `${info.nodeType.toUpperCase()} — ${role}`;

  const bodyLines: string[] = [];
  for (const row of rows) {
    bodyLines.push(`${row.label.padEnd(labelWidth)}  ${row.value}`);
    bodyLines.push(`${' '.repeat(labelWidth)}    (${row.purpose})`);
    if (row.hex) {
      bodyLines.push(`${' '.repeat(labelWidth)}    hex: ${row.hex}`);
    }
    if (row.path) {
      bodyLines.push(`${' '.repeat(labelWidth)}    path: ${row.path}`);
    }
  }

  const innerWidth = Math.max(
    headerLine.length,
    ...bodyLines.map((l) => l.length)
  );
  // Leave 1 char of padding on each side.
  const totalInner = innerWidth + 2;
  const horizontal = '─'.repeat(totalInner);
  const top = `┌${horizontal}┐`;
  const bottom = `└${horizontal}┘`;

  const lines: string[] = [];
  lines.push(top);
  lines.push(`│ ${headerLine.padEnd(innerWidth)} │`);
  // Separator under the header to set off the role text from rows.
  lines.push(`├${horizontal}┤`);
  for (const body of bodyLines) {
    lines.push(`│ ${body.padEnd(innerWidth)} │`);
  }
  lines.push(bottom);
  return lines.join('\n');
}

/**
 * Build the structured JSON payload for `wallet show --json`. Schema is
 * documented in the plan; consumers like `jq` rely on the field names below.
 */
function buildWalletJson(allKeys: NodeKeyInfo[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const info of allKeys) {
    const node: Record<string, unknown> = {
      nostr: {
        npub: nip19.npubEncode(info.nostrPubkey),
        hex: info.nostrPubkey,
        path: info.nostrDerivationPath,
      },
      evm: { address: info.evmAddress, path: info.evmDerivationPath },
    };
    if (info.solanaAddress) {
      node['sol'] = {
        address: info.solanaAddress,
        path: info.solanaDerivationPath,
      };
    }
    if (info.nodeType === 'mill' && info.minaAddress) {
      node['mina'] = { address: info.minaAddress };
    }
    if (info.nodeType === 'dvm' && info.arweaveAddress) {
      node['arweave'] = {
        address: info.arweaveAddress,
        path: info.arweaveDerivationPath,
      };
    }
    out[info.nodeType] = node;
  }
  return out;
}

/**
 * Extended `townhouse wallet show` (epic-49, Phase 3).
 *
 * Default output: cards layout (one card per node) using box-drawing
 * characters. Shows NIP-19 npub by default; hex hidden unless --hex.
 * Per Sally's round-4 sketch: role description line above the rows, plus
 * per-row purpose labels (e.g. "receives ILP earnings").
 *
 * Flags:
 *   --json   structured machine-readable output instead of cards
 *   --hex    append a hex pubkey line under each Nostr npub
 *   --paths  append a derivation-path line under each address
 *
 * Side effects: triggers `ensureArweaveKey('dvm')` once — RSA-4096 derivation
 * is 5–30s on first call per unlocked session, then cached. A "deriving…"
 * status line is printed to stderr so the operator knows why it's pausing.
 */
async function handleWalletShow(
  config: TownhouseConfig,
  password?: string,
  options: { json?: boolean; hex?: boolean; paths?: boolean } = {}
): Promise<void> {
  const walletPath = config.wallet.encrypted_path;
  // TOWNHOUSE_MNEMONIC (direct, no password) OR encrypted wallet + password.
  // P1 / docs/townhouse-mcp-design.md §3.
  let walletManager: WalletManager | undefined =
    (await tryEnvMnemonicWallet(walletPath)) ?? undefined;
  let walletPassword: string | undefined;
  if (!walletManager) {
    const result = await loadWallet(walletPath);
    if (!result) {
      console.error(
        'No wallet found. Run `townhouse init` first (or set TOWNHOUSE_MNEMONIC).'
      );
      process.exitCode = 1;
      return;
    }
    if (result.permissionsWarning) {
      console.error(result.permissionsWarning);
    }
    walletPassword = password ?? process.env['TOWNHOUSE_WALLET_PASSWORD'];
    if (!walletPassword) {
      console.error(
        'Wallet password required. Use --password flag or TOWNHOUSE_WALLET_PASSWORD env var (or set TOWNHOUSE_MNEMONIC).'
      );
      process.exitCode = 1;
      return;
    }
    walletManager = new WalletManager({ encryptedPath: walletPath });
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
  }

  try {
    // Derive DVM's Arweave key before rendering so the AR address row is
    // populated. RSA-4096 generation is 5–30s on first call per unlocked
    // session — emit a status line to stderr so the operator knows why
    // we're pausing. Subsequent calls in the same session are instant.
    // On failure (unsupported platform, etc.) we degrade gracefully and
    // render the AR row as `—` rather than aborting `wallet show`.
    const arStartMs = Date.now();
    // Spinner-style status — only worth emitting if the call actually pauses.
    // Cache hit returns in <100ms; cold derivation pays the 5–30s. We can't
    // know up front which path will run, so we set a 200ms timer that prints
    // the status only when needed, and clear it on completion.
    const arStatusTimer = setTimeout(() => {
      process.stderr.write('deriving Arweave key (first run, ~15s)...\n');
    }, 200);
    try {
      await walletManager.ensureArweaveKey('dvm', walletPassword);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Warning: Arweave key derivation failed (${msg}). AR address will display as '—'.`
      );
    } finally {
      clearTimeout(arStatusTimer);
      void arStartMs; // keep var alive for potential timing log
    }

    const allKeys = walletManager.getAllKeys();

    if (options.json) {
      console.log(JSON.stringify(buildWalletJson(allKeys), null, 2));
      return;
    }

    const renderOpts = {
      hex: options.hex === true,
      paths: options.paths === true,
    };
    for (const info of allKeys) {
      const rows = buildNodeRows(info, renderOpts);
      console.log(renderNodeCard(info, rows));
      console.log(''); // blank line between cards
    }

    // Trailing tips block — guides the operator to scripting and the
    // related credit-funding command added in Phase 2.
    console.log('Tip: townhouse wallet show --json   for scripting');
    console.log('     townhouse wallet show --hex    to see raw hex pubkeys');
    console.log('     townhouse wallet show --paths  to see derivation paths');
    console.log(
      '     townhouse credits buy --token sol --amount <n>  to fund Arweave uploads'
    );
  } finally {
    // Zero key material immediately after display
    walletManager.lock();
  }
}

/**
 * `townhouse wallet seed --confirm` (epic-49, Phase 3).
 *
 * Reveals the BIP-39 mnemonic for recovery. Requires --confirm so it's
 * impossible to leak the seed by typing the wrong subcommand at a public
 * terminal. Same password-sourcing chain as the rest of the wallet commands.
 *
 * Closes the "I scrolled past the init banner in tmux" footgun without
 * inventing a new backup channel (clipboard, QR, encrypted USB, etc.).
 */
async function handleWalletSeed(
  config: TownhouseConfig,
  password: string | undefined,
  confirm: boolean,
  json = false
): Promise<void> {
  if (!confirm) {
    console.error(
      'This command will print your seed phrase to your terminal. Re-run with --confirm to acknowledge.'
    );
    process.exitCode = 1;
    return;
  }

  const walletPath = config.wallet.encrypted_path;
  // TOWNHOUSE_MNEMONIC (direct, no password) OR encrypted wallet + password. In
  // mnemonic mode `getMnemonic()` returns the env seed — P1 / §3.
  let walletManager: WalletManager | undefined =
    (await tryEnvMnemonicWallet(walletPath)) ?? undefined;
  if (!walletManager) {
    const result = await loadWallet(walletPath);
    if (!result) {
      console.error(
        'No wallet found. Run `townhouse init` first (or set TOWNHOUSE_MNEMONIC).'
      );
      process.exitCode = 1;
      return;
    }
    if (result.permissionsWarning) {
      console.error(result.permissionsWarning);
    }

    const walletPassword = password ?? process.env['TOWNHOUSE_WALLET_PASSWORD'];
    if (!walletPassword) {
      console.error(
        'Wallet password required. Use --password flag or TOWNHOUSE_WALLET_PASSWORD env var (or set TOWNHOUSE_MNEMONIC).'
      );
      process.exitCode = 1;
      return;
    }

    walletManager = new WalletManager({ encryptedPath: walletPath });
    try {
      await walletManager.fromMnemonic(
        decryptWallet(result.wallet, walletPassword)
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to decrypt wallet: ${msg}`);
      process.exitCode = 1;
      return;
    }
  }

  try {
    const mnemonic = walletManager.getMnemonic();
    if (!mnemonic) {
      // Shouldn't happen — fromMnemonic just succeeded — but defend against
      // races with concurrent lock() calls in long-running test processes.
      console.error('Internal error: mnemonic unavailable after unlock.');
      process.exitCode = 1;
      return;
    }

    if (json) {
      console.log(JSON.stringify({ mnemonic }));
      return;
    }

    // ASCII-only warning banner — CLAUDE.md forbids emojis unless requested.
    console.log(
      '============================================================='
    );
    console.log(' [!] Anyone who sees this seed owns your townhouse identity.');
    console.log(' [!] Anyone who records this terminal owns your earnings.');
    console.log(
      ' [!] Shoulder-surf, screen-shares, and tmux logs are vectors.'
    );
    console.log(
      '============================================================='
    );
    console.log('');
    console.log('');
    console.log(`  ${mnemonic}`);
    console.log('');
    console.log('');
    console.log(
      'This is the same 12 words shown at `townhouse init`. Storing them elsewhere is your responsibility.'
    );
  } finally {
    walletManager.lock();
  }
}

// ── Credits commands (epic-49, Phase 2) ────────────────────────────────────

/**
 * Set of valid `--token` values for credits commands. Must stay in sync with
 * `TurboTokenId` in wallet/turbo-signer.ts.
 */
const VALID_TURBO_TOKENS: ReadonlySet<TurboTokenId> = new Set([
  'eth',
  'pol',
  'base-eth',
  'base-usdc',
  'usdc-eth',
  'usdc-pol',
  'sol',
  'ar',
]);

function isTurboTokenId(value: string): value is TurboTokenId {
  return VALID_TURBO_TOKENS.has(value as TurboTokenId);
}

/**
 * Resolve the wallet password from --password → env var → TTY prompt → error.
 * Returns the resolved password string OR null when no source is available
 * (caller should set exitCode=1 and return).
 */
async function resolveWalletPassword(
  flagPassword: string | undefined
): Promise<string | null> {
  const envPassword = process.env['TOWNHOUSE_WALLET_PASSWORD'];
  if (flagPassword) return flagPassword;
  if (envPassword) return envPassword;
  if (process.stdin.isTTY) {
    return await promptPassword('Wallet password: ');
  }
  return null;
}

/**
 * P1 — operator/agent wallet mode. When `TOWNHOUSE_MNEMONIC` is set, load the
 * operator wallet DIRECTLY from that mnemonic: no encrypted wallet file and no
 * password. Returns an unlocked {@link WalletManager}, or `null` when the env
 * var is unset (callers then fall back to the encrypted-wallet + password
 * flow). The agent owns the funds, so a single env-var secret replaces the
 * password indirection — see docs/townhouse-mcp-design.md §3.
 *
 * In this mode the encrypted wallet file is irrelevant — the on-disk AR cache
 * (keyed by the operator password) is simply skipped; `ensureArweaveKey` then
 * pays the full RSA cost without a password.
 */
async function tryEnvMnemonicWallet(
  walletPath: string
): Promise<WalletManager | null> {
  const mnemonic = process.env['TOWNHOUSE_MNEMONIC']?.trim();
  if (!mnemonic) return null;
  const walletManager = new WalletManager({ encryptedPath: walletPath });
  await walletManager.fromMnemonic(mnemonic);
  return walletManager;
}

/**
 * Read a single y/N answer from stdin, defaulting to N on empty input.
 * Mirrors the existing readline-based prompt in `hs down --rotate-keys`.
 */
async function promptYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline');
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

/**
 * Handle `townhouse credits buy --token <id> --amount <decimal> [...]`.
 *
 * Flow: parse argv → resolve password → unlock wallet → fetch quote →
 * (unless --yes) ask for confirmation → submit topUpWithTokens → stream
 * status to stdout.
 *
 * For the testable contract: returns void, sets process.exitCode on failure
 * paths, writes status to stdout. Pure infrastructure happens in
 * `credits/buy.ts`.
 */
async function handleCreditsBuy(
  config: TownhouseConfig,
  values: Record<string, unknown>,
  nodeType: NodeType = 'dvm'
): Promise<void> {
  // ── 1. Argv validation ──
  const tokenRaw = values['token'] as string | undefined;
  const amountRaw = values['amount'] as string | undefined;
  if (!tokenRaw || !amountRaw) {
    console.error(
      'Usage: townhouse credits buy --token <id> --amount <decimal> [--fee-multiplier <n>] [--credit-destination <addr>] [--quote-only] [--yes]'
    );
    process.exitCode = 1;
    return;
  }
  if (!isTurboTokenId(tokenRaw)) {
    console.error(
      `Unknown token '${tokenRaw}'. Supported: ${Array.from(VALID_TURBO_TOKENS).join(', ')}`
    );
    process.exitCode = 1;
    return;
  }
  const token: TurboTokenId = tokenRaw;

  let feeMultiplier: number | undefined;
  const feeRaw = values['fee-multiplier'] as string | undefined;
  if (feeRaw !== undefined) {
    const parsed = Number(feeRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(
        `--fee-multiplier must be a positive number, got '${feeRaw}'`
      );
      process.exitCode = 1;
      return;
    }
    feeMultiplier = parsed;
  }
  const quoteOnly = values['quote-only'] === true;
  const skipConfirm = values['yes'] === true;
  const destinationOverride = values['credit-destination'] as
    | string
    | undefined;
  const json = values['json'] === true;
  // --json is non-interactive: a submit must be pre-confirmed with --yes (the
  // y/N prompt would otherwise stall a machine consumer like the MCP server).
  if (json && !quoteOnly && !skipConfirm) {
    console.error('credits buy --json requires --yes (non-interactive).');
    process.exitCode = 1;
    return;
  }

  // ── 2. Wallet unlock ──
  // TOWNHOUSE_MNEMONIC (direct, no password) OR encrypted wallet + password. P1.
  const walletPath = config.wallet.encrypted_path;
  let wallet: WalletManager | undefined =
    (await tryEnvMnemonicWallet(walletPath)) ?? undefined;
  let resolvedPassword: string | undefined;
  if (!wallet) {
    const loaded = await loadWallet(walletPath);
    if (!loaded) {
      console.error(
        `No wallet found at ${walletPath}. Run \`townhouse init\` first (or set TOWNHOUSE_MNEMONIC).`
      );
      process.exitCode = 1;
      return;
    }
    if (loaded.permissionsWarning) console.error(loaded.permissionsWarning);

    resolvedPassword =
      (await resolveWalletPassword(values['password'] as string | undefined)) ??
      undefined;
    if (!resolvedPassword) {
      console.error(
        'Wallet password required. Use --password flag or TOWNHOUSE_WALLET_PASSWORD env var (or set TOWNHOUSE_MNEMONIC).'
      );
      process.exitCode = 1;
      return;
    }

    wallet = new WalletManager({ encryptedPath: walletPath });
    try {
      await wallet.fromMnemonic(decryptWallet(loaded.wallet, resolvedPassword));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to decrypt wallet: ${msg}`);
      process.exitCode = 1;
      return;
    }
  }

  try {
    // ── 3. Resolve credit destination ──
    // Funding from EVM/SOL must route credits to the DVM's Arweave address so
    // the DVM container's ArweaveSigner can spend them. Funding from `ar`
    // already targets that address natively (signer === destination). An
    // explicit --credit-destination flag overrides both behaviors.
    let destinationAddress: string | undefined;
    if (destinationOverride) {
      destinationAddress = destinationOverride;
    } else if (token !== 'ar' && nodeType === 'dvm') {
      if (!json) {
        process.stdout.write(
          `Resolving DVM Arweave credit address (first run, ~10s)...\n`
        );
      }
      await wallet.ensureArweaveKey('dvm', resolvedPassword);
      const dvmKeys = wallet.getNodeKeys('dvm');
      if (!dvmKeys.arweaveAddress) {
        throw new Error(
          'DVM Arweave address not populated after ensureArweaveKey'
        );
      }
      destinationAddress = dvmKeys.arweaveAddress;
    }

    // ── 4. Quote step ──
    if (!json) {
      process.stdout.write(
        `Quoting ${amountRaw} ${token} for ${nodeType}'s credit address...\n`
      );
    }
    const quote = await buyCredits({
      wallet,
      nodeType,
      token,
      amount: amountRaw,
      quoteOnly: true,
      ...(destinationAddress ? { destinationAddress } : {}),
    });
    if (quote.kind !== 'quote') {
      throw new Error('Internal error: quoteOnly returned non-quote result');
    }
    if (!json) {
      const quotedDisplay = `${quote.winc.toString()} winc (${formatWincAsBytes(quote.winc)})`;
      process.stdout.write(
        `Quote: ${formatTokenAmount(token, quote.baseAmount)} → ${quotedDisplay}\n`
      );
      process.stdout.write(`Source address (${token}): ${quote.fromAddress}\n`);
      process.stdout.write(`Credit recipient: ${quote.creditAddress}\n`);
    }

    if (quoteOnly) {
      if (json) {
        console.log(
          JSON.stringify({
            kind: 'quote',
            token,
            baseAmount: quote.baseAmount.toString(),
            winc: quote.winc.toString(),
            bytes: formatWincAsBytes(quote.winc),
            fromAddress: quote.fromAddress,
            creditAddress: quote.creditAddress,
          })
        );
      } else {
        process.stdout.write(
          'Quote-only; no on-chain transaction submitted.\n'
        );
      }
      return;
    }

    // ── 5. Confirmation ── (json mode is pre-gated on --yes above)
    if (!skipConfirm) {
      const ok = await promptYesNo('Proceed? [y/N] ');
      if (!ok) {
        process.stdout.write('Aborted. No transaction submitted.\n');
        process.exitCode = 1;
        return;
      }
    }

    // ── 6. Submit ──
    if (!json) process.stdout.write('Submitting on-chain transaction...\n');
    const result = await buyCredits({
      wallet,
      nodeType,
      token,
      amount: amountRaw,
      ...(feeMultiplier !== undefined ? { feeMultiplier } : {}),
      ...(destinationAddress ? { destinationAddress } : {}),
    });
    if (result.kind !== 'submit') {
      throw new Error('Internal error: submit path returned non-submit result');
    }
    if (json) {
      console.log(
        JSON.stringify({
          kind: 'submit',
          token,
          id: result.id,
          status: result.status,
          winc: result.winc.toString(),
          bytes: formatWincAsBytes(result.winc),
          ...(result.block !== undefined ? { block: result.block } : {}),
        })
      );
    } else {
      process.stdout.write(`Transaction submitted: ${result.id}\n`);
      process.stdout.write(`Status: ${result.status}\n`);
      process.stdout.write(
        `Credited: ${result.winc.toString()} winc (${formatWincAsBytes(result.winc)})\n`
      );
      if (result.block !== undefined) {
        process.stdout.write(`Block: ${result.block}\n`);
      }
      process.stdout.write('Done.\n');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`credits buy failed: ${msg}`);
    process.exitCode = 1;
  } finally {
    wallet.lock();
  }
}

/**
 * Handle `townhouse credits balance --token <id>`.
 *
 * Per AC#6 (plan): require --token explicitly. The funding identity differs
 * per token family (EVM vs SOL vs AR), so there is no sensible default.
 */
async function handleCreditsBalance(
  config: TownhouseConfig,
  values: Record<string, unknown>,
  nodeType: NodeType = 'dvm'
): Promise<void> {
  const tokenRaw = values['token'] as string | undefined;
  if (!tokenRaw) {
    console.error(
      'Usage: townhouse credits balance --token <id> [-c <path>] [--password <pw>]'
    );
    process.exitCode = 1;
    return;
  }
  if (!isTurboTokenId(tokenRaw)) {
    console.error(
      `Unknown token '${tokenRaw}'. Supported: ${Array.from(VALID_TURBO_TOKENS).join(', ')}`
    );
    process.exitCode = 1;
    return;
  }
  const token: TurboTokenId = tokenRaw;

  // TOWNHOUSE_MNEMONIC (direct, no password) OR encrypted wallet + password. P1.
  const walletPath = config.wallet.encrypted_path;
  let wallet: WalletManager | undefined =
    (await tryEnvMnemonicWallet(walletPath)) ?? undefined;
  if (!wallet) {
    const loaded = await loadWallet(walletPath);
    if (!loaded) {
      console.error(
        `No wallet found at ${walletPath}. Run \`townhouse init\` first (or set TOWNHOUSE_MNEMONIC).`
      );
      process.exitCode = 1;
      return;
    }
    if (loaded.permissionsWarning) console.error(loaded.permissionsWarning);

    const resolvedPassword = await resolveWalletPassword(
      values['password'] as string | undefined
    );
    if (!resolvedPassword) {
      console.error(
        'Wallet password required. Use --password flag or TOWNHOUSE_WALLET_PASSWORD env var (or set TOWNHOUSE_MNEMONIC).'
      );
      process.exitCode = 1;
      return;
    }

    wallet = new WalletManager({ encryptedPath: walletPath });
    try {
      await wallet.fromMnemonic(decryptWallet(loaded.wallet, resolvedPassword));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to decrypt wallet: ${msg}`);
      process.exitCode = 1;
      return;
    }
  }

  const json = values['json'] === true;
  try {
    const balance = await getCreditBalance({ wallet, nodeType, token });
    if (json) {
      console.log(
        JSON.stringify({
          token,
          address: balance.address,
          winc: balance.winc.toString(),
          effectiveBalance: balance.effectiveBalance.toString(),
          bytes: formatWincAsBytes(balance.winc),
        })
      );
    } else {
      process.stdout.write(`Address (${token}): ${balance.address}\n`);
      process.stdout.write(
        `Balance: ${balance.winc.toString()} winc (${formatWincAsBytes(balance.winc)})\n`
      );
      if (balance.effectiveBalance !== balance.winc) {
        process.stdout.write(
          `Effective (incl. received approvals): ${balance.effectiveBalance.toString()} winc (${formatWincAsBytes(balance.effectiveBalance)})\n`
        );
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`credits balance failed: ${msg}`);
    process.exitCode = 1;
  } finally {
    wallet.lock();
  }
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
  opts: {
    units: 'usdc' | 'sats';
    satsPerUsdc?: number;
    configPath: string;
    json?: boolean;
  } = {
    units: 'usdc',
    configPath: DEFAULT_CONFIG_PATH,
  }
): Promise<void> {
  const json = opts.json === true;
  const orchestrator = new DockerOrchestrator(docker, config, undefined, {
    profile: 'dev',
  });
  const statuses = await orchestrator.status();

  // Accumulated for --json; the human output below mirrors it section by section.
  const payload: {
    nodes: { name: string; state: string; health?: string }[];
    hiddenServices?: { connector?: string; relay?: string };
    connector: {
      available: boolean;
      packetsForwarded?: number;
      activePeers?: number;
      totalPeers?: number;
    };
    earnings?: unknown;
  } = {
    nodes: statuses.map((s) => ({
      name: s.name,
      state: s.state,
      ...(s.health ? { health: s.health } : {}),
    })),
    connector: { available: false },
  };

  if (!json) {
    console.log('Node Status:');
    console.log('------------');
    for (const s of statuses) {
      const health = s.health ? ` (${s.health})` : '';
      console.log(`  ${s.name.padEnd(12)} ${s.state}${health}`);
    }
  }

  const connectorHs = config.transport.hiddenService;
  const relayHs = config.transport.relayHiddenService;
  const connectorUrl = connectorHs?.externalUrl ?? config.transport.externalUrl;
  if (
    config.transport.mode === 'hs' ||
    connectorHs?.externalUrl ||
    relayHs?.externalUrl ||
    config.transport.externalUrl
  ) {
    payload.hiddenServices = {
      ...(connectorUrl ? { connector: connectorUrl } : {}),
      ...(relayHs?.externalUrl ? { relay: relayHs.externalUrl } : {}),
    };
    if (!json) {
      console.log('');
      console.log('Hidden Services:');
      console.log('----------------');
      if (connectorUrl) {
        console.log(`  Connector (BTP):  ${connectorUrl}`);
      }
      if (relayHs?.externalUrl) {
        console.log(`  Relay (Nostr):    ${relayHs.externalUrl}`);
      }
      if (!connectorUrl && !relayHs?.externalUrl) {
        console.log('  (hs mode set but no externalUrl configured)');
      }
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
    payload.connector = {
      available: true,
      packetsForwarded: metrics.aggregate.packetsForwarded,
      activePeers,
      totalPeers: peers.length,
    };

    if (!json) {
      console.log('');
      console.log('Connector Metrics:');
      console.log('------------------');
      console.log(`  Packets forwarded: ${metrics.aggregate.packetsForwarded}`);
      console.log(`  Active peers:      ${activePeers}/${peers.length}`);
    }
  } catch {
    if (!json) {
      console.log('');
      console.log('Connector Metrics: unavailable');
    }
  }

  if (opts.units === 'sats' && opts.satsPerUsdc === undefined) {
    if (json) console.log(JSON.stringify(payload));
    return;
  }
  const earnings = await resolveEarnings(
    `http://127.0.0.1:${config.connector.adminPort}`,
    opts.configPath
  );
  payload.earnings = earnings;
  if (json) {
    console.log(JSON.stringify(payload));
    return;
  }
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
  // Resolve the operator wallet: TOWNHOUSE_MNEMONIC (direct, no password) OR the
  // encrypted wallet + password. P1 / docs/townhouse-mcp-design.md §3.
  let walletManager: WalletManager | undefined =
    (await tryEnvMnemonicWallet(walletPath)) ?? undefined;
  let walletPassword: string | undefined;
  if (!walletManager) {
    if (!existsSync(walletPath)) {
      console.error(
        `Wallet not found at ${walletPath}. Run \`townhouse setup\` first (or restore your wallet backup), or set TOWNHOUSE_MNEMONIC.`
      );
      process.exitCode = 1;
      return;
    }
    walletPassword = password ?? process.env['TOWNHOUSE_WALLET_PASSWORD'];
    if (!walletPassword) {
      throw new Error(
        'Wallet password required to start the API. Use --password flag or TOWNHOUSE_WALLET_PASSWORD env var (or set TOWNHOUSE_MNEMONIC).'
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

  // Pre-warm AR cache when DVM is in the boot set. The orchestrator's later
  // ensureArweaveKey('dvm') call (without password) would otherwise pay the
  // full 5–30s RSA cost AND not write back to disk. Calling here with the
  // password populates both the in-memory + on-disk caches once and lets
  // every subsequent invocation be sub-second (epic-49 Followup A). In
  // TOWNHOUSE_MNEMONIC mode walletPassword is undefined — ensureArweaveKey then
  // skips the disk cache and pays the RSA cost (still correct, just not cached).
  if (profiles.includes('dvm')) {
    try {
      await walletManager.ensureArweaveKey('dvm', walletPassword);
    } catch (err: unknown) {
      // Non-fatal: orchestrator's own ensureArweaveKey call will retry.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[townhouse up] AR pre-warm failed (non-fatal, orchestrator will retry): ${msg}`
      );
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
      '[townhouse] WARN: TURBO_TOKEN is not set — Arweave DVM (kind:5094) free-tier (<100KB) uploads still work, but larger/paid uploads will fail.'
    );
    console.warn(
      '[townhouse] Pass `townhouse node add dvm --turbo-token <arweave-jwk-json>` (HS mode) or export TURBO_TOKEN before `townhouse up` to enable full uploads.'
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
          config.transport.mode === 'hs'
            ? (config.transport.socksProxy ?? DEFAULT_ATOR_PROXY)
            : '',
      });
      if (config.transport.mode === 'hs') {
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
  docker: Docker,
  json = false
): Promise<void> {
  const orchestrator = new DockerOrchestrator(docker, config, undefined, {
    profile: 'dev',
  });

  const nodes: { name: string; state: string }[] = [];
  orchestrator.on(
    'containerState',
    (event: { name: string; state: string }) => {
      nodes.push(event);
      if (!json) console.log(`  ${event.name}: ${event.state}`);
    }
  );

  if (!json) console.log('Stopping nodes...');
  await orchestrator.down();
  if (json) {
    console.log(JSON.stringify({ stopped: true, nodes }));
  } else {
    console.log('All nodes stopped.');
  }
}

/** Connector admin URL for HS mode. */
const HS_CONNECTOR_ADMIN_URL = 'http://127.0.0.1:9401';
/** Townhouse API URL for HS mode (inside the townhouse-api container). */
const HS_TOWNHOUSE_API_URL = 'http://127.0.0.1:28090';
/**
 * Direct-mode apex dial address printed on success. The connector exposes its
 * BTP server on host loopback :3000 (operator can rebind via TOWNHOUSE_BTP_BIND
 * in the compose .env), and the Phase 1 DIRECT_BTP client connects to /btp.
 */
// nosemgrep: javascript.lang.security.detect-insecure-websocket -- operator loopback BTP dial address, TLS terminated by transport
const DIRECT_BTP_DIAL_URL = 'ws://127.0.0.1:3000/btp';

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
 * Auto-rebind provisioned child nodes from `~/.townhouse/nodes.yaml` after the
 * apex is up. Shared by `hs up` (HS) and `up` (direct), which both run
 * `orchestrator.up([])` (apex only) and both tear children down on `down`. Two
 * stages, in order:
 *   1. rebind containers — rebuild each child's env from wallet + config and
 *      (re)start it (idempotent; picks up config edits). Containers must exist
 *      before peers re-register.
 *   2. reconcile peers — re-register each child with the connector (the connector
 *      restart on `up` drops the in-memory child routes).
 * Every step is non-fatal: failures are logged with `logPrefix`, boot proceeds.
 */
async function rebindAndReconcileChildren(opts: {
  configDir: string;
  walletManager: WalletManager | undefined;
  orch: {
    startNodeViaCompose?: (
      type: NodeType,
      env: Record<string, string>
    ) => Promise<void>;
  };
  config: TownhouseConfig;
  logPrefix: string;
  hsOverrides?: CliHsOverrides;
}): Promise<void> {
  const { configDir, walletManager, orch, config, logPrefix, hsOverrides } =
    opts;
  const nodesYamlPath = join(configDir, 'nodes.yaml');

  // Resolve the apex public BTP URL the town advertises in its kind:10032. The
  // .anyone hostname is read from host.json (written by a prior `hs up`); on a
  // restart it's already present, so the rebound town gets a reachable endpoint.
  let publicBtpUrl: string | undefined;
  try {
    let hostname: string | undefined;
    try {
      const raw = readFileSync(join(configDir, 'host.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { hostname?: unknown };
      if (typeof parsed.hostname === 'string') hostname = parsed.hostname;
    } catch {
      /* host.json absent on first boot — direct/externalUrl still resolve */
    }
    publicBtpUrl = resolvePublicBtpUrl(config, hostname);
  } catch {
    publicBtpUrl = undefined;
  }

  // The child compose services interpolate ${TOWNHOUSE_HOME}/${TOWNHOUSE_WALLET_DIR}
  // /${TOWNHOUSE_UID}/${TOWNHOUSE_DOCKER_GID} (bind mounts, uid). `node add` gets
  // these from the api container's env, but the rebind runs on the HOST after
  // `up`'s env block was already torn down — so set them here for the rebind's
  // `docker compose up` subprocess (else the bind spec is `:/.townhouse` → error).
  const composeEnvPrev: Record<string, string | undefined> = {
    TOWNHOUSE_HOME: process.env['TOWNHOUSE_HOME'],
    TOWNHOUSE_WALLET_DIR: process.env['TOWNHOUSE_WALLET_DIR'],
    TOWNHOUSE_UID: process.env['TOWNHOUSE_UID'],
    TOWNHOUSE_DOCKER_GID: process.env['TOWNHOUSE_DOCKER_GID'],
  };
  process.env['TOWNHOUSE_HOME'] = configDir;
  process.env['TOWNHOUSE_WALLET_DIR'] = dirname(
    resolve(config.wallet.encrypted_path)
  );
  process.env['TOWNHOUSE_UID'] = String(process.getuid?.() ?? 1000);
  try {
    process.env['TOWNHOUSE_DOCKER_GID'] = String(
      statSync('/var/run/docker.sock').gid
    );
  } catch {
    process.env['TOWNHOUSE_DOCKER_GID'] = '0';
  }

  try {
    // Stage 1: rebind child containers.
    const rebindFn = hsOverrides?.rebindChildren ?? rebindChildContainers;
    if (walletManager && typeof orch.startNodeViaCompose === 'function') {
      const startNodeViaCompose = orch.startNodeViaCompose.bind(orch);
      try {
        const summary = await rebindFn({
          nodesYamlPath,
          wallet: walletManager,
          orchestrator: { startNodeViaCompose },
          config,
          publicBtpUrl,
          log: (line) => console.error(`${logPrefix} ${line}`),
        });
        for (const s of summary.skipped) {
          console.error(`${logPrefix} node ${s.id} not rebound: ${s.reason}`);
        }
        for (const f of summary.failed) {
          console.error(
            `${logPrefix} node ${f.id} rebind failed (non-fatal): ${f.err}`
          );
        }
      } catch (rebindErr: unknown) {
        const detail =
          rebindErr instanceof Error
            ? (rebindErr.stack ?? rebindErr.message)
            : String(rebindErr);
        console.error(`${logPrefix} child rebind error (non-fatal): ${detail}`);
      }
    }

    // Stage 2: reconcile connector peer state to nodes.yaml (Story 46.1).
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
    try {
      await reconcileWithBriefRetry(reconciler, 5_000);
    } catch (reconcilerErr: unknown) {
      const detail =
        reconcilerErr instanceof Error
          ? (reconcilerErr.stack ?? reconcilerErr.message)
          : String(reconcilerErr);
      console.error(`${logPrefix} reconciler error (non-fatal): ${detail}`);
    }
  } finally {
    // Restore the compose-interpolation env vars we set for the rebind.
    for (const [k, v] of Object.entries(composeEnvPrev)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

/**
 * Boot the apex (connector + townhouse-api) via `townhouse hs up`.
 * Idempotent: if the apex is already running, re-prints the hostname and exits 0.
 * After the apex is live, writes `~/.townhouse/host.json` and prints the final line.
 */
/**
 * Collect the apex image refs (digest-pinned) that `hs up` should pre-pull
 * before invoking `docker compose up -d`.
 *
 * Apex always-on services (Story 45.2 / 45.4) are connector + townhouse-api.
 * Profile-gated services (town/mill/dvm) are lazy-provisioned via
 * `POST /api/nodes` and excluded here.
 *
 * Returns `[]` (and never throws) if:
 *   - `image-manifest.json` is absent under `<configDir>` (local-dev tree
 *     without a CI-produced manifest), OR
 *   - the manifest exists but cannot be parsed (corrupt file). The caller
 *     treats `[]` as "skip pre-pull narration" and lets compose handle it.
 */
async function collectApexImageRefs(configDir: string): Promise<string[]> {
  const manifestPath = join(configDir, 'image-manifest.json');
  if (!existsSync(manifestPath)) return [];
  try {
    const manifest = await readImageManifest(manifestPath);
    // Skip pre-pull if the manifest is synthetic (smoke-workflow sentinel).
    // Attempting to pull sha256:dead000… from the registry would fail with a
    // cryptic 404; the compose step will handle image resolution correctly.
    if (
      isSyntheticDigest(manifest.images.connector.digest) ||
      isSyntheticDigest(manifest.images['townhouse-api'].digest)
    ) {
      return [];
    }
    return [
      `${manifest.images.connector.name}@${manifest.images.connector.digest}`,
      `${manifest.images['townhouse-api'].name}@${manifest.images['townhouse-api'].digest}`,
    ];
  } catch {
    return [];
  }
}

/**
 * Returns true when an OrchestratorError is caused by the ATOR anon SDK's
 * hardcoded 60s bootstrap timeout (@anyone-protocol/anyone-client@1.1.x
 * `setupTimeoutHandler`). The connector container goes unhealthy and compose
 * exits 1 — the retry loop in handleHsUp restarts the stack on this signal.
 */
function isAnonBootstrapTimeout(err: unknown): boolean {
  if (!(err instanceof OrchestratorError)) return false;
  const text = `${err.message}\n${err.stderr ?? ''}`;
  return /connector.*unhealthy|dependency.*connector.*fail/i.test(text);
}

/**
 * Foreground the Ink dashboard for an already-live apex when stdout is a TTY.
 * Used by both the cold-boot path and the idempotent re-run path, so that
 * re-running `townhouse hs up` against a running node re-attaches the dashboard
 * instead of just printing the hostname and exiting.
 *
 * A TUI mount/runtime failure must NOT be treated as a boot failure — apex is
 * already live — so it is caught and reported as a display issue. No-op on
 * non-TTY stdout (the process then exits naturally after printing the address).
 */
async function attachDashboard(hostname: string): Promise<void> {
  if (!shouldRenderInk()) return;
  try {
    const { mountTui } = await import('./tui/index.js');
    // P27 (D1): thread HS_TOWNHOUSE_API_URL env override into the TUI so
    // operators on a non-default Fastify port don't see eternal fetch_failed.
    const apiUrlOverride = process.env['HS_TOWNHOUSE_API_URL'];
    const mountOpts =
      apiUrlOverride !== undefined ? { apiUrl: apiUrlOverride } : {};
    const instance = mountTui(mountOpts);
    await instance.waitUntilExit();
  } catch (tuiErr: unknown) {
    const detail = tuiErr instanceof Error ? tuiErr.message : String(tuiErr);
    console.error('');
    console.error(`Your node is live at ${hostname}.`);
    console.error(
      `The live dashboard could not open (${detail}) — this is a display ` +
        'issue, not a node issue. Your node keeps running.'
    );
    console.error(
      'Stop it anytime with:  npx @toon-protocol/townhouse hs down'
    );
    // Leave process.exitCode at success — the node is live.
  }
}

/**
 * P2b — emit one NDJSON boot-progress step on stdout when `townhouse up --json`
 * / `hs up --json` is active. The townhouse-mcp server's `townhouse_up_status`
 * tool reads these from up.log; a terminal `done`/`error` step tells it the
 * boot finished (success/failure). Human ribbon output is left intact — the
 * MCP reader skips non-JSON lines — so this is purely additive and low-risk.
 */
function emitUpStep(
  json: boolean,
  step: string,
  extra: Record<string, unknown> = {}
): void {
  if (json) console.log(JSON.stringify({ step, ...extra }));
}

async function handleHsUp(
  _configPath: string,
  configDir: string,
  config: TownhouseConfig,
  docker: Docker,
  options: {
    password?: string;
    force?: boolean;
    skipPreflight?: boolean;
    hsOverrides?: CliHsOverrides;
    json?: boolean;
  }
): Promise<void> {
  const { password, force, skipPreflight, hsOverrides } = options;
  const json = options.json === true;
  emitUpStep(json, 'starting', { transport: 'hs' });

  // ── Idempotency probe (AC #7) — BEFORE the preflight ────────────────────────
  // If our apex is already live, this is a re-run: re-print the address, refresh
  // host.json, and (in a TTY) re-attach the dashboard, then return. This MUST run
  // before the port preflight: the preflight would otherwise flag our OWN apex's
  // canonical ports as a collision and refuse, making an idempotent re-run (and
  // re-attaching the dashboard) impossible. Skipped under --force (cold rebuild).
  if (!force) {
    const adminClientFactory =
      hsOverrides?.createAdminClient ??
      ((url: string, t: number) => new ConnectorAdminClient(url, t));
    const probe = adminClientFactory(HS_CONNECTOR_ADMIN_URL, 3_000);
    try {
      const existing = await probe.getHsHostname();
      if (existing.hostname !== null) {
        // getHsHostname() normalizes the connector's `.anon` scheme to the
        // routable `.anyone` TLD, so this hostname is already `.anyone`.
        console.log(`Apex live at ${existing.hostname}`);
        emitUpStep(json, 'done', {
          transport: 'hs',
          hostname: existing.hostname,
          alreadyLive: true,
        });
        _writeHostJson(configDir, {
          hostname: existing.hostname,
          publishedAt: existing.publishedAt ?? new Date().toISOString(),
          writtenAt: new Date().toISOString(),
        });
        await attachDashboard(existing.hostname);
        return;
      }
      // hostname null → apex started but HS not ready → treat as cold-start.
    } catch (probeErr: unknown) {
      const msg =
        probeErr instanceof Error ? probeErr.message : String(probeErr);
      if (msg.includes('anon-disabled')) {
        // Apex running but anon is disabled — render failure copy and exit.
        const { exitCode } = renderFailure(probeErr);
        process.exitCode = exitCode;
        return;
      }
      // ECONNREFUSED / timeout → not running → fall through to preflight + boot.
    }
  }

  // ── Preflight: port-collision check (Epic 49 Followup B) ────────────────────
  // Only reached on a true cold start (no apex already live). Catches the most
  // common operator footgun (contributor dev stack still up, another hs up
  // instance, or an unrelated process bound to the canonical ports) and
  // surfaces an actionable error instead of a cryptic mid-boot EADDRINUSE.
  //
  // `--skip-preflight` bypasses the check (escape hatch for operators who
  // know what they're doing — e.g. running two HS stacks on different
  // network interfaces; rare but harmless).
  if (!skipPreflight) {
    const preflight =
      hsOverrides?.checkPortCollisions ??
      ((d: Docker) => checkHsPortCollisions(d));
    try {
      const collisions = await preflight(docker);
      if (collisions.length > 0) {
        const msg = formatCollisionMessage(collisions);
        // Write directly to stderr (multi-line message — console.error adds
        // an extra newline per call which would shred the formatting).
        process.stderr.write(msg);
        process.exitCode = 1;
        return;
      }
    } catch (preflightErr: unknown) {
      // Preflight itself failed unexpectedly (e.g. kernel out of fds). Log
      // and continue rather than block boot — the existing Docker-level
      // EADDRINUSE handler is still there as a fallback.
      const detail =
        preflightErr instanceof Error
          ? preflightErr.message
          : String(preflightErr);
      console.error(
        `[townhouse hs up] port preflight skipped (non-fatal): ${detail}`
      );
    }
  }

  // Resolve the operator wallet (AC #10): TOWNHOUSE_MNEMONIC (direct, no
  // password) OR the encrypted wallet + password (--password → env → TTY).
  // See P1 / docs/townhouse-mcp-design.md §3.
  const walletPath = config.wallet.encrypted_path;
  let walletManager: WalletManager | undefined =
    (await tryEnvMnemonicWallet(walletPath)) ?? undefined;
  // Hoisted: injected into the townhouse-api container env below. Undefined in
  // TOWNHOUSE_MNEMONIC mode (the container then receives TOWNHOUSE_MNEMONIC).
  let resolvedPassword: string | undefined;
  if (!walletManager) {
    if (!existsSync(walletPath)) {
      console.error(
        `Wallet not found at ${walletPath}. Run \`townhouse init\` first (or set TOWNHOUSE_MNEMONIC).`
      );
      process.exitCode = 1;
      return;
    }

    const walletPassword = password ?? process.env['TOWNHOUSE_WALLET_PASSWORD'];

    if (walletPassword) {
      resolvedPassword = walletPassword;
    } else if (process.stdin.isTTY) {
      resolvedPassword = await promptPassword('Wallet password: ');
    } else {
      // No interactive terminal (CI, SSH without a TTY, piped stdin). Make the
      // reason explicit so the user knows why no prompt appeared and what to do.
      console.error(
        'Wallet password required, but no interactive terminal is available to prompt.\n' +
          'Pass --password <pw>, set TOWNHOUSE_WALLET_PASSWORD, or set TOWNHOUSE_MNEMONIC.'
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
  }

  const ribbon = new OnboardingRibbon();

  try {
    // Cold-boot path. (The idempotency probe runs earlier — above the preflight —
    // so an already-live apex re-attaches instead of failing the port check.)

    // Step 1: write connector.yaml with anon.enabled: true (AC #3). Derive the
    // apex settlement key from the (already-unlocked) operator mnemonic so any
    // configured chainProvider lacking an explicit keyId is signed by the
    // operator's own key — no manual `--key-id` needed. The raw key lands only
    // in connector.yaml (0600), never in config.yaml.
    const apexSettlementKeys = await walletManager.getApexSettlementKeys();
    writeHsConnectorConfig(configDir, config, { force, apexSettlementKeys });

    // Step 2: materialize compose template.
    const materialize =
      hsOverrides?.materializeComposeTemplate ?? materializeComposeTemplate;
    const { composePath } = materialize('hs', { townhouseHome: configDir });

    // Step 2b: write compose/.env from the `network` mode so the compose
    // template's ${EVM_CHAIN}/${EVM_RPC_URL}/${SOLANA_*} interpolations resolve
    // to real public endpoints for the chosen tier (apex + children share the
    // same network profile). Must run after materialize (which creates compose/).
    writeHsNodeEnvFile(configDir, config);

    // Step 3: start the ribbon (phase 1 — pulling).
    ribbon.start('pull');

    // Step 4: construct orchestrator and wire ribbon events.
    const orchestratorFactory =
      hsOverrides?.createOrchestrator ??
      ((
        d: Docker,
        cfg: TownhouseConfig,
        wm: WalletManager | undefined,
        opts: { profile: 'hs' | 'direct'; composePath: string }
      ) => new DockerOrchestrator(d, cfg, wm, opts));

    const orch = orchestratorFactory(docker, config, walletManager, {
      profile: 'hs',
      composePath,
    });

    // ── pullProgress narration (Epic 49 Followup D) ───────────────────────
    // Subscribe BEFORE any pulls so we never miss the first events. Uses
    // the throttled narrator to dedupe Downloading/Extracting noise.
    const narrator = new PullNarrator();
    orch.on('pullProgress', (event: unknown) => {
      const ev = event as {
        image?: string;
        status?: string;
        id?: string;
        progress?: string;
      };
      if (!ev.image || !ev.status) return;
      const line = narrator.format({
        image: ev.image,
        status: ev.status,
        id: ev.id,
        progress: ev.progress,
      });
      if (line !== null) console.log(line);
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

    // Stop the pull-phase spinner before the pre-pull narration below. The
    // spinner rewrites its line in place (cursor-up + clear), which smears into
    // duplicated "Pulling apex image…" lines when the per-image/layer progress
    // prints interleaved underneath it. The narration IS the progress indicator
    // for this phase; the spinner resumes cleanly for the quiet bootstrap wait.
    ribbon.stop();

    // ── Cold-pull pre-warm (Epic 49 Followup D) ───────────────────────────
    // Compose's `up -d` with inheritStdio=true is essentially silent on a
    // cold image cache — operators experience a 5-minute black hole. We
    // pre-pull apex images via dockerode (which emits pullProgress) so the
    // narrator above can render layer-state transitions to stdout. The
    // subsequent `docker compose up -d` finds the images cached and proceeds
    // without re-pulling.
    //
    // Image list comes from the materialized image-manifest.json. If the
    // manifest is missing (local dev tree, not an npm install) or pullImage
    // is absent (stale stub), we silently skip the pre-pull and let compose's
    // own pull behaviour stand. The "Apex live at <hostname>" success message
    // remains the canonical completion signal.
    if (typeof orch.pullImage === 'function') {
      try {
        const apexImages = await collectApexImageRefs(configDir);
        if (apexImages.length > 0) {
          console.log(
            `Pulling ${apexImages.length} apex ${apexImages.length === 1 ? 'image' : 'images'}...`
          );
          let pulled = 0;
          for (const ref of apexImages) {
            pulled++;
            console.log(`  [${pulled}/${apexImages.length}] ${ref}`);
            await orch.pullImage(ref);
          }
        } else {
          // No pinned image manifest (e.g. local dev tree). Compose will pull
          // images on demand during `up` — which can be a multi-minute period
          // with little output. Tell the user so the wait isn't a silent void.
          console.log(
            'No pinned image manifest found — Docker will pull images on demand.'
          );
          console.log(
            'First start can take several minutes with limited progress output.'
          );
        }
      } catch (pullErr: unknown) {
        // Non-fatal: compose up will retry the pull and surface a real error if
        // it fails permanently. Narrate it calmly rather than as an alarm.
        const detail =
          pullErr instanceof Error ? pullErr.message : String(pullErr);
        console.log(
          `Could not pre-pull images (${detail}). Docker will pull them during ` +
            'startup — this is normal and may take a few minutes.'
        );
      }
    }

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
    // In TOWNHOUSE_MNEMONIC mode resolvedPassword is undefined; leave the
    // container's TOWNHOUSE_WALLET_PASSWORD unset (assigning undefined would
    // coerce to the string "undefined"). The operator's TOWNHOUSE_MNEMONIC is
    // already in process.env and is forwarded by the compose template instead.
    if (resolvedPassword !== undefined) {
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = resolvedPassword;
    }
    process.env['TOWNHOUSE_UID'] = String(process.getuid?.() ?? 1000);
    // Inject the wallet dir as an absolute host path so the townhouse-api
    // container can find the wallet at the same path as config.wallet.encrypted_path.
    process.env['TOWNHOUSE_WALLET_DIR'] = dirname(
      resolve(config.wallet.encrypted_path)
    );
    process.env['TOWNHOUSE_DOCKER_GID'] = String(dockerSockGid);

    // Guarantee the bootstrap phase is narrated before the up-to-90s hostname
    // wait. The containerState event above may never fire with a matching state
    // (observed in plain/non-TTY boots: a silent ~20s gap here), so trigger the
    // phase explicitly. The event handler no-ops once bootstrapStarted is set.
    if (!bootstrapStarted) {
      bootstrapStarted = true;
      ribbon.start('bootstrap');
    }

    // Retry up to 3×: the ATOR anon SDK (@anyone-protocol/anyone-client@1.1.x)
    // has a hardcoded 60s bootstrap timeout that fires when relay descriptor
    // loading is slow. `downHs` omits --volumes so the keypair is preserved.
    const MAX_ANON_RETRIES = 3;
    try {
      for (let attempt = 1; attempt <= MAX_ANON_RETRIES; attempt++) {
        try {
          await orch.up([]);
          break;
        } catch (err: unknown) {
          if (isAnonBootstrapTimeout(err) && attempt < MAX_ANON_RETRIES) {
            console.error(
              `[townhouse hs up] ATOR bootstrap timed out (attempt ${attempt}/${MAX_ANON_RETRIES}) — retrying...`
            );
            await orch.down().catch(() => undefined);
            continue;
          }
          throw err;
        }
      }
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

    // Step 5b: auto-rebind child containers + reconcile connector peers from
    // nodes.yaml (Story 46.1 + rebind). Runs after orchestrator.up([]) but
    // BEFORE host.json is written and the hostname is printed. Non-fatal — any
    // failure is logged to stderr but does not block apex boot.
    await rebindAndReconcileChildren({
      configDir,
      walletManager,
      orch,
      config,
      logPrefix: '[townhouse hs up]',
      hsOverrides,
    });

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
    // getHsHostname() normalizes the connector's `.anon` scheme to the routable
    // `.anyone` TLD, so this hostname is already `.anyone`.
    // ribbon.start('live', hostname) prints: "Apex live at <hostname>" as the FINAL stdout line.
    ribbon.start('live', hostname);
    emitUpStep(json, 'done', { transport: 'hs', hostname });

    // Story 48.1: foreground Ink TUI when stdout is a TTY. Apex is already live
    // here (host.json written, "Apex live at …" printed above); attachDashboard
    // isolates any TUI failure so it is never reported as a boot failure.
    await attachDashboard(hostname);
  } catch (err: unknown) {
    emitUpStep(json, 'error', {
      transport: 'hs',
      message: err instanceof Error ? err.message : String(err),
    });
    const { exitCode } = renderFailure(err);
    process.exitCode = exitCode;
  } finally {
    ribbon.stop();
    if (walletManager) {
      walletManager.lock();
    }
  }
}

/**
 * Direct-apex bring-up (Phase 2, INTERNAL opt-in only).
 *
 * Boots the apex (connector + townhouse-api) + any requested children with NO
 * hidden service. The connector's BTP port :3000 is exposed to the host so an
 * external client connects over plain `ws://host:3000/btp` (Phase 1's
 * DIRECT_BTP client). Structurally mirrors {@link handleHsUp} but:
 *   - writes the connector config via writeDirectConnectorConfig (no anon),
 *   - materializes the 'direct' compose profile,
 *   - reuses writeHsNodeEnvFile (transport-agnostic) for compose/.env,
 *   - constructs the orchestrator with {profile:'direct'} and runs upDirect,
 *   - uses a connector-health idempotency probe (no HS hostname), and
 *   - prints the direct dial address on success.
 *
 * This is reachable ONLY via `townhouse up --transport direct` (an explicit
 * internal opt-in). The default `up` / `hs up` dispatch is unchanged (Phase 3
 * will flip the default).
 */
async function handleDirectUp(
  _configPath: string,
  configDir: string,
  config: TownhouseConfig,
  docker: Docker,
  options: {
    password?: string;
    force?: boolean;
    skipPreflight?: boolean;
    hsOverrides?: CliHsOverrides;
    json?: boolean;
  }
): Promise<void> {
  const { password, force, skipPreflight, hsOverrides } = options;
  const json = options.json === true;
  emitUpStep(json, 'starting', { transport: 'direct' });

  const adminClientFactory =
    hsOverrides?.createAdminClient ??
    ((url: string, t: number) => new ConnectorAdminClient(url, t));

  // ── Back-compat guard — never silently downgrade an HS apex ─────────────────
  // The direct-default `townhouse up` MUST NOT clobber an operator who is
  // already running a hidden-service apex. If the persisted connector.yaml
  // carries `anon.enabled: true`, refuse and point them at the HS commands.
  // The direct default applies to FRESH installs / non-HS (legacy or direct)
  // configs only; we never rewrite an existing config.yaml `mode`.
  if (detectExistingHsConfig(configDir)) {
    console.error(
      'Existing hidden-service apex detected (connector.yaml has anon.enabled: true).\n' +
        '`townhouse up` boots a direct-BTP apex and would downgrade your HS deployment.\n' +
        '  • To keep hidden-service mode:  townhouse hs up\n' +
        '  • To switch to direct BTP:      townhouse hs down --rotate-keys && townhouse up'
    );
    process.exitCode = 1;
    return;
  }

  // ── Wallet-existence fail-fast — BEFORE the idempotency probe ───────────────
  // A missing wallet means a broken/incomplete install; nothing can be brought
  // up (and the post-up API needs the unlocked wallet). Checking here makes the
  // failure deterministic regardless of whether some unrelated connector admin
  // happens to answer the idempotency probe on the canonical port.
  const walletPath = config.wallet.encrypted_path;
  if (!process.env['TOWNHOUSE_MNEMONIC'] && !existsSync(walletPath)) {
    console.error(
      `Wallet not found at ${walletPath}. Run \`townhouse init\` first (or set TOWNHOUSE_MNEMONIC).`
    );
    process.exitCode = 1;
    return;
  }

  // ── Idempotency probe — BEFORE the preflight ───────────────────────────────
  // If our apex connector is already live (admin /health reachable), this is a
  // re-run: re-print the dial address and return. This MUST run before the port
  // preflight so an idempotent re-run does not flag our OWN apex's ports as a
  // collision. Skipped under --force (cold rebuild).
  if (!force) {
    const probe = adminClientFactory(HS_CONNECTOR_ADMIN_URL, 3_000);
    const ping = (
      probe as { pingAdminLive?: () => Promise<unknown> }
    ).pingAdminLive?.bind(probe);
    if (ping) {
      try {
        await ping();
        console.log(`Apex live (direct BTP) at ${DIRECT_BTP_DIAL_URL}`);
        emitUpStep(json, 'done', { transport: 'direct', alreadyLive: true });
        return;
      } catch {
        // Not running / not ready → fall through to preflight + cold boot.
      }
    }
  }

  // ── Preflight: port-collision check (includes the BTP :3000 host bind) ──────
  if (!skipPreflight) {
    const preflight =
      hsOverrides?.checkPortCollisions ??
      ((d: Docker) => checkDirectPortCollisions(d));
    try {
      const collisions = await preflight(docker);
      if (collisions.length > 0) {
        process.stderr.write(formatCollisionMessage(collisions));
        process.exitCode = 1;
        return;
      }
    } catch (preflightErr: unknown) {
      const detail =
        preflightErr instanceof Error
          ? preflightErr.message
          : String(preflightErr);
      console.error(
        `[townhouse up --transport direct] port preflight skipped (non-fatal): ${detail}`
      );
    }
  }

  // Resolve the operator wallet: TOWNHOUSE_MNEMONIC (direct, no password) OR the
  // encrypted wallet + password (--password → env → TTY). walletPath existence
  // was already validated above (skipped in mnemonic mode). P1 / §3.
  let walletManager: WalletManager | undefined =
    (await tryEnvMnemonicWallet(walletPath)) ?? undefined;
  // Hoisted: injected into the townhouse-api container env below. Undefined in
  // TOWNHOUSE_MNEMONIC mode (the container then receives TOWNHOUSE_MNEMONIC).
  let resolvedPassword: string | undefined;
  if (!walletManager) {
    const walletPassword = password ?? process.env['TOWNHOUSE_WALLET_PASSWORD'];
    if (walletPassword) {
      resolvedPassword = walletPassword;
    } else if (process.stdin.isTTY) {
      resolvedPassword = await promptPassword('Wallet password: ');
    } else {
      console.error(
        'Wallet password required, but no interactive terminal is available to prompt.\n' +
          'Pass --password <pw>, set TOWNHOUSE_WALLET_PASSWORD, or set TOWNHOUSE_MNEMONIC.'
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
  }

  const ribbon = new OnboardingRibbon();

  try {
    // Step 1: write connector.yaml with transport:{type:'direct'} (NO anon).
    // Derive the apex settlement key from the unlocked mnemonic so configured
    // chainProviders lacking an explicit keyId are signed by the operator's key
    // (Phase 5 needs Solana/Mina chainProvider keys here). The raw key lands
    // only in connector.yaml (0600), never in config.yaml.
    const apexSettlementKeys = await walletManager.getApexSettlementKeys();
    writeDirectConnectorConfig(configDir, config, {
      force,
      apexSettlementKeys,
    });

    // Step 2: materialize the 'direct' compose template.
    const materialize =
      hsOverrides?.materializeComposeTemplate ?? materializeComposeTemplate;
    const { composePath } = materialize('direct', { townhouseHome: configDir });

    // Step 2b: write compose/.env from the `network` mode (transport-agnostic).
    writeHsNodeEnvFile(configDir, config);

    // Step 3: ribbon (pull phase).
    ribbon.start('pull');

    // Step 4: construct orchestrator wired for the 'direct' profile.
    const orchestratorFactory =
      hsOverrides?.createOrchestrator ??
      ((
        d: Docker,
        cfg: TownhouseConfig,
        wm: WalletManager | undefined,
        opts: { profile: 'hs' | 'direct'; composePath: string }
      ) => new DockerOrchestrator(d, cfg, wm, opts));

    const orch = orchestratorFactory(docker, config, walletManager, {
      profile: 'direct',
      composePath,
    });

    const narrator = new PullNarrator();
    orch.on('pullProgress', (event: unknown) => {
      const ev = event as {
        image?: string;
        status?: string;
        id?: string;
        progress?: string;
      };
      if (!ev.image || !ev.status) return;
      const line = narrator.format({
        image: ev.image,
        status: ev.status,
        id: ev.id,
        progress: ev.progress,
      });
      if (line !== null) console.log(line);
    });

    let bootstrapStarted = false;
    orch.on('containerState', (event: unknown) => {
      const ev = event as { name?: string; state?: string };
      if (
        !bootstrapStarted &&
        (ev.state === 'creating' || ev.state === 'starting')
      ) {
        bootstrapStarted = true;
        ribbon.start('bootstrap');
      }
    });

    ribbon.stop();

    // Cold-pull pre-warm (same approach as HS): pre-pull apex images so the
    // narrator can render progress; compose then finds them cached.
    if (typeof orch.pullImage === 'function') {
      try {
        const apexImages = await collectApexImageRefs(configDir);
        if (apexImages.length > 0) {
          console.log(
            `Pulling ${apexImages.length} apex ${apexImages.length === 1 ? 'image' : 'images'}...`
          );
          let pulled = 0;
          for (const ref of apexImages) {
            pulled++;
            console.log(`  [${pulled}/${apexImages.length}] ${ref}`);
            await orch.pullImage(ref);
          }
        } else {
          console.log(
            'No pinned image manifest found — Docker will pull images on demand.'
          );
        }
      } catch (pullErr: unknown) {
        const detail =
          pullErr instanceof Error ? pullErr.message : String(pullErr);
        console.log(
          `Could not pre-pull images (${detail}). Docker will pull them during ` +
            'startup — this is normal and may take a few minutes.'
        );
      }
    }

    // Step 5: up (always-on services only). Inject the same compose-interpolation
    // env vars HS uses; the direct template consumes the identical passthrough
    // (TOWNHOUSE_HOME / WALLET_DIR / UID / DOCKER_GID / WALLET_PASSWORD) plus the
    // optional TOWNHOUSE_BTP_BIND (left to the operator's shell env).
    let dockerSockGid = 0;
    try {
      dockerSockGid = statSync('/var/run/docker.sock').gid;
    } catch {
      // Socket missing — fallback 0 keeps Compose interpolation valid.
    }
    const prevTownhouseHome = process.env['TOWNHOUSE_HOME'];
    const prevWalletPassword = process.env['TOWNHOUSE_WALLET_PASSWORD'];
    const prevTownhouseUid = process.env['TOWNHOUSE_UID'];
    const prevWalletDir = process.env['TOWNHOUSE_WALLET_DIR'];
    const prevDockerGid = process.env['TOWNHOUSE_DOCKER_GID'];
    process.env['TOWNHOUSE_HOME'] = configDir;
    // In TOWNHOUSE_MNEMONIC mode resolvedPassword is undefined; leave the
    // container's TOWNHOUSE_WALLET_PASSWORD unset (assigning undefined would
    // coerce to the string "undefined"). The operator's TOWNHOUSE_MNEMONIC is
    // already in process.env and is forwarded by the compose template instead.
    if (resolvedPassword !== undefined) {
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = resolvedPassword;
    }
    process.env['TOWNHOUSE_UID'] = String(process.getuid?.() ?? 1000);
    process.env['TOWNHOUSE_WALLET_DIR'] = dirname(
      resolve(config.wallet.encrypted_path)
    );
    process.env['TOWNHOUSE_DOCKER_GID'] = String(dockerSockGid);

    if (!bootstrapStarted) {
      bootstrapStarted = true;
      ribbon.start('bootstrap');
    }

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

    // Step 5b: auto-rebind child containers + reconcile connector peers from
    // nodes.yaml — same as `hs up`. Direct mode also tears children down on
    // `down` and restarts the connector on `up`, so without this a restart leaves
    // children stopped and unrouted. Non-fatal: failures are logged, boot proceeds.
    await rebindAndReconcileChildren({
      configDir,
      walletManager,
      orch,
      config,
      logPrefix: '[townhouse up]',
      hsOverrides,
    });

    // Step 6: success — print the direct dial address as the FINAL stdout line.
    ribbon.stop();
    console.log(`Apex live (direct BTP) at ${DIRECT_BTP_DIAL_URL}`);
    emitUpStep(json, 'done', { transport: 'direct' });
  } catch (err: unknown) {
    emitUpStep(json, 'error', {
      transport: 'direct',
      message: err instanceof Error ? err.message : String(err),
    });
    const { exitCode } = renderFailure(err);
    process.exitCode = exitCode;
  } finally {
    ribbon.stop();
    if (walletManager) {
      walletManager.lock();
    }
  }
}

/**
 * `townhouse hs enable` — switch an already-running DIRECT deployment to HS.
 *
 * Thin wrapper: direct and HS stacks are namespace/port-mutually-exclusive
 * (distinct container names, networks, volumes, and the direct profile binds
 * the BTP :3000 host port the HS profile must NOT), so an in-place connector
 * restart can't flip transports — the direct compose project must come DOWN
 * before the HS one comes UP. This:
 *   1. refuses if an HS apex is already the live config (nothing to enable),
 *   2. tears down the 'direct' compose project (best-effort; preserves data
 *      volumes — only the direct namespace is removed),
 *   3. delegates to handleHsUp with force:true, which rewrites connector.yaml
 *      to anon.enabled:true, materializes the HS compose, and brings it up.
 */
async function handleHsEnable(
  configPath: string,
  configDir: string,
  config: TownhouseConfig,
  docker: Docker,
  options: {
    password?: string;
    force?: boolean;
    skipPreflight?: boolean;
    hsOverrides?: CliHsOverrides;
    json?: boolean;
  }
): Promise<void> {
  const { hsOverrides } = options;
  const json = options.json === true;
  emitUpStep(json, 'starting', { transport: 'hs', action: 'enable' });

  // Already HS? Nothing to do — point at the HS up path for a re-attach.
  if (detectExistingHsConfig(configDir)) {
    if (json) {
      emitUpStep(json, 'done', {
        transport: 'hs',
        action: 'enable',
        alreadyHs: true,
      });
    } else {
      console.log(
        'Hidden-service apex already configured. Use `townhouse hs up` to (re)attach.'
      );
    }
    return;
  }

  // Tear the direct stack down so its BTP :3000 host bind + container/network
  // namespace are free before the HS stack comes up. Best-effort: a missing
  // direct stack (fresh install) is fine — handleHsUp does a clean cold boot.
  if (!json) console.log('Switching direct apex → hidden-service mode...');
  try {
    const materialize =
      hsOverrides?.materializeComposeTemplate ?? materializeComposeTemplate;
    const { composePath } = materialize('direct', {
      townhouseHome: configDir,
    });
    const orchestratorFactory =
      hsOverrides?.createOrchestrator ??
      ((
        d: Docker,
        cfg: TownhouseConfig,
        wm: WalletManager | undefined,
        opts: { profile: 'hs' | 'direct'; composePath: string }
      ) => new DockerOrchestrator(d, cfg, wm, opts));
    const orch = orchestratorFactory(docker, config, undefined, {
      profile: 'direct',
      composePath,
    });
    await orch.down();
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    if (json) {
      emitUpStep(json, 'teardown-skipped', { detail });
    } else {
      console.warn(
        `[townhouse hs enable] direct stack teardown skipped (non-fatal): ${detail}`
      );
    }
  }

  // Bring up HS. force:true ensures the direct connector.yaml is overwritten
  // with the HS config (anon.enabled:true) rather than reused by idempotency.
  // `json` flows through so handleHsUp emits its terminal done/error NDJSON step.
  await handleHsUp(configPath, configDir, config, docker, {
    password: options.password,
    force: true,
    skipPreflight: options.skipPreflight,
    hsOverrides,
    json,
  });
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
      opts: { profile: 'hs' | 'direct'; composePath: string }
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
const CHAINS_HELP = `townhouse chains — configure settlement chains (connector chainProviders)

The connector settles ILP payment claims on these chains. Changes take effect
on the next 'townhouse hs down && townhouse hs up'.

Usage:
  townhouse chains list [--json] [-c <path>]
  townhouse chains add  --chain-type <evm|solana|mina> --chain-id <id> [fields] [-c <path>]
  townhouse chains remove <chainId> [-c <path>]

Fields by chain type ([--key-id] is OPTIONAL — defaults to the operator's
mnemonic-derived apex settlement key; pass it only for an external/hardware key):
  evm:    --rpc-url <url> --registry <0x..> --token-address <0x..> [--key-id <0x..>]
  solana: --rpc-url <url> --program-id <addr> [--key-id <id>] [--ws-url <url>] [--token-mint <addr>]
  mina:   --graphql-url <url> --zkapp <addr> [--key-id <id>]`;

interface ChainsFlags {
  chainType?: string;
  chainId?: string;
  rpcUrl?: string;
  wsUrl?: string;
  registry?: string;
  tokenAddress?: string;
  tokenMint?: string;
  programId?: string;
  graphqlUrl?: string;
  zkapp?: string;
  keyId?: string;
}

/** Build a typed ChainProviderEntry from CLI flags. Throws on missing fields. */
function buildChainProviderFromFlags(f: ChainsFlags): ChainProviderEntry {
  const { chainType, chainId } = f;
  if (chainType !== 'evm' && chainType !== 'solana' && chainType !== 'mina') {
    throw new Error('--chain-type must be one of: evm, solana, mina');
  }
  if (!chainId) throw new Error('--chain-id is required');

  const require = (flag: string, val: string | undefined): string => {
    if (!val) throw new Error(`${flag} is required for ${chainType} chains`);
    return val;
  };

  // `--key-id` is OPTIONAL: when omitted, `townhouse hs up` fills it with the
  // operator's mnemonic-derived apex settlement key. Pass it only for an
  // external/hardware key.
  if (chainType === 'evm') {
    return {
      chainType: 'evm',
      chainId,
      rpcUrl: require('--rpc-url', f.rpcUrl),
      registryAddress: require('--registry', f.registry),
      tokenAddress: require('--token-address', f.tokenAddress),
      ...(f.keyId ? { keyId: f.keyId } : {}),
    };
  }
  if (chainType === 'solana') {
    return {
      chainType: 'solana',
      chainId,
      rpcUrl: require('--rpc-url', f.rpcUrl),
      ...(f.wsUrl ? { wsUrl: f.wsUrl } : {}),
      programId: require('--program-id', f.programId),
      ...(f.tokenMint ? { tokenMint: f.tokenMint } : {}),
      ...(f.keyId ? { keyId: f.keyId } : {}),
    };
  }
  // mina
  return {
    chainType: 'mina',
    chainId,
    graphqlUrl: require('--graphql-url', f.graphqlUrl),
    zkAppAddress: require('--zkapp', f.zkapp),
    ...(f.keyId ? { keyId: f.keyId } : {}),
  };
}

/**
 * `townhouse chains <list|add|remove>` — edit the connector settlement chains
 * (config.chainProviders) for EVM / Solana / Mina without hand-editing YAML.
 */
async function handleChains(
  action: string | undefined,
  chainIdArg: string | undefined,
  flags: ChainsFlags,
  configPath: string,
  jsonMode: boolean
): Promise<void> {
  if (!action) {
    console.log(CHAINS_HELP);
    throw new CliHelpRequested();
  }

  const config = loadConfig(configPath);
  const providers: ChainProviderEntry[] = config.chainProviders ?? [];

  switch (action) {
    case 'list': {
      if (jsonMode) {
        console.log(JSON.stringify(providers, null, 2));
        return;
      }
      if (providers.length === 0) {
        console.log(
          'No settlement chains configured — the connector uses a built-in dev-Anvil EVM placeholder.'
        );
        console.log(
          'Add one with:  townhouse chains add --chain-type evm --chain-id evm:base:8453 ...'
        );
        return;
      }
      console.log('Configured settlement chains:');
      for (const p of providers) {
        console.log(`  ${p.chainType.padEnd(6)} ${p.chainId}`);
      }
      return;
    }
    case 'add': {
      let entry: ChainProviderEntry;
      try {
        entry = buildChainProviderFromFlags(flags);
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      // Idempotent upsert: replace any existing entry with the same chainId.
      const next = providers.filter((p) => p.chainId !== entry.chainId);
      next.push(entry);
      try {
        saveConfig(configPath, { ...config, chainProviders: next });
      } catch (err: unknown) {
        console.error(
          `Invalid chain config: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exitCode = 1;
        return;
      }
      if (jsonMode) {
        console.log(
          JSON.stringify({
            added: true,
            chainType: entry.chainType,
            chainId: entry.chainId,
          })
        );
        return;
      }
      console.log(
        `Added ${entry.chainType} settlement chain '${entry.chainId}'.`
      );
      console.log('Apply with:  townhouse hs down && townhouse hs up');
      return;
    }
    case 'remove': {
      if (!chainIdArg) {
        console.error('Usage: townhouse chains remove <chainId>');
        process.exitCode = 1;
        return;
      }
      const next = providers.filter((p) => p.chainId !== chainIdArg);
      if (next.length === providers.length) {
        console.error(
          `No settlement chain with chainId '${chainIdArg}' found.`
        );
        process.exitCode = 1;
        return;
      }
      saveConfig(configPath, {
        ...config,
        chainProviders: next.length > 0 ? next : undefined,
      });
      if (jsonMode) {
        console.log(JSON.stringify({ removed: true, chainId: chainIdArg }));
        return;
      }
      console.log(`Removed settlement chain '${chainIdArg}'.`);
      console.log('Apply with:  townhouse hs down && townhouse hs up');
      return;
    }
    default: {
      // eslint-disable-next-line no-control-regex
      const safe = action.replace(/[\x00-\x1f\x7f]/g, '');
      console.error(`Unknown chains subcommand: ${safe}`);
      console.log(CHAINS_HELP);
      process.exitCode = 1;
    }
  }
}

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
      version: { type: 'boolean' },
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
      network: { type: 'string' },
      'evm-url': { type: 'string' },
      'sol-url': { type: 'string' },
      yes: { type: 'boolean' },
      'rotate-keys': { type: 'boolean' },
      'skip-preflight': { type: 'boolean' },
      // Phase 3: `townhouse up` defaults to a direct-BTP apex + children.
      //   --transport direct (default) | --transport hs (synonym for `hs up`).
      //   --dev selects the contributor children-only dev stack (profile:'dev').
      transport: { type: 'string' },
      dev: { type: 'boolean' },
      json: { type: 'boolean' },
      'json-compact': { type: 'boolean' },
      lines: { type: 'string' },
      follow: { type: 'boolean', short: 'f' },
      units: { type: 'string' },
      rate: { type: 'string' },
      // credits buy / credits balance (epic-49, Phase 2)
      token: { type: 'string' },
      amount: { type: 'string' },
      'fee-multiplier': { type: 'string' },
      'quote-only': { type: 'boolean' },
      'credit-destination': { type: 'string' },
      // wallet show / wallet seed (epic-49, Phase 3)
      hex: { type: 'boolean' },
      paths: { type: 'boolean' },
      confirm: { type: 'boolean' },
      // chains add (multi-chain settlement config)
      'chain-type': { type: 'string' },
      'chain-id': { type: 'string' },
      'rpc-url': { type: 'string' },
      'ws-url': { type: 'string' },
      registry: { type: 'string' },
      'token-address': { type: 'string' },
      'token-mint': { type: 'string' },
      'program-id': { type: 'string' },
      'graphql-url': { type: 'string' },
      zkapp: { type: 'string' },
      'key-id': { type: 'string' },
      // node add operator inputs (mill relays / dvm Arweave Turbo credential /
      // town settlement chain + token)
      relays: { type: 'string' },
      'turbo-token': { type: 'string' },
      'settlement-chain': { type: 'string' },
      asset: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  });

  const command = positionals[0];

  // `townhouse --version` / `townhouse version` — print the package version and
  // exit cleanly. `--json` yields `{ "version": "x.y.z" }` for tooling probes.
  if (values.version === true || command === 'version') {
    const version = readCliVersion();
    console.log(values.json === true ? JSON.stringify({ version }) : version);
    throw new CliHelpRequested();
  }

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
      const networkVal = values.network as string | undefined;
      if (
        networkVal !== undefined &&
        !['mainnet', 'testnet', 'devnet', 'custom'].includes(networkVal)
      ) {
        console.error(
          `Unknown network: ${networkVal}. Supported: mainnet, testnet, devnet, custom`
        );
        process.exitCode = 1;
        break;
      }
      const evmUrl =
        (values['evm-url'] as string | undefined) ?? process.env['EVM_URL'];
      const solUrl =
        (values['sol-url'] as string | undefined) ?? process.env['SOL_URL'];
      const endpoints =
        evmUrl || solUrl
          ? {
              ...(evmUrl ? { evmUrl } : {}),
              ...(solUrl ? { solUrl } : {}),
            }
          : undefined;
      await handleInit(
        values.force === true,
        values['config-dir'] as string | undefined,
        values.password as string | undefined,
        presetVal,
        values.yes === true,
        networkVal as NetworkMode | undefined,
        endpoints,
        values.json === true
      );
      break;
    }
    case 'wallet': {
      const subCommand = positionals[1];
      if (subCommand === 'show') {
        const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
        const config = loadConfig(configPath);
        await handleWalletShow(config, values.password as string | undefined, {
          json: values.json === true,
          hex: values.hex === true,
          paths: values.paths === true,
        });
      } else if (subCommand === 'seed') {
        const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
        const config = loadConfig(configPath);
        await handleWalletSeed(
          config,
          values.password as string | undefined,
          values.confirm === true,
          values.json === true
        );
      } else {
        console.error(
          'Usage:\n' +
            '  townhouse wallet show [--json] [--hex] [--paths] [-c <path>] [--password <pw>]\n' +
            '  townhouse wallet seed --confirm [-c <path>] [--password <pw>]'
        );
        process.exitCode = 1;
      }
      break;
    }
    case 'credits': {
      const subCommand = positionals[1];
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      if (subCommand === 'buy') {
        await handleCreditsBuy(config, values as Record<string, unknown>);
      } else if (subCommand === 'balance') {
        await handleCreditsBalance(config, values as Record<string, unknown>);
      } else {
        console.error(
          'Usage:\n' +
            '  townhouse credits buy --token <id> --amount <decimal> [--fee-multiplier <n>] [--quote-only] [--yes] [-c <path>] [--password <pw>]\n' +
            '  townhouse credits balance --token <id> [-c <path>] [--password <pw>]'
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
        { units, satsPerUsdc, configPath, json: values.json === true }
      );
      break;
    }
    case 'up': {
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      const docker = dockerInstance ?? new Docker();
      const configDir = dirname(configPath);
      const transport = values.transport as string | undefined;

      // Phase 3 — `townhouse up` defaults to a DIRECT-BTP apex + children.
      //   (no flags)            → direct apex + children   (default)
      //   --transport direct    → direct apex + children   (explicit synonym)
      //   --transport hs        → hidden-service apex       (synonym for `hs up`)
      //   --dev                 → contributor children-only dev stack (profile:'dev')
      // dev / direct / HS stacks are port-mutually-exclusive — keep them so.
      if (
        transport !== undefined &&
        transport !== 'direct' &&
        transport !== 'hs'
      ) {
        console.error(
          `Unknown --transport value: ${transport}. Supported: direct (default), hs`
        );
        process.exitCode = 1;
        break;
      }

      // Explicit contributor/dev-stack escape hatch (the pre-Phase-3 `up`).
      if (values.dev === true) {
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

      // `--transport hs` is a synonym for `townhouse hs up`.
      if (transport === 'hs') {
        await handleHsUp(configPath, configDir, config, docker, {
          password: values.password as string | undefined,
          force: values.force === true,
          skipPreflight: values['skip-preflight'] === true,
          hsOverrides,
          json: values.json === true,
        });
        break;
      }

      // Default (and `--transport direct`): direct-BTP apex + children.
      await handleDirectUp(configPath, configDir, config, docker, {
        password: values.password as string | undefined,
        force: values.force === true,
        skipPreflight: values['skip-preflight'] === true,
        hsOverrides,
        json: values.json === true,
      });
      break;
    }
    case 'down': {
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      const docker = dockerInstance ?? new Docker();
      await handleDown(config, docker, values.json === true);
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
          skipPreflight: values['skip-preflight'] === true,
          hsOverrides,
          json: values.json === true,
        });
      } else if (action === 'enable') {
        await handleHsEnable(configPath, configDir, config, docker, {
          password: values.password as string | undefined,
          force: values.force === true,
          skipPreflight: values['skip-preflight'] === true,
          hsOverrides,
          json: values.json === true,
        });
      } else if (action === 'down') {
        await handleHsDown(configDir, config, docker, {
          rotateKeys: values['rotate-keys'] === true,
          hsOverrides,
        });
      } else {
        console.error(
          'Usage: townhouse hs <up|enable|down> [--rotate-keys] [--password <pw>] [-c <path>]'
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
            relays: values['relays'] as string | undefined,
            turboToken: values['turbo-token'] as string | undefined,
            settlementChain: values['settlement-chain'] as string | undefined,
            asset: values['asset'] as string | undefined,
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
    case 'chains': {
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const action = positionals[1];
      const chainIdArg = positionals[2];
      // `chains supported` — list the (chain, token) settlement options the
      // operator can pass to `node add town --settlement-chain/--asset`.
      if (action === 'supported') {
        const cfg = loadConfig(configPath);
        const assets = listSupportedSettlementAssets(cfg);
        if (values.json === true) {
          console.log(JSON.stringify({ chains: assets }));
        } else if (assets.length === 0) {
          console.log(
            'No supported settlement chains. Set `network` (mainnet/testnet/devnet) or run `townhouse chains add`.'
          );
        } else {
          console.log(
            'Supported settlement chains/tokens — use with `node add town --settlement-chain <id> --asset <code>`:'
          );
          for (const a of assets) {
            console.log(
              `  ${a.chainId}  ${a.assetCode} (scale ${a.assetScale})${a.native ? ' [native]' : ''}`
            );
          }
        }
        break;
      }
      const flags: ChainsFlags = {
        chainType: values['chain-type'] as string | undefined,
        chainId: values['chain-id'] as string | undefined,
        rpcUrl: values['rpc-url'] as string | undefined,
        wsUrl: values['ws-url'] as string | undefined,
        registry: values['registry'] as string | undefined,
        tokenAddress: values['token-address'] as string | undefined,
        tokenMint: values['token-mint'] as string | undefined,
        programId: values['program-id'] as string | undefined,
        graphqlUrl: values['graphql-url'] as string | undefined,
        zkapp: values['zkapp'] as string | undefined,
        keyId: values['key-id'] as string | undefined,
      };
      await handleChains(
        action,
        chainIdArg,
        flags,
        configPath,
        values.json === true
      );
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
// process.argv[1] can be a symlink (e.g. node_modules/.bin/townhouse created by
// npm/npx), while import.meta.url is the realpath of dist/cli.js. Comparing them
// directly makes the guard false under npx/installed-bin, so main() never runs and
// every command silently no-ops. Resolve symlinks before comparing.
const invokedFile = process.argv[1];
let invokedDirectly = false;
if (typeof invokedFile === 'string') {
  try {
    invokedDirectly =
      import.meta.url === pathToFileURL(realpathSync(invokedFile)).href;
  } catch {
    invokedDirectly = import.meta.url === pathToFileURL(invokedFile).href;
  }
}

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof CliHelpRequested) {
      process.exit(0);
    }
    console.error('[Townhouse] Error:', error);
    process.exit(1);
  });
}
