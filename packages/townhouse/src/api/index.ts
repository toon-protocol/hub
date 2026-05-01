/**
 * Townhouse API — exports.
 */

export { createApiServer } from './server.js';
export type {
  ApiServer,
  ApiDeps,
  NodeType,
  NodeState,
  NodeInfo,
  NodeDetail,
  MetricsPayload,
  WsMessage,
  WsMetricsMessage,
  WsNodeStateMessage,
  WsHeartbeatMessage,
  WsBatchMessage,
  WsRelayEventsMessage,
  WsConnectorRestartingMessage,
  WsConnectorRestartedMessage,
  NostrEventPayload,
  BandwidthPayload,
  PacketTimeseriesPayload,
  TimeseriesBucket,
  NodeHealthPayload,
  TownHealthPayload,
  DvmHealthResponse,
  MillHealthResponse,
  MillSwapsRecentPayload,
  JobsRecentPayload,
  JobsByKindEntry,
  DepositAddressesPayload,
  DepositAddressEntry,
  SwapByPairEntry,
  WalletBalanceEntry,
  WalletBalancesPayload,
  WithdrawRequest,
  WithdrawResponse,
  WithdrawSuccessResponse,
  WithdrawDryRunResponse,
  RevealRequest,
  RevealResponse,
  TransactionReceiptPayload,
} from './types.js';

export {
  registerNodeRoutes,
  registerWalletRoutes,
  registerMetricsWsRoutes,
} from './routes/index.js';
export { buildCorsOptions } from './cors.js';

// Re-export NodeKeyInfo for API consumers
export type { NodeKeyInfo } from '../wallet/types.js';
