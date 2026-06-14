/**
 * Apex connector config writer for `townhouse hs up` / `townhouse up --transport
 * direct` (Story 45.4, Task 3; Phase 2 direct-apex).
 *
 * Two public entry points share the same base-config rendering
 * (`ConnectorConfigGenerator` + chainProvider resolution + apexSettlementKeys
 * injection + DVM localDelivery route):
 *
 *   - writeHsConnectorConfig: HS mode. Emits `anon.enabled: true` and the
 *     managed hidden-service transport block so the connector spawns the anon
 *     binary and publishes a .anyone v3 hidden service.
 *   - writeDirectConnectorConfig: direct mode. Emits NO `anon` stanza; the
 *     transport block is {type:'direct'} (the connector's BTP port :3000 is
 *     exposed to the host by the compose template instead of an HS).
 *
 * Idempotency: if the file already exists and contains the matching transport
 * marker (HS ⇒ `anon.enabled: true`; direct ⇒ no `anon` block), it is reused
 * verbatim (preserves operator edits). Pass `force: true` to overwrite.
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
 * route. Host + port match the dvm service in the matching compose template
 * (HANDLER_PORT). The container name differs per profile (HS vs. direct), so
 * the handler URL is parameterized by the writer.
 */
const HS_DVM_HANDLER_URL = 'http://townhouse-hs-dvm:3300';
const DIRECT_DVM_HANDLER_URL = 'http://townhouse-direct-dvm:3300';

/** Settlement keys derived from the operator mnemonic (shared by both writers). */
interface ApexSettlementKeys {
  evmPrivateKeyHex?: string;
  solanaPrivateKeyBase58?: string;
  minaPrivateKeyBase58?: string;
}

export interface WriteHsConnectorConfigResult {
  yamlPath: string;
  /** true if the file was freshly written; false if an existing file was reused. */
  created: boolean;
}

/** Alias for the direct writer's result (same shape as the HS writer). */
export type WriteDirectConnectorConfigResult = WriteHsConnectorConfigResult;

/**
 * Resolve the apex connector's chainProviders + build a ConnectorConfigGenerator
 * against them, applying apexSettlementKeys. Shared by both the HS and direct
 * writers — the precedence/keyId-fill logic is transport-agnostic.
 *
 * Precedence:
 *   1. explicit config.chainProviders (operator ran `townhouse chains add`)
 *   2. derived from `network` via resolveNetworkProfile (the network flag,
 *      shared with the child node containers — see env-writer.ts)
 *   3. DEFAULT_HS_CHAIN_PROVIDERS — last-resort dev-Anvil placeholders so the
 *      connector's settlement subsystem (AccountManager + ClaimReceiver) still
 *      initializes and `/admin/earnings.json` returns 200 (Epic 47 BUG-1).
 */
function buildApexGenerator(
  config: TownhouseConfig,
  apexSettlementKeys: ApexSettlementKeys
): ConnectorConfigGenerator {
  const apexEvmKey = apexSettlementKeys.evmPrivateKeyHex;
  const apexSolanaKey = apexSettlementKeys.solanaPrivateKeyBase58;
  const apexMinaKey = apexSettlementKeys.minaPrivateKeyBase58;

  const derived = resolveConfigNetworkProfile(
    config,
    apexEvmKey ?? DEFAULT_HS_CHAIN_PROVIDERS[0]?.keyId
  ).chainProviders as ChainProviderEntry[];

  // Fill the matching mnemonic-derived apex key per chainType.
  //
  // EVM: fill only when keyId is missing (an explicit operator EVM key wins).
  //
  // Solana / Mina (issue #215): the preset/network path in
  // resolveNetworkProfile seeds the SINGLE EVM `keyId` into the Solana AND Mina
  // provider entries too (network-profile.ts forwards opts.keyId to all three
  // builders). So a non-EVM entry can arrive here with keyId === apexEvmKey —
  // an EVM hex (`0x…`) wrongly planted on a chain that expects a base58/EK key.
  // Connector ≥3.10.4 enforces per-chain keyId format at registration and
  // rejects the EVM-hex Solana/Mina providers, breaking non-EVM pay-to-write.
  // Fix: for Solana/Mina, overwrite the keyId with the correct derived per-chain
  // key when it is MISSING or equals the EVM key (the seeded-wrong case) —
  // without clobbering a legitimately-distinct explicit operator keyId.
  const fillApexKey = (providers: ChainProviderEntry[]): ChainProviderEntry[] =>
    providers.map((p) => {
      if (p.chainType === 'evm') {
        if (p.keyId) return p;
        return apexEvmKey ? { ...p, keyId: apexEvmKey } : p;
      }
      const seededWithEvmKey = !!apexEvmKey && p.keyId === apexEvmKey;
      const needsFill = !p.keyId || seededWithEvmKey;
      const correctKey =
        p.chainType === 'solana'
          ? apexSolanaKey
          : p.chainType === 'mina'
            ? apexMinaKey
            : undefined;
      if (needsFill) {
        if (correctKey) {
          return { ...p, keyId: correctKey };
        }
        // No correct per-chain key available. If the entry was seeded with the
        // EVM key (the #215 bug), STRIP it rather than emit a wrong-format key
        // that the connector would reject — leave the provider keyId-less.
        if (seededWithEvmKey) {
          const { keyId: _seeded, ...rest } = p;
          return rest as ChainProviderEntry;
        }
      }
      return p;
    });

  const apexConfig: TownhouseConfig =
    derived.length > 0
      ? { ...config, chainProviders: fillApexKey(derived) }
      : { ...config, chainProviders: [...DEFAULT_HS_CHAIN_PROVIDERS] };

  validateChainProviderKeyIds(apexConfig.chainProviders ?? []);

  return new ConnectorConfigGenerator(apexConfig);
}

