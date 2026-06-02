/**
 * Townhouse API — type definitions.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { DockerOrchestrator } from '../docker/orchestrator.js';
import type { WalletManager } from '../wallet/index.js';
import type { ConnectorAdminClient } from '../connector/index.js';
import type { TownhouseConfig, ChainProviderEntry } from '../config/schema.js';
import type { TransportProbe } from '../connector/transport-probe.js';
// DvmHealthResponse / MillHealthResponse are intentionally inlined here (rather
// than imported from @toon-protocol/sdk / @toon-protocol/mill) to keep townhouse
// off those packages' dependency graphs — the package is a thin host
// orchestrator and pulling sdk/mill just for a response shape blows up the
// install size and breaks the architectural boundary asserted by
// package-structure.test.ts. (mill/sdk/dvm ship as Docker images, not npm
// runtime deps.) Keep DvmHealthResponse in sync with packages/sdk/src/dvm-health.ts
// and MillHealthResponse in sync with packages/mill/src/mill.ts.

/** Per-kind job count for jobsRecent.byKind */
export interface DvmJobsByKindEntry {
  kind: number;
  count: number;
}

/** Per-status job counts for the sliding window */
export interface DvmJobsByStatus {
  processing: number;
  success: number;
  error: number;
  partial: number;
}

/** Windowed recent-jobs telemetry (default window: 5 min) */
export interface DvmJobsRecent {
  total: number;
  byKind: DvmJobsByKindEntry[];
  byStatus: DvmJobsByStatus;
}

/** Response shape for GET /health on the DVM BLS server (port 3400). */
export interface DvmHealthResponse {
  status: 'starting' | 'ok' | 'stopping' | 'stopped' | 'error';
  version: string;
  nodePubkey: string;
  uptimeSec: number;
  /** Registered handler event kinds (e.g. [5094]). */
  handlerKinds: number[];
  /** Per-kind pricing in string-encoded bigint (e.g. { "5094": "10" }). */
  kindPricing: Record<string, string>;
  basePricePerByte: string;
  jobsRecent: DvmJobsRecent;
}

/** Chains a Mill node can settle on. Inlined from packages/mill/src/wallet.ts. */
type MillChainKind = 'evm' | 'mina' | 'solana';

/** A configured swap pair, inlined from packages/core/src/types.ts (SwapPair). */
interface MillSwapPair {
  from: { assetCode: string; assetScale: number; chain: string };
  to: { assetCode: string; assetScale: number; chain: string };
  rate: string;
  minAmount?: string;
  maxAmount?: string;
}

/**
 * Response shape for GET /health on the Mill BLS server. Inlined from
 * packages/mill/src/mill.ts (MillHealthResponse) — keep in sync.
 */
export interface MillHealthResponse {
  status: 'ok' | 'starting' | 'stopping' | 'stopped';
  version: string;
  nodePubkey: string;
  swapPairsCount: number;
  chains: readonly MillChainKind[];
  uptimeSec: number;
  inventory: Record<string, string>;
  /** Configured swap pairs — operator-config, no secrets. */
  swapPairs: MillSwapPair[];
  /** Per-asset available reserves, parallel to `inventory` (which is total). */
  inventoryAvailable: Record<string, string>;
}

/** Node types supported by Townhouse */
export type NodeType = 'town' | 'mill' | 'dvm';

/** Runtime state of a node container */
export type NodeState = 'running' | 'stopped' | 'error' | 'not-created';

/** Response shape for GET /nodes */
export interface NodeInfo {
  /**
   * Unique instance identifier — equals `type` for single-instance deployments.
   * Required in responses from this API; undefined in legacy test fixtures.
   */
  id: string;
  type: NodeType;
  enabled: boolean;
  state: NodeState;
  uptimeSeconds: number | null;
  image: string;
}

/** Detailed response shape for GET /nodes/:type */
export interface NodeDetail extends NodeInfo {
  config: {
    feePerEvent?: number;
    feeBasisPoints?: number;
    feePerJob?: number;
    kindPricing?: Record<string, number>;
    enabled: boolean;
  };
  metrics: MetricsPayload | null;
}

/** Metrics payload from connector admin — narrowed per connector-team agreement 2026-04-21 */
export interface MetricsPayload {
  packetsForwarded: number;
  packetsRejected: number;
  bytesSent: number;
  attribution: 'aggregate' | 'per-peer';
  available: boolean;
}

/** Nostr event shape forwarded in relayEvents messages */
export interface NostrEventPayload {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  sig: string;
  created_at: number;
}

/** WebSocket message shapes */
export interface WsMetricsMessage {
  type: 'metrics';
  payload: MetricsPayload;
  ts: number;
}

