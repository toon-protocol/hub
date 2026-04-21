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
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import Docker from 'dockerode';

import { getDefaultConfig } from './config/defaults.js';
import { loadConfig } from './config/loader.js';
import type { TownhouseConfig } from './config/schema.js';
import { DockerOrchestrator } from './docker/index.js';
import type { NodeType } from './docker/types.js';
import { ConnectorAdminClient } from './connector/index.js';
import {
  WalletManager,
  encryptWallet,
  decryptWallet,
  saveWallet,
  loadWallet,
} from './wallet/index.js';

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
  townhouse init [--force] [--config-dir <dir>] [--password <pw>]  Initialize config + wallet
  townhouse up [--town] [--mill] [--dvm] [-c <path>] [--password <pw>]  Start nodes
  townhouse down [-c <path>]                     Stop all nodes
  townhouse status [-c <path>]                   Show node status
  townhouse metrics [-c <path>]                  Show connector metrics
  townhouse wallet show [-c <path>] [--password <pw>]  Show derived addresses
  townhouse --help                               Show this help

Flags:
  --town       Start Town (Nostr relay) node
  --mill       Start Mill (swap) node
  --dvm        Start DVM (compute) node
  --password   Wallet password (non-interactive mode)
  If no flags given, starts all enabled nodes from config.`;

const DEFAULT_CONFIG_DIR = join(homedir(), '.townhouse');
const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.yaml');

async function handleInit(
  force: boolean,
  configDir?: string,
  password?: string
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

  const defaultConfig = getDefaultConfig();
  const yamlContent = stringify(defaultConfig);

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
  const { mnemonic } = walletManager.generate();

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
    walletManager.fromMnemonic(decryptWallet(result.wallet, walletPassword));
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

async function handleStatus(
  docker: Docker,
  config: TownhouseConfig
): Promise<void> {
  const orchestrator = new DockerOrchestrator(docker, config);
  const statuses = await orchestrator.status();

  console.log('Node Status:');
  console.log('------------');
  for (const s of statuses) {
    const health = s.health ? ` (${s.health})` : '';
    console.log(`  ${s.name.padEnd(12)} ${s.state}${health}`);
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
    console.log(`  Packets forwarded: ${metrics.packetsForwarded}`);
    console.log(`  Active peers:      ${activePeers}/${peers.length}`);
  } catch {
    console.log('');
    console.log('Connector Metrics: unavailable');
  }
}

async function handleMetrics(config: TownhouseConfig): Promise<void> {
  const adminClient = new ConnectorAdminClient(
    `http://127.0.0.1:${config.connector.adminPort}`
  );

  try {
    const metrics = await adminClient.getMetrics();
    const peers = await adminClient.getPeers();

    console.log('Connector Metrics:');
    console.log('------------------');
    console.log(`  Packets forwarded: ${metrics.packetsForwarded}`);
    console.log(`  Packets rejected:  ${metrics.packetsRejected}`);
    console.log(`  Bytes sent:        ${metrics.bytesSent}`);
    console.log('');
    console.log('Peers:');
    console.log('------');
    if (peers.length === 0) {
      console.log('  No peers connected');
    } else {
      for (const peer of peers) {
        const status = peer.connected ? 'connected' : 'disconnected';
        console.log(
          `  ${peer.id.padEnd(12)} ${status}  (${peer.packetsForwarded} packets)`
        );
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to fetch connector metrics: ${msg}`);
    process.exitCode = 1;
  }
}

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
  config: TownhouseConfig,
  profiles: NodeType[],
  docker: Docker
): Promise<void> {
  if (profiles.length === 0) {
    console.log(
      'No nodes enabled in config. Enable nodes in config.yaml first.'
    );
    return;
  }

  const orchestrator = new DockerOrchestrator(docker, config);

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

  // Register SIGINT handler for graceful shutdown
  const sigintHandler = async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    try {
      await orchestrator.down();
    } catch {
      // Best-effort cleanup
    }
    process.exit(0);
  };
  process.on('SIGINT', sigintHandler);

  try {
    console.log(`Starting nodes: ${profiles.join(', ')}...`);
    await orchestrator.up(profiles);
    console.log('All nodes started successfully.');
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
    // Remove SIGINT handler to prevent listener leak after handleUp completes
    process.removeListener('SIGINT', sigintHandler);
  }
}

async function handleDown(
  config: TownhouseConfig,
  docker: Docker
): Promise<void> {
  const orchestrator = new DockerOrchestrator(docker, config);

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

/**
 * Main CLI entry — exported for testability (same pattern as Mill CLI).
 * Accepts optional dockerode instance for dependency injection in tests.
 */
export async function main(
  argv: string[],
  dockerInstance?: Docker
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
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP_TEXT);
    throw new CliHelpRequested();
  }

  const command = positionals[0];

  if (!command) {
    console.log(HELP_TEXT);
    throw new CliHelpRequested();
  }

  switch (command) {
    case 'init': {
      await handleInit(
        values.force === true,
        values['config-dir'] as string | undefined,
        values.password as string | undefined
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
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      const docker = dockerInstance ?? new Docker();
      await handleStatus(docker, config);
      break;
    }
    case 'up': {
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      const docker = dockerInstance ?? new Docker();
      const profiles = resolveProfiles(values, config);
      await handleUp(config, profiles, docker);
      break;
    }
    case 'down': {
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      const docker = dockerInstance ?? new Docker();
      await handleDown(config, docker);
      break;
    }
    case 'metrics': {
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      await handleMetrics(config);
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
