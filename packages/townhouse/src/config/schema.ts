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

export interface MillNodeConfig {
  enabled: boolean;
  /** Swap fee basis points (1 = 0.01%) */
  feeBasisPoints?: number;
  /** Docker image override */
  image?: string;
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

export interface TransportConfig {
  /** Transport mode: 'ator' for Tor-based, 'direct' for clearnet */
  mode: 'ator' | 'direct';
  /** SOCKS5 proxy address when using ator transport */
  socksProxy?: string;
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

export interface TownhouseConfig {
  nodes: NodesConfig;
  wallet: WalletConfig;
  connector: ConnectorConfig;
  transport: TransportConfig;
  api: ApiConfig;
  logging: LoggingConfig;
}
