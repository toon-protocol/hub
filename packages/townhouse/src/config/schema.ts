/**
 * Townhouse configuration schema — TypeScript interfaces only.
 * Runtime validation lives in validator.ts.
 */

import type { NetworkMode } from '@toon-protocol/core';

export type { NetworkMode };

export interface TownNodeConfig {
  enabled: boolean;
  /** Nostr relay fee in millisatoshis per event */
  feePerEvent?: number;
  /** Docker image override */
  image?: string;
}

export interface ChainEndpoint {
  rpcUrl: string;
  wsUrl?: string;
}

export interface MillChainsConfig {
  evm?: ChainEndpoint;
  solana?: ChainEndpoint;
  mina?: ChainEndpoint;
}

export interface MillNodeConfig {
  enabled: boolean;
  /** Swap fee basis points (1 = 0.01%) */
  feeBasisPoints?: number;
  /** Docker image override */
  image?: string;
  /**
   * Chain RPC endpoints the mill should swap against (D2). The orchestrator
   * does not currently forward this directly into MILL_CONFIG_JSON — it
   * round-trips through YAML so the dashboard and future stories can read it.
   */
  chains?: MillChainsConfig;
  /** Enabled swap pairs, e.g. ['EVM<->SOL']. Informational; D2-introduced. */
  pairs?: string[];
}

export interface DvmNodeConfig {
  enabled: boolean;
  /** DVM job fee in millisatoshis */
  feePerJob?: number;
  /** Per-kind pricing in millisatoshis (key = stringified kind number) */
  kindPricing?: Record<string, number>;
  /** Docker image override */
  image?: string;
}

export interface NodesConfig {
  town: TownNodeConfig;
  mill: MillNodeConfig;
  dvm: DvmNodeConfig;
}

export interface WalletConfig {
  /** Path to encrypted wallet file (no plaintext mnemonic in config) */
  encrypted_path: string;
}

export interface ConnectorConfig {
  /** Docker image for the shared ILP connector */
  image: string;
  /** Admin API port */
  adminPort: number;
}

/**
 * Connector chain-provider entry — what the connector needs to spin up its
 * settlement subsystem (AccountManager + ClaimReceiver) for one chain. Without
 * at least one entry, `/admin/earnings.json` returns 503 and Townhouse's
 * earnings data plane breaks (Epic 47 BUG-1).
 *
 * This is a discriminated union on `chainType` that mirrors the connector's
 * `ProviderConfig` contract (EVM | Solana | Mina), so entries pass straight
 * through `ConnectorConfigGenerator` to the connector. The connector already
 * implements payment-channel providers for all three chains.
 *
 * Dev-Anvil deterministic placeholders are exposed via
 * `DEFAULT_HS_CHAIN_PROVIDERS` in `defaults.ts`; operators running on real
 * chains override this in their `config.yaml`.
 */

/** Supported settlement chain families. */
export type ChainType = 'evm' | 'solana' | 'mina';

/** EVM settlement chain (Base, Arbitrum, Anvil dev, …). */
export interface EvmChainProvider {
  chainType: 'evm';
  /** Canonical chain id, e.g. 'evm:base:31337' (dev-Anvil) or 'evm:base:8453' (mainnet). */
  chainId: string;
  /** JSON-RPC endpoint. May be a dead address in offline/demo mode. */
  rpcUrl: string;
  /** PaymentChannel registry contract. */
  registryAddress: string;
  /** Settlement token (USDC, etc.) contract. */
  tokenAddress: string;
  /**
   * Hex private key / key id the connector signs settlement claims with.
   * Optional: when omitted, `townhouse hs up` fills it with the operator's
   * mnemonic-derived apex settlement key (acct index 3). Set it only to use an
   * external/hardware key.
   */
  keyId?: string;
}

/** Solana settlement chain. */
export interface SolanaChainProvider {
  chainType: 'solana';
  /** Canonical chain id, e.g. 'solana:devnet' or 'solana:mainnet'. */
  chainId: string;
  /** Cluster RPC endpoint (HTTP). */
  rpcUrl: string;
  /** WebSocket endpoint for account subscriptions (derived from rpcUrl if absent). */
  wsUrl?: string;
  /** On-chain payment-channel program id (base58). */
  programId: string;
  /** Settlement token mint (base58). */
  tokenMint?: string;
  /**
   * Key id the connector signs settlement claims with. Optional — when omitted,
   * `townhouse hs up` fills it with the operator's mnemonic-derived apex key.
   */
  keyId?: string;
}

/** Mina settlement chain. */
export interface MinaChainProvider {
  chainType: 'mina';
  /** Canonical chain id, e.g. 'mina:devnet' or 'mina:mainnet'. */
  chainId: string;
  /** Mina GraphQL endpoint. */
  graphqlUrl: string;
  /** zkApp address for the payment-channel contract (base58). */
  zkAppAddress: string;
  /** Key id the connector signs settlement claims with. */
  keyId?: string;
}