/**
 * Defense-in-depth (issue #215): validate that each chainProvider's keyId is in
 * the correct format for its chain BEFORE the config is written, and FAIL LOUDLY
 * rather than silently emitting a wrong key that the connector will later reject
 * at registration time (a far more confusing failure mode).
 *
 *   - EVM:    `0x` + 64 hex chars (32-byte private key).
 *   - Mina:   `EK` + base58check (the Mina private-key prefix).
 *   - Solana: base58 (a `0x…` hex value is the EVM-key-seeding bug from #215).
 *
 * keyId-less providers are tolerated here (the dev-fallback / no-key paths leave
 * them blank intentionally); only a PRESENT, wrong-format keyId throws.
 */
function validateChainProviderKeyIds(
  providers: readonly ChainProviderEntry[]
): void {
  const EVM_KEY = /^0x[0-9a-fA-F]{64}$/;
  // base58 alphabet (Bitcoin): no 0, O, I, l.
  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
  for (const p of providers) {
    const keyId = p.keyId;
    if (!keyId) continue;
    if (p.chainType === 'evm') {
      if (!EVM_KEY.test(keyId)) {
        throw new Error(
          `Invalid EVM keyId for chainProvider ${p.chainId ?? '(unknown)'}: ` +
            `expected 0x + 64 hex chars, got "${keyId.slice(0, 12)}…".`
        );
      }
    } else if (p.chainType === 'solana') {
      if (keyId.startsWith('0x') || !BASE58.test(keyId)) {
        throw new Error(
          `Invalid Solana keyId for chainProvider ${p.chainId ?? '(unknown)'}: ` +
            `expected a base58 key, got "${keyId.slice(0, 12)}…" ` +
            `(an EVM 0x-hex key here is the #215 seeding bug).`
        );
      }
    } else if (p.chainType === 'mina') {
      if (!keyId.startsWith('EK') || !BASE58.test(keyId)) {
        throw new Error(
          `Invalid Mina keyId for chainProvider ${p.chainId ?? '(unknown)'}: ` +
            `expected an EK… base58check key, got "${keyId.slice(0, 12)}…" ` +
            `(an EVM 0x-hex key here is the #215 seeding bug).`
        );
      }
    }
  }
}

/**
 * Add the DVM localDelivery handler + the self-nodeId `local` route to a parsed
 * connector config. Shared by both writers — the dvm has no BTP server, so the
 * apex locally-delivers packets addressed to its OWN nodeId to the dvm's HTTP
 * handler. Clients publish kind:5094 job requests to the apex address
 * (g.townhouse) and the connector forwards them here. No-op when no dvm is
 * provisioned, and does not shadow the more-specific g.townhouse.<node> peer
 * routes (longest-prefix match wins).
 *
 * @param dvmHandlerUrl - per-profile dvm container URL (HS vs. direct names differ).
 */
function applyDvmLocalDelivery(
  parsed: Record<string, unknown>,
  dvmHandlerUrl: string
): void {
  const apexNodeId =
    typeof parsed['nodeId'] === 'string'
      ? (parsed['nodeId'] as string)
      : 'g.townhouse';
  parsed['localDelivery'] = { enabled: true, handlerUrl: dvmHandlerUrl };
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
}

