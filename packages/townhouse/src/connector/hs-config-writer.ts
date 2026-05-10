/**
 * HS connector config writer for `townhouse hs up` (Story 45.4, Task 3).
 *
 * Generates ~/.townhouse/connector.yaml with anon.enabled: true and the
 * managed hidden-service transport block so the connector spawns the anon
 * binary and publishes a .anyone v3 hidden service automatically.
 *
 * Idempotency: if the file already exists and contains `anon.enabled: true`,
 * it is reused verbatim (preserves operator edits). Pass `force: true` to
 * overwrite unconditionally.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify as yamlStringify } from 'yaml';
import {
  ConnectorConfigGenerator,
  DEFAULT_ATOR_PROXY,
} from './config-generator.js';
import type { TownhouseConfig } from '../config/schema.js';
import type { ConnectorRuntimeConfig } from './types.js';

/** Absolute path inside the connector container where anon stores the keypair. */
const HS_DIR = '/var/lib/anon/hs';

/** Port the connector's BTP server listens on (inside the container). */
const HS_PORT = 3000;

// HS detection: parse the YAML and check anon.enabled === true. This avoids
// false negatives from YAML formatting differences (dotted key vs. nested block).

export interface WriteHsConnectorConfigResult {
  yamlPath: string;
  /** true if the file was freshly written; false if an existing HS file was reused. */
  created: boolean;
}

/**
 * Write (or reuse) `~/.townhouse/connector.yaml` with HS-specific overrides.
 *
 * @param configDir - The townhouse home directory (e.g. `~/.townhouse/`).
 * @param config - Loaded `TownhouseConfig` (provides adminPort, ilpAddress, etc.).
 * @param options.force - When true, overwrite even if an HS file already exists.
 */
export function writeHsConnectorConfig(
  configDir: string,
  config: TownhouseConfig,
  options: { force?: boolean } = {}
): WriteHsConnectorConfigResult {
  const yamlPath = join(configDir, 'connector.yaml');

  // Idempotency check: if the file exists and was written by a prior hs up,
  // reuse it verbatim so operator edits (e.g. log level) are preserved.
  if (!options.force && existsSync(yamlPath)) {
    try {
      const existing = parse(readFileSync(yamlPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const anon = existing['anon'] as Record<string, unknown> | undefined;
      if (anon?.['enabled'] === true) {
        return { yamlPath, created: false };
      }
    } catch {
      // Unparseable existing file — fall through to overwrite.
    }
    // Existing file lacks anon.enabled: true — treat as legacy non-HS config.
    // Fall through to overwrite.
  }

  // Build the HS runtime config by extending the base generated config.
  const generator = new ConnectorConfigGenerator(config);
  const baseConfig = generator.generate([]); // apex-only, no peers

  // Managed mode: the connector spawns the anon daemon in-process. The SOCKS
  // proxy port binds locally at 127.0.0.1:9050 — use the local address so the
  // connector's TCP-readiness check waits for the right host, not the external
  // public ATOR proxy (proxy.ator.io:9050) which can never bind locally.
  const HS_LOCAL_SOCKS_PROXY = 'socks5h://127.0.0.1:9050';

  const hsRuntimeConfig: ConnectorRuntimeConfig = {
    ...baseConfig,
    transport: {
      mode: 'ator',
      socksProxy: HS_LOCAL_SOCKS_PROXY,
      externalUrl: 'auto',
      hiddenService: {
        dir: HS_DIR,
        port: HS_PORT,
        // The orchestrator polls getHsHostname() for up to 120s; give the
        // connector the same budget so the internal timeout doesn't fire first.
        startupTimeoutMs: 120_000,
      },
    },
  };

  // Render the base YAML, then add `anon: { enabled: true }` as a top-level field.
  const baseYaml = generator.toYaml(hsRuntimeConfig);
  const parsed = parse(baseYaml) as Record<string, unknown>;
  parsed['anon'] = { enabled: true };
  const finalYaml = yamlStringify(parsed);

  // Write atomically: writeFileSync is not atomic on all platforms, but since
  // we set mode on creation and then defensively chmod, this is consistent with
  // the pattern used by materializeComposeTemplate (Story 45.2).
  writeFileSync(yamlPath, finalYaml, { mode: 0o600, encoding: 'utf-8' });
  chmodSync(yamlPath, 0o600);

  return { yamlPath, created: true };
}
