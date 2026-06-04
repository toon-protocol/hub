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
import { ConnectorConfigGenerator } from './config-generator.js';
import { resolveConfigNetworkProfile } from '../config/network-profile.js';
import type { ChainProviderEntry, TownhouseConfig } from '../config/schema.js';
import { DEFAULT_HS_CHAIN_PROVIDERS } from '../config/defaults.js';
import type { ConnectorRuntimeConfig } from './types.js';

/** Absolute path inside the connector container where anon stores the keypair. */
const HS_DIR = '/var/lib/anon/hs';

/** Port the connector's BTP server listens on (inside the container). */
const HS_PORT = 3000;

/**
 * HTTP handler endpoint of the dvm node container. Unlike town/mill, the dvm
 * runs a standalone ILP HTTP handler (it does NOT run a BTP server the apex can
 * dial), so the connector reaches it via `localDelivery` rather than a peer
 * route. Host + port match the dvm service in townhouse-hs.yml (HANDLER_PORT).
 */
const DVM_HANDLER_URL = 'http://townhouse-hs-dvm:3300';

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
  options: {
    force?: boolean;
    /**
     * Apex settlement key(s) derived from the operator mnemonic
     * (`WalletManager.getApexSettlementKeys()`). When present, a chainProvider
     * that has NO explicit `keyId` is filled with the matching derived key, so
     * operators never paste a settlement key into `chains add`. The raw key
     * lands ONLY in the generated `connector.yaml` (0600), never in config.yaml.
     */
    apexSettlementKeys?: { evmPrivateKeyHex: string };
  } = {}
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

  // Resolve the apex connector's chainProviders. Precedence:
  //   1. explicit config.chainProviders (operator ran `townhouse chains add`)
  //   2. derived from `network` via resolveNetworkProfile (the network flag,
  //      shared with the child node containers — see env-writer.ts)
  //   3. DEFAULT_HS_CHAIN_PROVIDERS — last-resort dev-Anvil placeholders so the
  //      connector's settlement subsystem (AccountManager + ClaimReceiver) still
  //      initializes and `/admin/earnings.json` returns 200 (Epic 47 BUG-1).
  //
  // (2) yields no entries until TOON's on-chain settlement contracts are deployed
  // to public chains (the presets carry empty registry/program/zkApp today), so in
  // practice the apex still uses (3) for now while the child nodes already get the
  // real public RPCs from the same network profile. The dev key from (3) is reused
  // so derived providers are complete the moment the preset addresses are filled in.
  // Apex settlement key derived from the operator mnemonic (when supplied by
  // `hs up`). Used both as the fallback key for network-profile-derived
  // providers and to fill any configured provider that lacks an explicit keyId.
  const apexEvmKey = options.apexSettlementKeys?.evmPrivateKeyHex;

  const derived = resolveConfigNetworkProfile(
    config,
    apexEvmKey ?? DEFAULT_HS_CHAIN_PROVIDERS[0]?.keyId
  ).chainProviders as ChainProviderEntry[];

  // Fill a missing EVM keyId with the mnemonic-derived apex key. Precedence:
  //   1. explicit keyId on the provider (operator `--key-id`, or the dev e2e's
  //      funded Anvil key) — left untouched,
  //   2. mnemonic-derived apex key (here).
  // (Solana/Mina apex keys are a later phase.) The bare DEFAULT fallback below
  // keeps its funded Anvil placeholder key so a no-chains dev boot is unchanged.
  const fillApexKey = (providers: ChainProviderEntry[]): ChainProviderEntry[] =>
    providers.map((p) =>
      !p.keyId && p.chainType === 'evm' && apexEvmKey
        ? { ...p, keyId: apexEvmKey }
        : p
    );

  const hsConfig: TownhouseConfig =
    derived.length > 0
      ? { ...config, chainProviders: fillApexKey(derived) }
      : { ...config, chainProviders: [...DEFAULT_HS_CHAIN_PROVIDERS] };

  // Build the HS runtime config by extending the base generated config.
  const generator = new ConnectorConfigGenerator(hsConfig);
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

  // DVM job intake. The dvm node has no BTP server, so the apex cannot route to
  // it as a peer; instead it locally-delivers packets addressed to its OWN
  // nodeId to the dvm's HTTP handler. Clients publish kind:5094 job requests to
  // the apex address (g.townhouse) and the connector forwards them here. This is
  // a no-op when no dvm is provisioned (nothing is sent to the bare apex
  // address), and does not shadow the more-specific g.townhouse.<node> peer
  // routes (longest-prefix match wins). Without it the dvm can never receive a
  // job — it neither subscribes to a relay nor runs a dialable BTP server.
  const apexNodeId =
    typeof parsed['nodeId'] === 'string'
      ? (parsed['nodeId'] as string)
      : 'g.townhouse';
  parsed['localDelivery'] = { enabled: true, handlerUrl: DVM_HANDLER_URL };
  const existingRoutes = Array.isArray(parsed['routes'])
    ? (parsed['routes'] as Record<string, unknown>[])
    : [];
  if (
    !existingRoutes.some(
      (r) => r['prefix'] === apexNodeId && r['nextHop'] === 'local'
    )
  ) {
    existingRoutes.push({
      prefix: apexNodeId,
      nextHop: 'local',
      priority: 100,
    });
  }
  parsed['routes'] = existingRoutes;

  const finalYaml = yamlStringify(parsed);

  // Write atomically: writeFileSync is not atomic on all platforms, but since
  // we set mode on creation and then defensively chmod, this is consistent with
  // the pattern used by materializeComposeTemplate (Story 45.2).
  writeFileSync(yamlPath, finalYaml, { mode: 0o600, encoding: 'utf-8' });
  chmodSync(yamlPath, 0o600);

  return { yamlPath, created: true };
}