/** Write the rendered YAML to connector.yaml with 0600 perms (shared). */
function writeConnectorYaml(yamlPath: string, finalYaml: string): void {
  // Write atomically: writeFileSync is not atomic on all platforms, but since
  // we set mode on creation and then defensively chmod, this is consistent with
  // the pattern used by materializeComposeTemplate (Story 45.2).
  writeFileSync(yamlPath, finalYaml, { mode: 0o600, encoding: 'utf-8' });
  chmodSync(yamlPath, 0o600);
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
    apexSettlementKeys?: ApexSettlementKeys;
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

  const generator = buildApexGenerator(
    config,
    options.apexSettlementKeys ?? {}
  );
  const baseConfig = generator.generate([]); // apex-only, no peers

  // Managed mode: the connector spawns the anon daemon in-process. The SOCKS
  // proxy port binds locally at 127.0.0.1:9050 — use the local address so the
  // connector's TCP-readiness check waits for the right host, not the external
  // public ATOR proxy (proxy.ator.io:9050) which can never bind locally.
  const HS_LOCAL_SOCKS_PROXY = 'socks5h://127.0.0.1:9050';

  const hsRuntimeConfig: ConnectorRuntimeConfig = {
    ...baseConfig,
    transport: {
      mode: 'hs',
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

  applyDvmLocalDelivery(parsed, HS_DVM_HANDLER_URL);

  writeConnectorYaml(yamlPath, yamlStringify(parsed));

  return { yamlPath, created: true };
}

/**
 * Write (or reuse) `~/.townhouse/connector.yaml` for DIRECT (no-HS) mode.
 *
 * Renders the SAME base connector config as the HS writer (chainProviders,
 * apexSettlementKeys injection, DVM localDelivery) but:
 *   - the transport block is {type:'direct'} (mode:'direct' → see
 *     ConnectorConfigGenerator.buildConnectorTransportBlock), and
 *   - there is NO `anon` stanza (the connector does not spawn anon; the
 *     compose template exposes the BTP port :3000 to the host instead).
 *
 * Idempotency: a pre-existing file with a parsed transport `type: direct` and
 * NO `anon` block is reused verbatim. Pass `force: true` to overwrite.
 *
 * @param configDir - The townhouse home directory (e.g. `~/.townhouse/`).
 * @param config - Loaded `TownhouseConfig`.
 * @param options.force - When true, overwrite even if a direct file already exists.
 */
export function writeDirectConnectorConfig(
  configDir: string,
  config: TownhouseConfig,
  options: {
    force?: boolean;
    apexSettlementKeys?: ApexSettlementKeys;
  } = {}
): WriteDirectConnectorConfigResult {
  const yamlPath = join(configDir, 'connector.yaml');

  // Idempotency check: reuse an existing direct config (no anon block + a
  // direct transport type) so operator edits survive a re-run.
  if (!options.force && existsSync(yamlPath)) {
    try {
      const existing = parse(readFileSync(yamlPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const anon = existing['anon'] as Record<string, unknown> | undefined;
      const transport = existing['transport'] as
        | Record<string, unknown>
        | undefined;
      const isDirect = transport?.['type'] === 'direct';
      const noAnon = anon === undefined || anon['enabled'] !== true;
      if (isDirect && noAnon) {
        return { yamlPath, created: false };
      }
    } catch {
      // Unparseable existing file — fall through to overwrite.
    }
    // Existing file is HS or legacy — fall through to overwrite.
  }

  const generator = buildApexGenerator(
    config,
    options.apexSettlementKeys ?? {}
  );
  const baseConfig = generator.generate([]); // apex-only, no peers

  // Direct transport: no anon, no hidden service. The generator emits
  // {type:'direct'} for mode:'direct' (config-generator.ts:218-219).
  const directRuntimeConfig: ConnectorRuntimeConfig = {
    ...baseConfig,
    transport: {
      mode: 'direct',
    },
  };

  const baseYaml = generator.toYaml(directRuntimeConfig);
  const parsed = parse(baseYaml) as Record<string, unknown>;
  // Explicitly ensure NO anon stanza leaks in (defensive — the generator does
  // not emit one for direct mode, but a stale parse shouldn't either).
  delete parsed['anon'];

  applyDvmLocalDelivery(parsed, DIRECT_DVM_HANDLER_URL);

  writeConnectorYaml(yamlPath, yamlStringify(parsed));

  return { yamlPath, created: true };
}

/**
 * Detect whether `~/.townhouse/connector.yaml` already describes a HIDDEN-SERVICE
 * apex (`anon.enabled: true`) — the same marker the HS writer's idempotency
 * check keys on. Used by the back-compat guard so the direct-default `townhouse
 * up` never silently downgrades an operator who is already running an HS apex.
 *
 * Returns false when the file is absent, unparseable, or lacks `anon.enabled:
 * true` (i.e. a fresh install, a legacy non-HS file, or an existing direct
 * config) — all of which are safe to (re)bring-up as a direct apex.
 *
 * @param configDir - The townhouse home directory (e.g. `~/.townhouse/`).
 */
export function detectExistingHsConfig(configDir: string): boolean {
  const yamlPath = join(configDir, 'connector.yaml');
  if (!existsSync(yamlPath)) return false;
  try {
    const existing = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const anon = existing['anon'] as Record<string, unknown> | undefined;
    return anon?.['enabled'] === true;
  } catch {
    // Unparseable — not a recognizable HS config; safe to proceed as direct.
    return false;
  }
}
