/**
 * `--preset=demo` configuration (Story D2).
 *
 * Non-interactive preset for the TOON demo: 1 town, 1 mill (EVM<->SOL pair),
 * 1 dvm, ATOR transport ON, all fees zeroed (demo = free). Chain RPC URLs are
 * sourced from `deploy/akash/leases.json` if present, otherwise from local
 * devnet defaults documented in CLAUDE.md (Anvil 28545, Solana 28899).
 *
 * Future presets (test, prod) follow the same shape — see {@link PresetBuilder}.
 *
 * NOTE on schema reach: this preset writes mill chain endpoints into a
 * `chains` field on the mill node config. The orchestrator wiring that
 * forwards these into MILL_CONFIG_JSON is out of scope for D2 — for now the
 * field round-trips through the YAML so future stories (and the dashboard)
 * can read it without re-deriving it from leases.json.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { TownhouseConfig } from '../config/schema.js';
import { DEFAULT_CONNECTOR_IMAGE } from '../constants.js';

/**
 * Preset identifier — keep the union closed so we surface unknown presets at
 * the CLI boundary instead of silently falling through to defaults.
 */
export type PresetName = 'demo';

/**
 * Local-devnet fallback URLs (CLAUDE.md "Townhouse Dev Stack" 28xxx range).
 * Used when `deploy/akash/leases.json` is absent or unreadable.
 */
export const LOCAL_DEVNET_FALLBACK = {
  anvilUrl: 'http://localhost:28545',
  solanaUrl: 'http://localhost:28899',
} as const;

/**
 * Deterministic-but-clearly-unsafe password used for the demo wallet when the
 * caller passes `--preset=demo --yes` without `--password`. The string
 * embeds the warning so it shows up in any log scrape; production callers
 * MUST supply their own `--password` (AC-D2-6).
 */
export const DEMO_DETERMINISTIC_PASSWORD =
  'townhouse-demo-INSECURE-do-not-use-in-prod';

/**
 * Shape of `deploy/akash/leases.json` that this preset cares about. The full
 * file emitted by `scripts/akash-deploy.sh` has more fields; we only need
 * RPC + WS URLs here, so the type is intentionally narrow + tolerant.
 */
export interface AkashLeases {
  anvil?: {
    url?: string;
    host?: string;
    port?: number | string;
    ws_url?: string;
  };
  solana?: {
    url?: string;
    host?: string;
    port?: number | string;
    ws_host?: string;
    ws_port?: number | string;
    ws_url?: string;
  };
}

export interface ResolvedChainEndpoints {
  /** Source of truth for traceability — either an absolute leases.json path or 'local-fallback'. */
  source: string;
  evm: { rpcUrl: string; wsUrl?: string };
  solana: { rpcUrl: string; wsUrl?: string };
}

/**
 * Read `deploy/akash/leases.json` and extract chain endpoints, falling back
 * to local devnet URLs if the file is missing or any field is unusable.
 *
 * The fallback is per-chain: a leases.json that defines anvil but not solana
 * still gets the local Solana URL (and vice-versa). This keeps half-deployed
 * states usable.
 */
export function resolveChainEndpoints(
  leasesPath?: string
): ResolvedChainEndpoints {
  const localEvm = { rpcUrl: LOCAL_DEVNET_FALLBACK.anvilUrl };
  const localSol = { rpcUrl: LOCAL_DEVNET_FALLBACK.solanaUrl };

  if (!leasesPath || !existsSync(leasesPath)) {
    return { source: 'local-fallback', evm: localEvm, solana: localSol };
  }

  let parsed: AkashLeases;
  try {
    parsed = JSON.parse(readFileSync(leasesPath, 'utf-8')) as AkashLeases;
  } catch {
    // Malformed JSON — better to demo on local devnets than to error out at
    // wizard-bypass time. Caller never blocks on bad leases data.
    return { source: 'local-fallback', evm: localEvm, solana: localSol };
  }

  const evmUrl =
    typeof parsed.anvil?.url === 'string' ? parsed.anvil.url : undefined;
  const evmWs =
    typeof parsed.anvil?.ws_url === 'string' ? parsed.anvil.ws_url : undefined;
  const solUrl =
    typeof parsed.solana?.url === 'string' ? parsed.solana.url : undefined;
  const solWs =
    typeof parsed.solana?.ws_url === 'string'
      ? parsed.solana.ws_url
      : undefined;

  return {
    source: leasesPath,
    evm: evmUrl
      ? { rpcUrl: evmUrl, ...(evmWs ? { wsUrl: evmWs } : {}) }
      : localEvm,
    solana: solUrl
      ? { rpcUrl: solUrl, ...(solWs ? { wsUrl: solWs } : {}) }
      : localSol,
  };
}