export interface WsNodeStateMessage {
  type: 'nodeState';
  payload: NodeStatePayload;
  ts: number;
}

export interface WsHeartbeatMessage {
  type: 'heartbeat';
  ts: number;
}

export interface WsBatchMessage {
  type: 'batch';
  messages: WsMessage[];
  ts: number;
}

/** Forwarded Nostr event from a Town relay subscription */
export interface WsRelayEventsMessage {
  type: 'relayEvents';
  nodeId: string;
  payload: NostrEventPayload;
  ts: number;
}

/** Connector restart notifications (emitted around fee-config PATCH) */
export interface WsConnectorRestartingMessage {
  type: 'connectorRestarting';
  ts: number;
}

export interface WsConnectorRestartedMessage {
  type: 'connectorRestarted';
  ts: number;
}

export interface NodeStatePayload {
  name: string;
  state: string;
}

/** Server notification when the upstream relay WebSocket for a nodeId disconnects */
export interface WsRelayEventsStatusMessage {
  type: 'relayEventsStatus';
  nodeId: string;
  connected: boolean;
  ts: number;
}

export type WsMessage =
  | WsMetricsMessage
  | WsNodeStateMessage
  | WsHeartbeatMessage
  | WsBatchMessage
  | WsRelayEventsMessage
  | WsConnectorRestartingMessage
  | WsConnectorRestartedMessage
  | WsRelayEventsStatusMessage;

/** Response shape for GET /nodes/:type/bandwidth */
export interface BandwidthPayload {
  bytesIn: number;
  bytesOut: number;
  sampleAt: number;
}

/** Packet log time-series bucket */
export interface TimeseriesBucket {
  ts: number;
  count: number;
}

/** Response shape for GET /nodes/:type/packets/timeseries */
export interface PacketTimeseriesPayload {
  buckets: TimeseriesBucket[];
}

/** Minimal common health shape; superset emitted by Town containers. */
export interface TownHealthPayload {
  status: 'ok' | 'starting' | 'stopping' | 'stopped' | 'error';
  version?: string;
  uptimeSec?: number;
  nodePubkey?: string;
}

/** Union of all node health response shapes. */
export type NodeHealthPayload =
  | MillHealthResponse
  | TownHealthPayload
  | DvmHealthResponse;

/** Per-kind job activity bucket for GET /nodes/:nodeId/jobs/recent */
export interface JobsByKindEntry {
  kind: number;
  count: number;
  volume: string;
}

/** Response shape for GET /nodes/:nodeId/jobs/recent */
export interface JobsRecentPayload {
  count: number;
  volume: string;
  byKind: JobsByKindEntry[];
  byStatus: {
    processing: number;
    success: number;
    error: number;
    partial: number;
  };
}

/** Per-pair swap activity bucket */
export interface SwapByPairEntry {
  pair: string;
  count: number;
  volume: string;
}

/** Response shape for GET /nodes/mill/swaps/recent */
export interface MillSwapsRecentPayload {
  count: number;
  volume: string;
  byPair: SwapByPairEntry[];
}

/** Per-chain deposit address entry */
export interface DepositAddressEntry {
  family: 'evm' | 'solana' | 'mina';
  address: string;
}

/** Response shape for GET /nodes/:type/deposit-addresses */
export interface DepositAddressesPayload {
  chains: DepositAddressEntry[];
}

// ── Wallet API types (Story 21.13) ────────────────────────────────────────────

/** Per-chain balance entry returned by GET /api/wallet/balances */
export interface WalletBalanceEntry {
  nodeType: 'town' | 'mill' | 'dvm';
  family: 'evm' | 'solana' | 'mina';
  token: 'ETH' | 'USDC' | 'SOL' | 'MINA';
  address: string;
  /** Decimal string in raw units (wei, lamports, etc.) */
  balance: string;
  /** Decimal places — 18 for ETH, 6 for USDC, 9 for SOL, 9 for MINA */
  scale: number;
  available: boolean;
  /** Populated when available === false */
  reason?: string;
}

/** Response shape for GET /api/wallet/balances */
export interface WalletBalancesPayload {
  entries: WalletBalanceEntry[];
  ts: number;
}

/** Request body for POST /api/wallet/withdraw.
 *  `chainFamily` lists all values the route accepts at the wire level — the
 *  handler returns 501 for solana/mina with a structured payload pointing the
 *  caller at the deposit-address copy flow. */
export interface WithdrawRequest {
  nodeType: 'town' | 'mill' | 'dvm';
  chainFamily: 'evm' | 'solana' | 'mina';
  token: 'native' | 'USDC';
  recipient: string;
  /** Decimal string in raw units */
  amount: string;
  /** When true: returns gas estimate without broadcasting */
  dryRun?: boolean;
}

