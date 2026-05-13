/**
 * Townhouse configuration schema — TypeScript interfaces only.
 * Runtime validation lives in validator.ts.
 */

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
 * Connector chain-provider entry — surfaces what the connector needs to spin
 * up its settlement subsystem (AccountManager + ClaimReceiver). Without at
 * least one entry, `/admin/earnings.json` returns 503 and Townhouse's
 * earnings data plane breaks (Epic 47 BUG-1).
 *
 * Dev-Anvil deterministic placeholders are exposed via
 * `DEFAULT_HS_CHAIN_PROVIDERS` in `defaults.ts`; operators running on real
 * chains override this in their `config.yaml`.
 */
export interface ChainProviderEntry {
  /** Currently only 'evm' supported. */
  chainType: 'evm';
  /** Canonical chain id, e.g. 'evm:base:31337' (dev-Anvil) or 'evm:base:8453' (mainnet). */
  chainId: string;
  /** Chain RPC endpoint. May be a dead address in offline/demo mode. */
  rpcUrl: string;
  /** PaymentChannel registry contract. */
  registryAddress: string;
  /** Settlement token (USDC, etc.) contract. */
  tokenAddress: string;
  /** Hex private key the connector signs settlement claims with. */
  keyId: string;
}

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
   * Connector chain providers — required for the connector's settlement
   * subsystem (AccountManager + ClaimReceiver) to initialize. When unset on
   * `townhouse hs up`, `hs-config-writer.ts` injects
   * `DEFAULT_HS_CHAIN_PROVIDERS` so the earnings route returns 200 out of
   * the box (Epic 47 BUG-1 product fix).
   */
  chainProviders?: ChainProviderEntry[];
  /** Present only when the config was generated by `init --preset=<name>`. */
  preset?: PresetMetadata;
}