export type ChainProviderEntry =
  | EvmChainProvider
  | SolanaChainProvider
  | MinaChainProvider;

/**
 * Hidden-service publication config (Story 35.5 of the connector repo).
 *
 * When set, the connector boots `@anyone-protocol/anyone-client` in-process,
 * spawns the `anon` binary, publishes a v3 hidden service, and advertises
 * its `wss://<addr>.anyone/btp` URL to peers. The keypair lives at `dir`
 * inside the connector container and persists across restarts when that
 * path is on a mounted volume.
 *
 * Operator surface (this type) is intentionally narrow; the connector's
 * own config has more knobs (binaryPath, configFilePath) that we omit
 * here until a real use case demands them.
 */
export interface HiddenServiceConfig {
  /** Path inside the connector container for hs_ed25519_secret_key etc. */
  dir: string;
  /** Hidden service port — peers dial <addr>.anyone:<port>. */
  port: number;
  /**
   * Optional override of the externalUrl the connector advertises. Default
   * is `"auto"` — the connector reads `${dir}/hostname` at startup and
   * builds `wss://<hostname>.anyone/btp` itself.
   */
  externalUrl?: string;
  /** Optional override of the SDK's start-up readiness deadline (ms). */
  startupTimeoutMs?: number;
  /** Optional override of the SDK's shutdown deadline (ms). */
  stopTimeoutMs?: number;
}

export interface TransportConfig {
  /** Transport mode: 'ator' for Tor-based, 'direct' for clearnet */
  mode: 'ator' | 'direct';
  /** SOCKS5 proxy address when using ator transport */
  socksProxy?: string;
  /**
   * Externally reachable BTP URL. Required when mode='ator' AND
   * hiddenService is unset (operator runs their own anon binary external
   * to the connector and is responsible for the URL). Ignored for
   * mode='direct'. When hiddenService is set and externalUrl is unset,
   * the generator emits the literal `"auto"` so the connector resolves
   * the .anyone hostname from disk at startup.
   */
  externalUrl?: string;
  /**
   * Optional inbound hidden-service publication. When set, the connector
   * manages its own anon binary and publishes a .anyone hidden service.
   */
  hiddenService?: HiddenServiceConfig;
  /**
   * Town relay hidden service. When set, the orchestrator starts a second
   * ator sidecar (parallel to any connector HS sidecar) that forwards
   * inbound HS traffic to the town container's Nostr WebSocket port (7100),
   * and the town container is configured to advertise the .anyone URL.
   * Reuses HiddenServiceConfig — same shape as connector HS config.
   */
  relayHiddenService?: HiddenServiceConfig;
}

export interface ApiConfig {
  /** Dashboard/API port */
  port: number;
  /** Bind address */
  host: string;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
}

export interface PresetMetadata {
  /** Preset that produced this config (D2). */
  name: 'demo';
  /** Where the chain endpoints came from — leases.json path or 'local-fallback'. */
  chainEndpointSource: string;
}

export interface TownhouseConfig {
  nodes: NodesConfig;
  wallet: WalletConfig;
  connector: ConnectorConfig;
  transport: TransportConfig;
  api: ApiConfig;
  logging: LoggingConfig;
  /**
   * Network mode selecting the chain tier for BOTH the apex connector and the
   * child node containers (EVM = Base primary + Arbitrum; Solana; Mina):
   * - `mainnet` (default when unset) — public production chains
   * - `testnet` — public Sepolia / Solana testnet / Mina devnet
   * - `devnet` — public Sepolia / Solana+Mina devnets (no local chain)
   * - `custom` — operator supplies `chainProviders` directly, OR just RPC URLs
   *   via `endpoints` (below) to point at the project's dev chains
   *
   * Resolved via `resolveNetworkProfile()` (@toon-protocol/core). An explicit
   * non-empty `chainProviders` always overrides the derived providers.
   */
  network?: NetworkMode;
  /**
   * Operator-supplied RPC URLs for `network: 'custom'` (`--evm-url`/`--sol-url`
   * or EVM_URL/SOL_URL env). Points the apex + nodes at the project's dev chains
   * hosted anywhere — e.g. the anvil + solana that scripts/akash-deploy.sh
   * deploys to Akash (ingress hostnames rotate per redeploy, so the operator
   * passes the current URLs). EVM is the chain-id 31338 Anvil
   * (settlement-complete); Solana is RPC + Mock-USDC only (relay-only).
   */
  endpoints?: { evmUrl?: string; solUrl?: string };
  /**
   * Connector chain providers — required for the connector's settlement
   * subsystem (AccountManager + ClaimReceiver) to initialize. When unset on
   * `townhouse hs up`, `hs-config-writer.ts` derives them from `network` (or
   * injects `DEFAULT_HS_CHAIN_PROVIDERS` as a last resort) so the earnings
   * route returns 200 out of the box (Epic 47 BUG-1 product fix).
   */
  chainProviders?: ChainProviderEntry[];
  /** Present only when the config was generated by `init --preset=<name>`. */
  preset?: PresetMetadata;
}
