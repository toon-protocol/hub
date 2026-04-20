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
  townhouse init [--force] [--config-dir <dir>]  Initialize config
  townhouse up [-c <path>]                       Start enabled nodes
  townhouse down [-c <path>]                     Stop all nodes
  townhouse status                               Show node status
  townhouse --help                               Show this help`;

const DEFAULT_CONFIG_DIR = join(homedir(), '.townhouse');
const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.yaml');

/** Container name prefix used by Townhouse */
const CONTAINER_PREFIX = 'townhouse-';

/** Node types and their container name suffixes */
const NODE_TYPES = ['connector', 'town', 'mill', 'dvm'] as const;

interface StatusResult {
  name: string;
  state: string;
}

async function getContainerStatuses(docker: Docker): Promise<StatusResult[]> {
  let containers: Docker.ContainerInfo[];
  try {
    containers = await docker.listContainers({ all: true });
  } catch {
    // Docker not available — all stopped
    return NODE_TYPES.map((name) => ({ name, state: 'stopped' }));
  }

  return NODE_TYPES.map((nodeType) => {
    const containerName = `${CONTAINER_PREFIX}${nodeType}`;
    const info = containers.find((c) =>
      c.Names.some((n) => n === `/${containerName}` || n === containerName)
    );
    return {
      name: nodeType,
      state: info?.State ?? 'stopped',
    };
  });
}

function handleInit(force: boolean, configDir?: string): void {
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
}

async function handleStatus(docker: Docker): Promise<void> {
  const statuses = await getContainerStatuses(docker);

  console.log('Node Status:');
  console.log('------------');
  for (const s of statuses) {
    console.log(`  ${s.name.padEnd(12)} ${s.state}`);
  }
}

function handleUp(config: TownhouseConfig): void {
  const enabled = Object.entries(config.nodes)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);

  if (enabled.length === 0) {
    console.log(
      'No nodes enabled in config. Enable nodes in config.yaml first.'
    );
    return;
  }

  console.log(`Starting nodes: ${enabled.join(', ')}...`);
  // Full orchestration is Story 21.2
}

function handleDown(_config: TownhouseConfig): void {
  console.log('Stopping nodes...');
  // Full orchestration is Story 21.2
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
      handleInit(
        values.force === true,
        values['config-dir'] as string | undefined
      );
      break;
    }
    case 'status': {
      const docker = dockerInstance ?? new Docker();
      await handleStatus(docker);
      break;
    }
    case 'up': {
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      handleUp(config);
      break;
    }
    case 'down': {
      const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
      const config = loadConfig(configPath);
      handleDown(config);
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