/** Successful broadcast response (dryRun !== true). */
export interface WithdrawSuccessResponse {
  txHash: `0x${string}`;
  chainId: number;
}

/** Successful dryRun response (no broadcast performed). */
export interface WithdrawDryRunResponse {
  estimatedGas: string;
  estimatedFee: string;
}

/** Discriminated union — callers narrow by presence of `txHash`. */
export type WithdrawResponse = WithdrawSuccessResponse | WithdrawDryRunResponse;

/** Request body for POST /api/wallet/reveal */
export interface RevealRequest {
  password: string;
}

/** Response shape for POST /api/wallet/reveal */
export type RevealResponse =
  | { mnemonic: string }
  | {
      error: 'invalid_password' | 'wallet_not_initialized' | 'wallet_corrupted';
      message?: string;
    };

/** Response shape for GET /api/wallet/transaction/:txHash */
export interface TransactionReceiptPayload {
  status: 'pending' | 'success' | 'reverted';
  blockNumber?: number;
  txHash: string;
}

// ── Wizard API types (Story 21.14) ────────────────────────────────────────────

/** Response shape for GET /api/wizard/state */
export interface WizardStatePayload {
  config_exists: boolean;
  wallet_exists: boolean;
  containers_running: boolean;
  mode: 'wizard' | 'normal';
  ts: number;
}

/** Request body for POST /api/wizard/init.
 *  `mnemonic` is required in BOTH modes — `mnemonic_mode` is purely a UX hint
 *  for the SPA, the server is stateless WRT the mnemonic and validates it on
 *  every init regardless of mode (see story 21.14 Dev Notes). */
export interface WizardInitRequest {
  password: string;
  password_confirm: string;
  mnemonic_mode: 'generate' | 'import';
  mnemonic: string;
  backup_ack: boolean;
  nodes: {
    town: { enabled: boolean; feePerEvent?: number };
    mill: { enabled: boolean; feeBasisPoints?: number };
    dvm: { enabled: boolean; feePerJob?: number };
  };
  transport: { mode: 'direct' | 'ator' };
  /**
   * Optional settlement chains (connector chainProviders) to configure during
   * first-run setup. Omitted/empty → the connector uses the dev-Anvil default.
   * Validated deeply when the resulting config is saved.
   */
  chainProviders?: ChainProviderEntry[];
}

/** Progress messages streamed over WS /api/wizard/progress */
export type WizardProgressMessage =
  | {
      type: 'pull_progress';
      image: string;
      status: string;
      progress?: string;
      ts: number;
    }
  | { type: 'container_starting'; name: string; ts: number }
  | { type: 'container_healthy'; name: string; ts: number }
  | { type: 'container_failed'; name: string; reason: string; ts: number }
  | { type: 'launch_complete'; ts: number }
  | { type: 'error'; message: string; ts: number };

// ── Transport API types (Story 21.15) ─────────────────────────────────────────

/** Response shape for GET /api/transport */
export interface TransportStatusPayload {
  mode: 'direct' | 'ator';
  /** Present only when mode === 'ator' */
  socksProxy?: string;
  reachable: boolean;
  latencyProxyMs: number | null;
  latencyDirectMs: number | null;
  /** ms epoch; 0 if probe never ran */
  lastProbedAt: number;
  probeError: string | null;
  /** Server timestamp at response build time */
  ts: number;
}

/** Request body for PATCH /api/transport */
export interface TransportPatchRequest {
  mode: 'direct' | 'ator';
  socksProxy?: string;
}

/** Response body for PATCH /api/transport */
export interface TransportPatchResponse {
  mode: 'direct' | 'ator';
  socksProxy?: string;
  restartTriggered: boolean;
  /** ms epoch of connector restart; present when restartTriggered === true */
  restartedAt?: number;
}

// ── API server types ───────────────────────────────────────────────────────────

/** API server returned by createApiServer */
export interface ApiServer {
  app: FastifyInstance;
  close: () => Promise<void>;
}

/** Dependencies required to create the API server */
export interface ApiDeps {
  configPath: string;
  config: TownhouseConfig;
  orchestrator: DockerOrchestrator;
  wallet: WalletManager;
  connectorAdmin: ConnectorAdminClient;
  /**
   * Probe instance. Required: callers (createApiServer, createWizardApiServer,
   * cli, dev API server) construct it from the config and pass it explicitly.
   */
  transportProbe: TransportProbe;
  logger?: FastifyBaseLogger;
}
