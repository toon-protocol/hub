/**
 * Config file loader — reads YAML, validates, writes.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { validateConfig } from './validator.js';
import { getDefaultConfig } from './defaults.js';
import type { TownhouseConfig } from './schema.js';

/**
 * Load and validate a Townhouse config from a YAML file.
 * Environment variables override YAML values for key settings:
 *   - TOWNHOUSE_API_PORT
 *   - TOWNHOUSE_TRANSPORT_MODE
 *   - TOWNHOUSE_LOG_LEVEL
 */
export function loadConfig(configPath: string): TownhouseConfig {
  let rawText: string;
  try {
    rawText = readFileSync(configPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parse(rawText);
  } catch {
    throw new Error(`Failed to parse YAML config at ${configPath}`);
  }

  // An empty YAML file parses to null — treat as empty object so defaults apply
  if (parsed === null || parsed === undefined) {
    parsed = {};
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Config at ${configPath} must be a YAML mapping (object), not ${Array.isArray(parsed) ? 'an array' : typeof parsed}`
    );
  }

  // Deep-merge with defaults so partial configs work
  const defaults = getDefaultConfig();
  const merged = deepMerge(
    defaults as unknown as Record<string, unknown>,
    parsed as Record<string, unknown>
  );

  // Apply environment variable overrides
  applyEnvOverrides(merged);

  return validateConfig(merged);
}

function applyEnvOverrides(config: Record<string, unknown>): void {
  const env = process.env;

  if (env['TOWNHOUSE_API_PORT']) {
    const port = parseInt(env['TOWNHOUSE_API_PORT'], 10);
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
      throw new Error('TOWNHOUSE_API_PORT must be 0..65535');
    }
    const api = config['api'] as Record<string, unknown> | undefined;
    if (api) {
      api['port'] = port;
    }
  }

  if (env['TOWNHOUSE_TRANSPORT_MODE']) {
    const mode = env['TOWNHOUSE_TRANSPORT_MODE'];
    if (mode !== 'hs' && mode !== 'direct') {
      throw new Error('TOWNHOUSE_TRANSPORT_MODE must be "hs" or "direct"');
    }
    const transport = config['transport'] as
      | Record<string, unknown>
      | undefined;
    if (transport) {
      transport['mode'] = mode;
    }
  }

  if (env['TOWNHOUSE_LOG_LEVEL']) {
    const level = env['TOWNHOUSE_LOG_LEVEL'];
    if (!['debug', 'info', 'warn', 'error'].includes(level)) {
      throw new Error(
        'TOWNHOUSE_LOG_LEVEL must be one of: debug, info, warn, error'
      );
    }
    const logging = config['logging'] as Record<string, unknown> | undefined;
    if (logging) {
      logging['level'] = level;
    }
  }
}

/** Keys that must never be merged — prevents prototype pollution (CWE-1321). */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Simple deep merge — target values are overwritten by source values.
 * Arrays are replaced, not concatenated.
 * Skips dangerous keys to prevent prototype pollution from crafted YAML.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue;
    }
    const sv = source[key];
    const tv = target[key];
    if (
      typeof sv === 'object' &&
      sv !== null &&
      !Array.isArray(sv) &&
      typeof tv === 'object' &&
      tv !== null &&
      !Array.isArray(tv)
    ) {
      result[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>
      );
    } else {
      result[key] = sv;
    }
  }
  return result;
}

/**
 * Save a config to a YAML file atomically.
 * Writes to a temp file first, then renames to the target (atomic on POSIX).
 */
export function saveConfig(configPath: string, config: TownhouseConfig): void {
  // Validate before saving
  const validated = validateConfig(config);

  // Serialize to YAML
  const yaml = stringify(validated);

  // Write to temp file first
  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, yaml, 'utf-8');

  // Atomic rename
  renameSync(tmpPath, configPath);
}