export interface BuildDemoConfigOptions {
  /** Absolute path to the wallet file (typically `<configDir>/wallet.enc`). */
  walletPath: string;
  /**
   * Absolute path to `deploy/akash/leases.json`. Defaults to
   * `<repoRoot>/deploy/akash/leases.json` if not provided. Pass `null` to
   * force local-devnet fallback (used in tests and when the file is known
   * to not exist on the operator's machine).
   */
  leasesPath?: string | null;
}

/**
 * Default location of the Akash leases file. Resolved relative to CWD —
 * the demo CLI is run from anywhere, but the leases.json that matters lives
 * at `<repo>/deploy/akash/leases.json`.
 */
export function defaultLeasesPath(): string {
  return resolve(process.cwd(), 'deploy', 'akash', 'leases.json');
}

/**
 * Build the full TownhouseConfig for `--preset=demo`.
 *
 * AC-D2-5 invariants enforced here:
 * - 1 town, 1 mill, 1 dvm (all enabled)
 * - feePerEvent = 0, feeBasisPoints = 0, feePerJob = 0
 * - transport.mode = 'direct'
 * - mill.chains contains exactly one EVM<->SOL pair
 */
export function buildDemoConfig(
  options: BuildDemoConfigOptions
): TownhouseConfig {
  const leasesPath =
    options.leasesPath === null
      ? undefined
      : (options.leasesPath ?? defaultLeasesPath());

  const endpoints = resolveChainEndpoints(leasesPath);

  return {
    nodes: {
      town: {
        enabled: true,
        feePerEvent: 0,
      },
      mill: {
        enabled: true,
        feeBasisPoints: 0,
        // Demo pair: EVM (Anvil) <-> Solana. The orchestrator does not
        // currently consume mill.chains directly — it round-trips through
        // YAML so the dashboard / future stories can read it.
        chains: {
          evm: {
            rpcUrl: endpoints.evm.rpcUrl,
            ...(endpoints.evm.wsUrl ? { wsUrl: endpoints.evm.wsUrl } : {}),
          },
          solana: {
            rpcUrl: endpoints.solana.rpcUrl,
            ...(endpoints.solana.wsUrl
              ? { wsUrl: endpoints.solana.wsUrl }
              : {}),
          },
        },
        pairs: ['EVM<->SOL'],
      },
      dvm: {
        enabled: true,
        feePerJob: 0,
        // Arweave DVM (kind:5094) — frictionless demo pricing. Operators
        // running for real should raise this; entrypoint-dvm.ts treats the
        // value as msats per byte uploaded to Arweave.
        kindPricing: { '5094': 0 },
      },
    },
    wallet: {
      encrypted_path: options.walletPath,
    },
    connector: {
      image: DEFAULT_CONNECTOR_IMAGE,
      adminPort: 9401,
    },
    transport: {
      // 'direct' for the demo because `townhouse up` doesn't bring up a
      // SOCKS5 sidecar — hs mode would require one at `socks5://127.0.0.1:28050`
      // (provided by the dev-infra stack but not the operator CLI). Switch
      // to 'hs' once the sidecar story lands in townhouse `up`.
      mode: 'direct',
    },
    api: {
      port: 9400,
      host: '127.0.0.1',
    },
    logging: {
      level: 'info',
    },
    preset: {
      name: 'demo',
      // Source recorded so operators can see at-a-glance whether their demo
      // is hitting Akash or local devnets.
      chainEndpointSource: endpoints.source,
    },
  };
}

/**
 * Default config dir used by the demo preset when `--config-dir` is omitted.
 * Mirrors the value in cli.ts; duplicated here so tests can construct the
 * same path without importing from the CLI surface.
 */
export function defaultDemoConfigDir(): string {
  return join(homedir(), '.townhouse');
}
